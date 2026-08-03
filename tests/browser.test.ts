import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PlaywrightBrowser,
  type BrowserCommandInvocation,
  type BrowserCommandOutput,
} from '../skills/chatgpt-pro-collab/scripts/browser.ts';
import { collabPaths, ensureCollabDirectories } from '../skills/chatgpt-pro-collab/scripts/session.ts';

const protocol = 'chatgpt-pro-collab/v1';

describe('BEH-001, BEH-002, and BEH-006 browser isolation', () => {
  it('uses the fixed CLI prefix, task output directory, and shared seed without persistence', async () => {
    const fixture = await browserFixture([
      output('### Browser `session-a` opened with pid 4123.'),
      output('state loaded'),
      output('navigated'),
      pageResult({ protocol, kind: 'start', url: 'https://chatgpt.com/', contextMarker: 'context-a' }),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    const result = await fixture.browser.startTask('task-a', 'session-a', fixture.paths.seedState);

    expect(result).toEqual({ pid: 4123, url: 'https://chatgpt.com/', contextMarker: 'context-a', persistent: false });
    expect(fixture.invocations[0]?.arguments).toEqual([
      '-y',
      '@playwright/cli@0.1.17',
      '-s=session-a',
      '--raw',
      'open',
      'about:blank',
      '--browser=chrome',
      '--headed',
    ]);
    expect(fixture.invocations[0]?.environment.PLAYWRIGHT_MCP_OUTPUT_DIR).toBe(
      join(fixture.paths.sessionsDirectory, 'task-a', 'playwright'),
    );
    expect(fixture.invocations[0]?.environment.PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS).toBe('true');
    expect(
      fixture.invocations.flatMap((invocation) => {
        return invocation.arguments;
      }),
    ).not.toContain('--persistent');
    expect(fixture.invocations[1]?.arguments).toContain(fixture.paths.seedState);
    expect(
      fixture.invocations.flatMap((invocation) => {
        return invocation.arguments;
      }),
    ).not.toContain('state-save');
    const startSource = await lastScript(fixture.invocations);
    expect(startSource).toContain('await page.evaluate((marker) =>');
    expect(startSource).toContain('hostname: location.hostname');
    expect(startSource).not.toContain('new URL(page.url())');
    expect(startSource).not.toContain("\n    sessionStorage.setItem('chatgpt-pro-collab-context-id', contextMarker);");
    expectPageFunctionSyntax(startSource);
  });

  it('preserves page-script errors and closes a failed start session', async () => {
    const fixture = await browserFixture([
      output('### Browser `session-a` opened with pid 4123.'),
      output('state loaded'),
      output('navigated'),
      output('### Error\nReferenceError: sessionStorage is not defined'),
      output("Browser 'session-a' closed"),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    await expect(fixture.browser.startTask('task-a', 'session-a', fixture.paths.seedState)).rejects.toThrow(
      /sessionStorage is not defined/,
    );
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });
});

describe('BEH-003, BEH-004, and BEH-009 page contracts', () => {
  it('uploads explicit attachments in order before returning a confirmed conversation', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      pageResult({ protocol, kind: 'upload-ready' }),
      output('first uploaded'),
      pageResult({ protocol, kind: 'upload-ready' }),
      output('second uploaded'),
      pageResult({
        protocol,
        kind: 'send',
        status: 'submitted',
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
      }),
    ]);

    const result = await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', ['/tmp/a', '/tmp/b']);

    expect(result).toEqual({
      status: 'submitted',
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
    });
    const uploads = fixture.invocations
      .filter((invocation) => {
        return invocation.arguments.includes('upload');
      })
      .map((invocation) => {
        return invocation.arguments.at(-1);
      });
    expect(uploads).toEqual(['/tmp/a', '/tmp/b']);
    const sendSource = await lastScript(fixture.invocations);
    expect(sendSource).toContain("page.locator('#prompt-textarea')");
    expect(sendSource).toContain('page.locator(\'[data-testid="send-button"]\')');
    expect(sendSource).toContain('exact prompt');
    expect(sendSource).toContain('const expectedConversationId = null');
    expect(sendSource).toContain("!match[1].startsWith('WEB:')");
    expect(sendSource).not.toContain('new URL(page.url())');
    expectPageFunctionSyntax(sendSource);
  });

  it('reloads a changed attachment draft after a pre-submit upload failure', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      pageResult({ protocol, kind: 'upload-ready' }),
      output('first uploaded'),
      output('### Error\nError: second chooser failed'),
      pageResult({ protocol, kind: 'draft-cleared' }),
    ]);

    await expect(
      fixture.browser.send('task-a', 'session-a', 'conversation-a', 'exact prompt', ['/tmp/a', '/tmp/b']),
    ).resolves.toEqual({ status: 'not-submitted', error: expect.stringContaining('second chooser failed') });
    const cleanupInvocation = fixture.invocations.at(-1);
    expect(cleanupInvocation?.arguments).toContain('run-code');
    const preflightSource = await scriptForInvocation(fixture.invocations[0]);
    expect(preflightSource).toContain('const expectedConversationId = "conversation-a"');
    expect(preflightSource).toContain('conversation identity does not match the send target');
    const cleanupSource = await scriptForInvocation(cleanupInvocation);
    expect(cleanupSource).toContain("page.reload({ waitUntil: 'domcontentloaded' })");
    expect(cleanupSource).toContain('const expectedConversationId = "conversation-a"');
    expectPageFunctionSyntax(cleanupSource);
  });

  it('captures Copy response inside the page and never invokes an OS clipboard command', async () => {
    const fixture = await browserFixture([
      pageResult({
        protocol,
        kind: 'wait',
        response: 'full response\n```ts\nconst value = 1;\n```',
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
      }),
    ]);

    const result = await fixture.browser.waitForResponse('task-a', 'session-a', 'conversation-a');
    const source = await lastScript(fixture.invocations);

    expect(result.response).toBe('full response\n```ts\nconst value = 1;\n```');
    expect(source).toContain('[data-testid="copy-turn-action-button"]');
    expect(source).toContain('navigator.clipboard');
    expect(source).toContain("name: 'Stop answering', exact: true");
    expect(source).toContain('stableCompletedPolls < 6');
    expect(source).toContain('copy.click({ force: true })');
    expect(source).toContain('const capturedUrl = await page.evaluate');
    expect(source).toContain('capturedMatch[1] !== expectedConversationId');
    expect(source).not.toContain('pbpaste');
    expect(source).not.toContain('osascript');
    expect(source).not.toContain('new URL(page.url())');
    expectPageFunctionSyntax(source);
  });

  it('uses only the exact target options button and Archive menu item', async () => {
    const fixture = await browserFixture([pageResult({ protocol, kind: 'archive', conversationId: 'conversation-a' })]);

    await expect(fixture.browser.archive('task-a', 'session-a', 'conversation-a')).resolves.toEqual({
      conversationId: 'conversation-a',
    });
    const source = await lastScript(fixture.invocations);
    expect(source).toContain('[data-testid="conversation-options-button"]');
    expect(source).toContain("name: 'Archive', exact: true");
    expect(source).not.toContain('Open conversation options');
    expect(source).not.toContain('new URL(page.url())');
    expectPageFunctionSyntax(source);
  });
});

/**
 * Creates a browser with a deterministic FIFO command runner.
 *
 * @param outputs Command results consumed in invocation order.
 * @returns Browser, resolved paths, and captured invocations.
 * @throws {Error} If the temporary fixture cannot be created.
 */
async function browserFixture(outputs: readonly BrowserCommandOutput[]) {
  const root = await mkdtemp(join(tmpdir(), 'collab-browser-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  const invocations: BrowserCommandInvocation[] = [];
  const queue = [...outputs];
  const browser = new PlaywrightBrowser(paths, root, (invocation) => {
    invocations.push(invocation);
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('unexpected browser invocation'));
    }
    return Promise.resolve(next);
  });
  return { browser, invocations, paths };
}

/**
 * Wraps deterministic stdout as one successful command result.
 *
 * @param stdout Simulated fixed CLI output.
 * @returns A successful command result.
 * @throws {Error} This pure helper does not throw.
 */
function output(stdout: string): BrowserCommandOutput {
  return { stdout, stderr: '' };
}

/**
 * Encodes a page function's JSON string the way fixed CLI `run-code --raw` prints it.
 *
 * @param value Protocol result returned by the page function.
 * @returns A successful wrapped command result.
 * @throws {TypeError} If JSON serialization fails.
 */
function pageResult(value: unknown): BrowserCommandOutput {
  return output(`### Ran Playwright code\n${JSON.stringify(JSON.stringify(value))}\n`);
}

/**
 * Reads the most recent generated `run-code --filename` source.
 *
 * @param invocations Captured browser commands.
 * @returns The generated JavaScript source.
 * @throws {Error} If no script invocation exists or the file cannot be read.
 */
async function lastScript(invocations: readonly BrowserCommandInvocation[]): Promise<string> {
  const invocation = [...invocations].reverse().find((candidate) => {
    return candidate.arguments.includes('run-code');
  });
  return scriptForInvocation(invocation);
}

/**
 * Reads one captured `run-code --filename` source.
 *
 * @param invocation Captured browser command.
 * @returns The generated JavaScript source.
 * @throws {Error} If the invocation has no script path or the file cannot be read.
 */
async function scriptForInvocation(invocation: BrowserCommandInvocation | undefined): Promise<string> {
  const marker = invocation?.arguments.indexOf('--filename') ?? -1;
  const scriptPath = marker < 0 ? undefined : invocation?.arguments[marker + 1];
  if (scriptPath === undefined) {
    throw new Error('run-code script was not captured');
  }
  return readFile(scriptPath, 'utf8');
}

/**
 * Compiles generated page source without executing browser-only globals.
 *
 * @param source Generated async page function.
 * @returns Nothing after syntax validation.
 * @throws {SyntaxError} If the generated file cannot be parsed by Node.js.
 */
function expectPageFunctionSyntax(source: string): void {
  expect(() => {
    return new Function(`return (${source})`);
  }).not.toThrow();
}
