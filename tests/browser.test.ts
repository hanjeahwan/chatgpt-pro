import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PlaywrightBrowser,
  type BrowserCommandInvocation,
  type BrowserCommandOutput,
  type BrowserOperationObserver,
} from '../skills/chatgpt-pro-collab/scripts/browser.ts';
import { collabPaths, ensureCollabDirectories } from '../skills/chatgpt-pro-collab/scripts/session.ts';

const protocol = 'chatgpt-pro-collab/v1';

class CommandReleasedError extends Error {}

class CommandStartedError extends Error {}

class CommandNotSpawnedError extends Error {}

describe('BEH-001, BEH-002, and BEH-006 browser isolation', () => {
  it('saves the shared authentication seed before closing the one-time setup session', async () => {
    const fixture = await browserFixture([
      output('setup opened'),
      output('login observed'),
      output('state saved'),
      output('setup closed'),
    ]);

    await expect(fixture.browser.setup()).resolves.toBe(fixture.paths.seedState);

    expect(
      fixture.invocations.map((invocation) => {
        return invocation.arguments.slice(4);
      }),
    ).toEqual([
      ['open', 'https://chatgpt.com/', '--browser=chrome', '--headed'],
      ['run-code', '--filename', expect.any(String)],
      ['state-save', fixture.paths.seedState],
      ['close'],
    ]);
    const sessions = fixture.invocations.map((invocation) => {
      return invocation.arguments[2];
    });
    expect(new Set(sessions).size).toBe(1);
  });

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
    expect(sendSource.indexOf('clicked = true')).toBeLessThan(sendSource.indexOf('await send.click()'));
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
    expect(preflightSource).toContain('This conversation is archived. To continue, please unarchive it first.');
    expect(preflightSource).toContain("name: 'Unarchive', exact: true");
    expect(preflightSource).toContain('conversation identity changed while making the send target writable');
    expect(preflightSource).toContain("composer.waitFor({ state: 'visible', timeout: 60000 })");
    const cleanupSource = await scriptForInvocation(cleanupInvocation);
    expect(cleanupSource).toContain("page.reload({ waitUntil: 'domcontentloaded' })");
    expect(cleanupSource).toContain('const expectedConversationId = "conversation-a"');
    expect(cleanupSource).toContain('input[type="file"]');
    expect(cleanupSource).toContain('getByText(fileName, { exact: true })');
    expect(cleanupSource).toContain('attachment draft remained after reload');
    expect(cleanupSource).toContain('const attachmentFileNames = ["a","b"]');
    const uploadPreparationSource = await scriptForInvocation(fixture.invocations[1]);
    expect(uploadPreparationSource).toContain('conversation identity changed before attachment preparation');
    expect(uploadPreparationSource).toContain("upload.waitFor({ state: 'visible', timeout: 10000 })");
    expectPageFunctionSyntax(cleanupSource);
  });

  it('clears uploaded attachments when a later known pre-submit check fails', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      pageResult({ protocol, kind: 'upload-ready' }),
      output('uploaded'),
      pageResult({ protocol, kind: 'send', status: 'not-submitted', error: 'composer drift' }),
      pageResult({ protocol, kind: 'draft-cleared' }),
    ]);

    await expect(
      fixture.browser.send('task-a', 'session-a', 'conversation-a', 'exact prompt', ['/tmp/attachment.txt']),
    ).resolves.toEqual({ status: 'not-submitted', error: 'composer drift' });
    const cleanupSource = await lastScript(fixture.invocations);
    expect(cleanupSource).toContain('const attachmentFileNames = ["attachment.txt"]');
    expect(cleanupSource).toContain('attachment draft remained after reload');
  });

  it('cleans uploaded attachments when the gate proves the guarded submit command did not spawn', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      pageResult({ protocol, kind: 'upload-ready' }),
      output('uploaded'),
      new CommandNotSpawnedError('spawn npx ENOENT'),
      pageResult({ protocol, kind: 'draft-cleared' }),
    ]);

    await expect(
      fixture.browser.send('task-a', 'session-a', 'conversation-a', 'exact prompt', ['/tmp/attachment.txt']),
    ).resolves.toEqual({ status: 'not-submitted', error: expect.stringContaining('spawn npx ENOENT') });
    const cleanupSource = await lastScript(fixture.invocations);
    expect(cleanupSource).toContain('const attachmentFileNames = ["attachment.txt"]');
  });

  it('keeps submission ambiguous when the released gate exits before reporting a command PID', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      pageResult({ protocol, kind: 'upload-ready' }),
      output('uploaded'),
      new CommandReleasedError('gate exited before command PID notification'),
    ]);
    let ambiguityPersisted = false;

    await expect(
      fixture.browser.send(
        'task-a',
        'session-a',
        'conversation-a',
        'exact prompt',
        ['/tmp/attachment.txt'],
        undefined,
        () => {
          ambiguityPersisted = true;
        },
      ),
    ).resolves.toEqual({
      status: 'unknown-submission',
      error: expect.stringContaining('gate exited before command PID notification'),
    });
    expect(ambiguityPersisted).toBe(true);
    expect(fixture.invocations).toHaveLength(4);
    expect(await lastScript(fixture.invocations)).not.toContain('attachment draft remained after reload');
  });

  it('marks submission unknown when a started command fails without a page result', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      new CommandStartedError('command PID notification failed'),
    ]);

    await expect(fixture.browser.send('task-a', 'session-a', null, 'exact prompt', [])).resolves.toEqual({
      status: 'unknown-submission',
      error: expect.stringContaining('command PID notification failed'),
    });
  });

  it('keeps submission ambiguous when command PID persistence fails after spawn', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      pageResult({
        protocol,
        kind: 'send',
        status: 'submitted',
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
      }),
    ]);
    let commandCount = 0;
    let ambiguityPersisted = false;
    const observer: BrowserOperationObserver = {
      childSpawned() {},
      childExited() {},
      commandSpawned() {
        commandCount += 1;
        if (commandCount === 2) {
          throw new Error('simulated SQLite attach failure after command spawn');
        }
      },
    };

    await expect(
      fixture.browser.send('task-a', 'session-a', null, 'exact prompt', [], observer, () => {
        ambiguityPersisted = true;
      }),
    ).resolves.toEqual({
      status: 'unknown-submission',
      error: expect.stringContaining('simulated SQLite attach failure after command spawn'),
    });
    expect(ambiguityPersisted).toBe(true);
  });

  it('reports every browser-command child to the task lease observer', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      pageResult({
        protocol,
        kind: 'send',
        status: 'submitted',
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
      }),
    ]);
    const events: string[] = [];
    const observer: BrowserOperationObserver = {
      childSpawned(pid) {
        events.push(`spawn:${pid}`);
      },
      childExited(pid) {
        events.push(`exit:${pid}`);
      },
      commandSpawned(pid) {
        events.push(`command:${pid}`);
      },
    };

    await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', [], observer);

    expect(events).toEqual(['spawn:5000', 'command:6000', 'exit:5000', 'spawn:5001', 'command:6001', 'exit:5001']);
  });

  it('captures Copy response inside the page and never invokes an OS clipboard command', async () => {
    const fixture = await browserFixture([
      pageResult({
        protocol,
        kind: 'observe',
        status: 'completed',
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
      }),
      pageResult({
        protocol,
        kind: 'capture',
        response: 'full response\n```ts\nconst value = 1;\n```',
        responseHtml: '<p>full response</p>',
        artifacts: [{ sourceUrl: 'sandbox:/mnt/data/result.txt', label: 'result.txt' }],
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
      }),
    ]);

    const observed = await fixture.browser.observeResponse('task-a', 'session-a', 'conversation-a', 5000);
    const captured = await fixture.browser.captureResponse('task-a', 'session-a', 'conversation-a', 5000);
    const observationSource = await scriptForInvocation(fixture.invocations[0]);
    const captureSource = await scriptForInvocation(fixture.invocations[1]);

    expect(observed).toMatchObject({ status: 'completed' });
    expect(captured).toMatchObject({
      response: 'full response\n```ts\nconst value = 1;\n```',
      responseHtml: '<p>full response</p>',
      artifacts: [{ sourceUrl: 'sandbox:/mnt/data/result.txt', label: 'result.txt' }],
    });
    expect(observationSource).toContain('stableCompletedPolls < 6');
    expect(observationSource).toContain("kind: 'observe', status: 'pending'");
    expect(captureSource).toContain('[data-testid="copy-turn-action-button"]');
    expect(captureSource).toContain('navigator.clipboard');
    expect(captureSource).toContain("item.types.includes('text/html')");
    expect(captureSource).toContain("sourceUrl?.startsWith('sandbox:')");
    expect(captureSource).toContain("element.querySelectorAll('button.behavior-btn')");
    expect(captureSource).toContain('Copy response omitted text/plain or text/html');
    expect(captureSource).toContain("name: 'Stop answering', exact: true");
    expect(captureSource).toContain('copy.click({ force: true, timeout: Math.max(1, captureDeadline - Date.now()) })');
    expect(captureSource).toContain('const capturedUrl = await page.evaluate');
    expect(captureSource).toContain('capturedMatch[1] !== expectedConversationId');
    expect(captureSource).not.toContain('pbpaste');
    expect(captureSource).not.toContain('osascript');
    expect(captureSource).not.toContain('new URL(page.url())');
    expectPageFunctionSyntax(observationSource);
    expectPageFunctionSyntax(captureSource);
  });

  it('maps one recorded sandbox target to an exact download event and task-owned save path', async () => {
    const sourceUrl = 'sandbox:/mnt/data/bundle.zip';
    const fixture = await browserFixture([
      pageResult({
        protocol,
        kind: 'artifact-download',
        sourceUrl,
        suggestedFilename: 'bundle.zip',
        downloadUrl: 'https://chatgpt.com/backend-api/estuary/content/1',
      }),
      pageResult({
        protocol,
        kind: 'artifact-download',
        sourceUrl,
        suggestedFilename: 'bundle.zip',
        downloadUrl: 'https://chatgpt.com/backend-api/estuary/content/1',
      }),
    ]);

    await expect(
      fixture.browser.downloadArtifact(
        'task-a',
        'session-a',
        'conversation-a',
        [sourceUrl],
        sourceUrl,
        '/tmp/task-a-download',
        5000,
      ),
    ).resolves.toMatchObject({ sourceUrl, suggestedFilename: 'bundle.zip' });
    const source = await lastScript(fixture.invocations);
    await fixture.browser.downloadArtifact(
      'task-a',
      'session-a',
      'conversation-a',
      [sourceUrl],
      sourceUrl,
      '/tmp/task-a-download-resume',
      5000,
    );
    const resumedSource = await lastScript(fixture.invocations);
    expect(source).toContain('const refreshControls = true');
    expect(resumedSource).toContain('const refreshControls = false');
    expect(source).toContain("sourceUrl?.startsWith('sandbox:')");
    expect(source).toContain('artifact.sourceUrl !== expectedSourceUrls[index]');
    expect(source).toContain("page.reload({ waitUntil: 'domcontentloaded' })");
    expect(source).toContain('conversation identity changed while refreshing artifact controls');
    expect(source).toContain('const sandboxOccurrenceCount = await page.evaluate');
    expect(source).toContain(".waitFor({ state: 'attached', timeout: remaining() })");
    expect(source).toContain("assistant.locator('button.behavior-btn')");
    expect(source).toContain("name: 'Download file', exact: true");
    expect(source).toContain('return { occurrences, uniqueTargets }');
    expect(source).toContain('const fileControls = controls.filter');
    expect(source).toContain('controls.length === 2 && fileControls.length === 1');
    expect(source).toContain('const rowBySourceUrl = new Map()');
    expect(source).toContain("const targetDownloadMarker = 'data-chatgpt-pro-collab-target-download'");
    expect(source).toContain("assistant.locator('[' + targetDownloadMarker + '=\"true\"]')");
    expect(source).toContain('artifact rows are not an unambiguous target subsequence');
    expect(source).toContain("page.waitForEvent('download'");
    expect(source).toContain('if (rowIndex !== undefined)');
    expect(source).toContain('while (capturedDownload === undefined)');
    expect(source).toContain('page.waitForTimeout(Math.min(1000, remaining()))');
    expect(source).toContain('control.click({ force: true, timeout: remaining() })');
    expect(source).toContain('await download.saveAs(temporaryPath)');
    expect(source).not.toContain('querySelectorAll(\'a[href^="https:"]\')');
    expectPageFunctionSyntax(source);
  });

  it('rejects a download whose suggested filename belongs to another logical target', async () => {
    const sourceUrl = 'sandbox:/mnt/data/a/same-name.txt';
    const fixture = await browserFixture([
      pageResult({
        protocol,
        kind: 'artifact-download',
        sourceUrl,
        suggestedFilename: 'script.py',
        downloadUrl: 'https://chatgpt.com/backend-api/estuary/content/1',
      }),
    ]);

    await expect(
      fixture.browser.downloadArtifact(
        'task-a',
        'session-a',
        'conversation-a',
        [sourceUrl],
        sourceUrl,
        '/tmp/task-a-download',
        5000,
      ),
    ).rejects.toMatchObject({ code: 'PLAYWRIGHT_CONTRACT_DRIFT' });
  });

  it('uses only the exact target options button and Archive menu item', async () => {
    const fixture = await browserFixture([pageResult({ protocol, kind: 'archive', conversationId: 'conversation-a' })]);

    await expect(fixture.browser.archive('task-a', 'session-a', 'conversation-a')).resolves.toEqual({
      conversationId: 'conversation-a',
    });
    const source = await lastScript(fixture.invocations);
    expect(source).toContain('[data-testid="conversation-options-button"]');
    expect(source).toContain("name: 'Archive', exact: true");
    expect(source).toContain("targetLink.first().waitFor({ state: 'attached', timeout: 60000 })");
    expect(source).toContain('while (absentPolls < 6 && verificationPolls < 120)');
    expect(source).toContain("page.goto('https://chatgpt.com' + targetPath");
    expect(source).toContain('document.querySelector(\'[data-testid^="conversation-turn-"][data-turn]\') !== null');
    expect(source).toContain("finalRestoredUrl.pathname.replace(/\\/$/, '') !== targetPath");
    expect(source).not.toContain("const composer = page.locator('#prompt-textarea')");
    expect(source).not.toContain('Open conversation options');
    expect(source).not.toContain('new URL(page.url())');
    expectPageFunctionSyntax(source);
  });

  it('rejects an archived task page that redirects after its turn appears', async () => {
    const fixture = await browserFixture([pageResult({ protocol, kind: 'archive', conversationId: 'conversation-a' })]);
    await fixture.browser.archive('task-a', 'session-a', 'conversation-a');
    const source = await lastScript(fixture.invocations);
    const runArchive = new Function(`return (${source})`)() as (page: object) => Promise<string>;
    const page = archivePageFixture([
      { hostname: 'chatgpt.com', pathname: '/c/conversation-a' },
      { hostname: 'chatgpt.com', pathname: '/c/conversation-a' },
      { hostname: 'chatgpt.com', pathname: '/c/conversation-b' },
    ]);

    await expect(runArchive(page)).rejects.toThrow('conversation identity changed while restoring');
  });
});

/**
 * Creates a browser with a deterministic FIFO command runner.
 *
 * @param outputs Command results consumed in invocation order.
 * @returns Browser, resolved paths, and captured invocations.
 * @throws {Error} If the temporary fixture cannot be created.
 */
async function browserFixture(outputs: readonly (BrowserCommandOutput | Error)[]) {
  const root = await mkdtemp(join(tmpdir(), 'collab-browser-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  const invocations: BrowserCommandInvocation[] = [];
  const queue = [...outputs];
  let childPid = 5000;
  const browser = new PlaywrightBrowser(paths, root, (invocation) => {
    invocations.push(invocation);
    const invocationChildPid = childPid;
    childPid += 1;
    invocation.onChildSpawned?.(invocationChildPid);
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('unexpected browser invocation'));
    }
    if (next instanceof Error) {
      if (
        next instanceof CommandReleasedError ||
        next instanceof CommandStartedError ||
        next instanceof CommandNotSpawnedError
      ) {
        invocation.beforeCommandRelease?.();
      }
      if (next instanceof CommandStartedError) {
        invocation.onCommandStarted?.();
        invocation.onCommandSpawned?.(invocationChildPid + 1000);
      }
      if (next instanceof CommandNotSpawnedError) {
        invocation.onCommandNotSpawned?.();
      }
      invocation.onChildExited?.(invocationChildPid);
      return Promise.reject(next);
    }
    invocation.beforeCommandRelease?.();
    invocation.onCommandStarted?.();
    invocation.onCommandSpawned?.(invocationChildPid + 1000);
    invocation.onChildExited?.(invocationChildPid);
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
 * Creates the smallest page contract needed to execute a generated Archive script.
 *
 * @param evaluatedUrls URL observations returned in script order.
 * @returns A page-shaped object whose target sidebar link disappears after Archive is clicked.
 * @throws {Error} If the script requests more URL observations than the fixture provides.
 */
function archivePageFixture(
  evaluatedUrls: readonly { readonly hostname: string; readonly pathname: string }[],
): object {
  const urls = [...evaluatedUrls];
  let archived = false;
  const targetLink = {
    first() {
      return targetLink;
    },
    waitFor() {
      return Promise.resolve();
    },
    count() {
      return Promise.resolve(archived ? 0 : 1);
    },
  };
  const passiveLocator = {
    first() {
      return passiveLocator;
    },
    waitFor() {
      return Promise.resolve();
    },
    count() {
      return Promise.resolve(1);
    },
    isVisible() {
      return Promise.resolve(true);
    },
    click() {
      return Promise.resolve();
    },
  };
  const archiveControl = {
    first() {
      return archiveControl;
    },
    count() {
      return Promise.resolve(1);
    },
    isVisible() {
      return Promise.resolve(true);
    },
    click() {
      archived = true;
      return Promise.resolve();
    },
  };

  return {
    evaluate() {
      const url = urls.shift();
      if (url === undefined) {
        return Promise.reject(new Error('archive page fixture exhausted its URL observations'));
      }
      return Promise.resolve(url);
    },
    locator(selector: string) {
      return selector.startsWith('a[href=') ? targetLink : passiveLocator;
    },
    getByRole() {
      return archiveControl;
    },
    waitForURL() {
      return Promise.resolve();
    },
    reload() {
      return Promise.resolve();
    },
    waitForTimeout() {
      return Promise.resolve();
    },
    goto() {
      return Promise.resolve();
    },
    waitForFunction() {
      return Promise.resolve();
    },
  };
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
