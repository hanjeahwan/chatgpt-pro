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
import { CollabService } from '../skills/chatgpt-pro-collab/scripts/collab.ts';
import {
  collabPaths,
  ensureCollabDirectories,
  ensureTaskDirectories,
  responsePath,
} from '../skills/chatgpt-pro-collab/scripts/session.ts';
import { StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';
import { artifactPageFixture, type ArtifactPageOptions } from './support/artifact-page-fixture.ts';
import { completionPageFixture, type CompletionPageOptions } from './support/completion-page-fixture.ts';
import { startPageFixture, type StartPageOptions } from './support/start-page-fixture.ts';

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
      output('navigated to projects'),
      pageResult({ protocol, kind: 'start', url: 'https://chatgpt.com/g/g-p-123/project', contextMarker: 'context-a' }),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    const result = await fixture.browser.startTask('task-a', 'session-a', fixture.paths.seedState);

    expect(result).toEqual({
      pid: 4123,
      url: 'https://chatgpt.com/g/g-p-123/project',
      contextMarker: 'context-a',
      persistent: false,
    });
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
    expect(fixture.invocations[2]?.arguments.slice(4)).toEqual(['goto', 'https://chatgpt.com/projects']);
    expect(
      fixture.invocations.flatMap((invocation) => {
        return invocation.arguments;
      }),
    ).not.toContain('state-save');
    const startSource = await lastScript(fixture.invocations);
    expect(startSource).toContain('await page.evaluate((marker) =>');
    expect(startSource).toContain('role="row"');
    expect(startSource).toContain('role="menuitemradio"');
    expect(startSource).toContain('chatgpt-pro-collab');
    expect(startSource).toContain('GPT-5.6 Sol');
    expect(startSource).not.toContain('new URL(page.url())');
    expect(startSource).not.toContain('new conversation root was not observed');
    expectPageFunctionSyntax(startSource);
  });

  it('maps a typed start failure envelope to its error code and closes the session', async () => {
    const fixture = await browserFixture([
      output('### Browser `session-a` opened with pid 4123.'),
      output('state loaded'),
      output('navigated to projects'),
      pageResult({
        protocol,
        kind: 'start-failed',
        errorCode: 'PROJECT_NOT_UNIQUE',
        message: 'more than one Project exactly named chatgpt-pro-collab was found',
      }),
      output("Browser 'session-a' closed"),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await fixture.browser
      .startTask('task-a', 'session-a', fixture.paths.seedState)
      .catch((error: unknown) => {
        return error;
      });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('more than one Project exactly named chatgpt-pro-collab');
    const typed = failure as { readonly code?: string };
    expect(typed.code).toBe('PROJECT_NOT_UNIQUE');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('preserves page-script errors and closes a failed start session', async () => {
    const fixture = await browserFixture([
      output('### Browser `session-a` opened with pid 4123.'),
      output('state loaded'),
      output('navigated to projects'),
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

describe('BEH-002 fixed Project and GPT-5.6 Sol Pro start context', () => {
  it('succeeds only in the unique Project blank composer after model and mode readback', async () => {
    const fixture = await executableStartFixture({});
    await writeFile(fixture.paths.seedState, '{}');

    const result = await fixture.browser.startTask('task-a', 'session-a', fixture.paths.seedState);

    expect(result.url).toBe('https://chatgpt.com/g/g-p-123/project');
    expect(result.contextMarker).toBeTruthy();
    expect(fixture.events).toEqual([
      'project-row-click',
      'selector-click',
      'mode-click',
      'selector-click',
      'opener-click',
      'model-click',
      'selector-click',
      'opener-click',
      'selector-click',
    ]);
    expect(
      fixture.invocations.map((invocation) => {
        return invocation.arguments.slice(4);
      }),
    ).toEqual([
      ['open', 'about:blank', '--browser=chrome', '--headed'],
      ['state-load', fixture.paths.seedState],
      ['goto', 'https://chatgpt.com/projects'],
      ['run-code', '--filename', expect.any(String)],
    ]);
  });

  it('confirms already selected targets by readback without clicking', async () => {
    const fixture = await executableStartFixture({ modeInitiallyChecked: true, modelInitiallyChecked: true });
    await writeFile(fixture.paths.seedState, '{}');

    const result = await fixture.browser.startTask('task-a', 'session-a', fixture.paths.seedState);

    expect(result.contextMarker).toBeTruthy();
    expect(fixture.events).toEqual(['project-row-click', 'selector-click', 'opener-click', 'selector-click']);
  });

  it('rejects with PROJECT_NOT_FOUND when the target Project row is absent', async () => {
    const fixture = await executableStartFixture({ projectRowCount: 0, otherRowCount: 1 });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.message).toContain('chatgpt-pro-collab');
    expect(failure.code).toBe('PROJECT_NOT_FOUND');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with PROJECT_NOT_FOUND when the projects directory never renders rows', async () => {
    const fixture = await executableStartFixture({ projectLoadsRows: false });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('PROJECT_NOT_FOUND');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with PROJECT_NOT_UNIQUE when two rows match the target name', async () => {
    const fixture = await executableStartFixture({ projectRowCount: 2 });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('PROJECT_NOT_UNIQUE');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with FIXED_TARGET_UNAVAILABLE when the fixed mode radio is missing', async () => {
    const fixture = await executableStartFixture({ modeRadioPresent: false });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('FIXED_TARGET_UNAVAILABLE');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with FIXED_TARGET_UNAVAILABLE when the fixed model radio is missing', async () => {
    const fixture = await executableStartFixture({ modelRadioPresent: false });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('FIXED_TARGET_UNAVAILABLE');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with SELECTION_UNCONFIRMED when the mode click cannot be read back', async () => {
    const fixture = await executableStartFixture({ modeClickApplies: false });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('SELECTION_UNCONFIRMED');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with SELECTION_UNCONFIRMED when the model click cannot be read back', async () => {
    const fixture = await executableStartFixture({ modelClickApplies: false });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('SELECTION_UNCONFIRMED');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with PAGE_CONTRACT_DRIFT when the Project title heading is missing in the main area', async () => {
    const fixture = await executableStartFixture({ mainTitleCount: 0 });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('PAGE_CONTRACT_DRIFT');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with PAGE_CONTRACT_DRIFT when an existing conversation is open', async () => {
    const fixture = await executableStartFixture({ existingTurns: true });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('PAGE_CONTRACT_DRIFT');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with PAGE_CONTRACT_DRIFT when navigation does not reach the project path', async () => {
    const fixture = await executableStartFixture({ navigateOnProjectClick: false });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('PAGE_CONTRACT_DRIFT');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with PAGE_CONTRACT_DRIFT when the composer selector control is missing', async () => {
    const fixture = await executableStartFixture({ selectorControlCount: 0 });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('PAGE_CONTRACT_DRIFT');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with PAGE_CONTRACT_DRIFT when the model submenu opener is missing', async () => {
    const fixture = await executableStartFixture({ modelOpenerCount: 0 });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('PAGE_CONTRACT_DRIFT');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });

  it('rejects with PAGE_CONTRACT_DRIFT when the authenticated page is not observed', async () => {
    const fixture = await executableStartFixture({ authenticated: false });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('PAGE_CONTRACT_DRIFT');
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
    expect(sendSource).toContain('const conversationIdOf = (pathname) => {');
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
        assistantTurnId: 'conversation-turn-t1',
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
    const controller = new AbortController();
    const captured = await fixture.browser.captureResponse(
      'task-a',
      'session-a',
      'conversation-a',
      observed.status === 'completed' ? observed.assistantTurnId : null,
      5000,
      controller.signal,
    );
    const observationSource = await scriptForInvocation(fixture.invocations[0]);
    const captureSource = await scriptForInvocation(fixture.invocations[1]);

    expect(observed).toMatchObject({ status: 'completed' });
    expect(captured).toMatchObject({
      response: 'full response\n```ts\nconst value = 1;\n```',
      responseHtml: '<p>full response</p>',
      artifacts: [{ sourceUrl: 'sandbox:/mnt/data/result.txt', label: 'result.txt' }],
    });
    expect(fixture.invocations[1]?.signal).toBe(controller.signal);
    expect(observationSource).toContain('stableCompletedPolls < 6');
    expect(observationSource).toContain("kind: 'observe', status: 'pending'");
    expect(observationSource).toContain('assistantTurnId');
    expect(observationSource).not.toContain('sessionStorage');
    expect(observationSource).not.toContain('page.reload');
    expect(captureSource).toContain('[data-testid="copy-turn-action-button"]');
    expect(captureSource).toContain('expectedAssistantTurnId');
    expect(captureSource).toContain('navigator.clipboard');
    expect(captureSource).toContain("item.types.includes('text/html')");
    expect(captureSource).toContain("sourceUrl?.startsWith('sandbox:')");
    expect(captureSource).toContain("element.querySelectorAll('button.behavior-btn')");
    expect(captureSource).toContain('Copy response omitted text/plain or text/html');
    expect(captureSource).toContain("name: 'Stop answering', exact: true");
    expect(captureSource).toContain('copy.click({ force: true, timeout: Math.max(1, captureDeadline - Date.now()) })');
    expect(captureSource).toContain('const capturedUrl = await page.evaluate');
    expect(captureSource).toContain('conversationIdOf(capturedUrl.pathname) !== expectedConversationId');
    expect(captureSource).not.toContain('pbpaste');
    expect(captureSource).not.toContain('osascript');
    expect(captureSource).not.toContain('new URL(page.url())');
    expectPageFunctionSyntax(observationSource);
    expectPageFunctionSyntax(captureSource);
  });

  it('executes the normal completion condition and returns the stable assistant identity', async () => {
    const fixture = await executableCompletionFixture({ assistantTurnId: 'conversation-turn-t1', stopVisible: false });

    await expect(fixture.browser.observeResponse('task-a', 'session-a', 'conversation-a', 5000)).resolves.toEqual({
      status: 'completed',
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
      assistantTurnId: 'conversation-turn-t1',
    });
    expect(fixture.events).toHaveLength(6);
  });

  it('returns pending without reload when Stop remains visible', async () => {
    const fixture = await executableCompletionFixture({ stopVisible: true });

    await expect(fixture.browser.observeResponse('task-a', 'session-a', 'conversation-a', 5000)).resolves.toEqual({
      status: 'pending',
    });
    expect(fixture.events).toHaveLength(10);
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
    const firstController = new AbortController();

    await expect(
      fixture.browser.downloadArtifact(
        'task-a',
        'session-a',
        'conversation-a',
        [sourceUrl],
        sourceUrl,
        '/tmp/task-a-download',
        5000,
        firstController.signal,
      ),
    ).resolves.toMatchObject({ sourceUrl, suggestedFilename: 'bundle.zip' });
    expect(fixture.invocations[0]?.signal).toBe(firstController.signal);
    const source = await lastScript(fixture.invocations);
    await fixture.browser.downloadArtifact(
      'task-a',
      'session-a',
      'conversation-a',
      [sourceUrl],
      sourceUrl,
      '/tmp/task-a-download-resume',
      5000,
      new AbortController().signal,
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

  it('executes Copy response occurrence mapping against a live-compatible page fixture', async () => {
    const first = 'sandbox:/mnt/data/first.txt';
    const second = 'sandbox:/mnt/data/second.txt';
    const fixture = await executableBrowserFixture({
      responseHtml: `<p>files</p><a href="${first}">first</a><a href="${first}">again</a><a href="${second}">second</a>`,
      responsePlain: 'clipboard occurrence response',
      behaviorButtonCount: 3,
      includeLaterTurn: true,
    });

    await expect(
      fixture.browser.captureResponse(
        'task-a',
        'session-a',
        'conversation-a',
        'conversation-turn-t1',
        5000,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      response: 'clipboard occurrence response',
      artifacts: [
        { sourceUrl: first, label: 'first' },
        { sourceUrl: second, label: 'second' },
      ],
    });
    expect(fixture.events).toEqual([
      'clipboard:install',
      'copy',
      'clipboard:write',
      'clipboard:read',
      'clipboard:restore',
    ]);
    expect(fixture.globalsRestored()).toBe(true);
  });

  it('rejects a missing observed assistant instead of capturing a later assistant', async () => {
    const fixture = await executableBrowserFixture({
      responseHtml: '<p>later response</p>',
      behaviorButtonCount: 0,
      includeLaterTurn: true,
    });

    await expect(
      fixture.browser.captureResponse(
        'task-a',
        'session-a',
        'conversation-a',
        'conversation-turn-missing',
        5000,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PLAYWRIGHT_CONTRACT_DRIFT' });
    expect(fixture.events).toEqual([]);
    expect(fixture.globalsRestored()).toBe(true);
  });

  it('rejects an executed Copy response whose occurrence and behavior-button counts differ', async () => {
    const fixture = await executableBrowserFixture({
      responseHtml: '<a href="sandbox:/mnt/data/first.txt">first</a><a href="sandbox:/mnt/data/second.txt">second</a>',
      behaviorButtonCount: 1,
    });

    await expect(
      fixture.browser.captureResponse(
        'task-a',
        'session-a',
        'conversation-a',
        null,
        5000,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PLAYWRIGHT_CONTRACT_DRIFT' });
    expect(fixture.globalsRestored()).toBe(true);
  });

  it.each([
    { label: 'direct', artifactRows: [], expectedEvent: 'download:direct' },
    { label: 'artifact row', artifactRows: ['bundle.zip'], expectedEvent: 'download:artifact' },
  ])('executes the $label download-event path and saves the emitted bytes', async ({ artifactRows, expectedEvent }) => {
    const sourceUrl = 'sandbox:/mnt/data/bundle.zip';
    const fixture = await executableBrowserFixture({
      responseHtml: `<a href="${sourceUrl}">bundle.zip</a>`,
      behaviorButtonCount: 1,
      artifactRows,
      suggestedFilename: 'bundle.zip',
    });
    const temporaryPath = join(fixture.root, `${artifactRows.length === 0 ? 'direct' : 'row'}.tmp`);

    await expect(
      fixture.browser.downloadArtifact(
        'task-a',
        'session-a',
        'conversation-a',
        [sourceUrl],
        sourceUrl,
        temporaryPath,
        5000,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ sourceUrl, suggestedFilename: 'bundle.zip' });
    expect(fixture.events).toContain(expectedEvent);
    await expect(readFile(temporaryPath, 'utf8')).resolves.toBe('downloaded bundle.zip');
  });

  it.each([
    {
      label: 'artifact row order',
      options: {
        responseHtml:
          '<a href="sandbox:/mnt/data/first.txt">first</a><a href="sandbox:/mnt/data/second.txt">second</a>',
        behaviorButtonCount: 2,
        artifactRows: ['second.txt', 'first.txt'],
        suggestedFilename: 'first.txt',
      },
      expectedSourceUrls: ['sandbox:/mnt/data/first.txt', 'sandbox:/mnt/data/second.txt'],
      targetSourceUrl: 'sandbox:/mnt/data/first.txt',
    },
    {
      label: 'artifact control relationship',
      options: {
        responseHtml: '<a href="sandbox:/mnt/data/result.txt">result</a>',
        behaviorButtonCount: 1,
        artifactRows: ['result.txt'],
        unrelatedRowControls: true,
        suggestedFilename: 'result.txt',
      },
      expectedSourceUrls: ['sandbox:/mnt/data/result.txt'],
      targetSourceUrl: 'sandbox:/mnt/data/result.txt',
    },
  ])(
    'rejects executed $label drift without producing a download',
    async ({ options, expectedSourceUrls, targetSourceUrl }) => {
      const fixture = await executableBrowserFixture(options);

      await expect(
        fixture.browser.downloadArtifact(
          'task-a',
          'session-a',
          'conversation-a',
          expectedSourceUrls,
          targetSourceUrl,
          join(fixture.root, 'must-not-exist'),
          5000,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'PLAYWRIGHT_CONTRACT_DRIFT' });
      expect(
        fixture.events.some((event) => {
          return event.startsWith('download:');
        }),
      ).toBe(false);
    },
  );

  it('executes a missing download event and preserves the browser timeout failure code', async () => {
    const sourceUrl = 'sandbox:/mnt/data/result.txt';
    const fixture = await executableBrowserFixture({
      responseHtml: `<a href="${sourceUrl}">result</a>`,
      behaviorButtonCount: 1,
      downloadEvent: 'timeout',
      suggestedFilename: 'result.txt',
    });

    await expect(
      fixture.browser.downloadArtifact(
        'task-a',
        'session-a',
        'conversation-a',
        [sourceUrl],
        sourceUrl,
        join(fixture.root, 'must-not-exist'),
        5,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_COMMAND_FAILED' });
  });

  it('keeps the turn capturing when an executed download event times out', async () => {
    const sourceUrl = 'sandbox:/mnt/data/result.txt';
    const fixture = await executableBrowserFixture({
      responseHtml: `<a href="${sourceUrl}">result</a>`,
      behaviorButtonCount: 1,
      downloadEvent: 'timeout',
      suggestedFilename: 'result.txt',
    });
    await ensureTaskDirectories(fixture.paths, 'task-a');
    const targetResponsePath = responsePath(fixture.paths, 'task-a', 'turn-a');
    const store = new StateStore(fixture.paths.database);
    store.createTask('task-a', 'session-a');
    store.beginTurn('task-a', 'turn-a', '/prompt.md', []);
    store.markSubmissionAttempting('task-a', 'turn-a');
    store.markTurnPending('task-a', 'turn-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a');
    store.freezeCapture('task-a', 'turn-a', targetResponsePath, [{ sourceUrl, label: 'result' }]);
    store.close();
    const service = new CollabService(fixture.paths, fixture.browser);

    await expect(service.wait('task-a', 'turn-a', 1, 5000)).rejects.toMatchObject({
      code: 'BROWSER_COMMAND_FAILED',
    });
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn('task-a', 'turn-a')).toMatchObject({
      status: 'capturing',
      artifactSetRecorded: true,
    });
    expect(reopened.listArtifacts('task-a', 'turn-a')).toMatchObject([
      { status: 'pending', error: expect.stringContaining('fixture download event timeout') },
    ]);
    reopened.close();
    await expect(readFile(targetResponsePath, 'utf8')).resolves.toBe('fixture response');
  });

  it('keeps the turn capturing when an executed artifact-row mapping drifts', async () => {
    const first = 'sandbox:/mnt/data/first.txt';
    const second = 'sandbox:/mnt/data/second.txt';
    const fixture = await executableBrowserFixture({
      responseHtml: `<a href="${first}">first</a><a href="${second}">second</a>`,
      behaviorButtonCount: 2,
      artifactRows: ['second.txt', 'first.txt'],
      suggestedFilename: 'first.txt',
    });
    await ensureTaskDirectories(fixture.paths, 'task-a');
    const targetResponsePath = responsePath(fixture.paths, 'task-a', 'turn-a');
    const store = new StateStore(fixture.paths.database);
    store.createTask('task-a', 'session-a');
    store.beginTurn('task-a', 'turn-a', '/prompt.md', []);
    store.markSubmissionAttempting('task-a', 'turn-a');
    store.markTurnPending('task-a', 'turn-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a');
    store.freezeCapture('task-a', 'turn-a', targetResponsePath, [
      { sourceUrl: first, label: 'first' },
      { sourceUrl: second, label: 'second' },
    ]);
    store.close();
    const service = new CollabService(fixture.paths, fixture.browser);

    await expect(service.wait('task-a', 'turn-a', 1, 5000)).rejects.toMatchObject({
      code: 'PLAYWRIGHT_CONTRACT_DRIFT',
    });
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn('task-a', 'turn-a')).toMatchObject({
      status: 'capturing',
      artifactSetRecorded: true,
    });
    expect(reopened.listArtifacts('task-a', 'turn-a')).toMatchObject([{ status: 'pending' }, { status: 'pending' }]);
    reopened.close();
    await expect(readFile(targetResponsePath, 'utf8')).resolves.toBe('fixture response');
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
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PLAYWRIGHT_CONTRACT_DRIFT' });
  });

  it('uses only the exact target options button and Archive menu item', async () => {
    const fixture = await browserFixture([pageResult({ protocol, kind: 'archive', conversationId: 'conversation-a' })]);

    await expect(
      fixture.browser.archive('task-a', 'session-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a'),
    ).resolves.toEqual({
      conversationId: 'conversation-a',
    });
    const source = await lastScript(fixture.invocations);
    expect(source).toContain('[data-testid="conversation-options-button"]');
    expect(source).toContain("name: 'Archive', exact: true");
    expect(source).toContain("targetLink.first().waitFor({ state: 'attached', timeout: 60000 })");
    expect(source).toContain('while (absentPolls < 6 && verificationPolls < 120)');
    expect(source).toContain("await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded' })");
    expect(source).toContain('conversationIdOf(url.pathname) !== conversationId');
    expect(source).toContain('conversationIdOf(finalRestoredUrl.pathname) !== conversationId');
    expect(source).toContain('document.querySelector(\'[data-testid^="conversation-turn-"][data-turn]\') !== null');
    expect(source).not.toContain("const composer = page.locator('#prompt-textarea')");
    expect(source).not.toContain('Open conversation options');
    expect(source).not.toContain('new URL(page.url())');
    expectPageFunctionSyntax(source);
  });

  it('archives a project-scoped conversation using its canonical URL', async () => {
    const fixture = await browserFixture([pageResult({ protocol, kind: 'archive', conversationId: 'conversation-a' })]);

    await expect(
      fixture.browser.archive(
        'task-a',
        'session-a',
        'conversation-a',
        'https://chatgpt.com/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      ),
    ).resolves.toEqual({
      conversationId: 'conversation-a',
    });
    const source = await lastScript(fixture.invocations);
    expect(source).toContain('https://chatgpt.com/g/g-p-123-chatgpt-pro-collab/c/conversation-a');
    expect(source).toContain("page.locator('a[href=\"' + sidebarPath + '\"]')");
    expect(source).not.toContain("targetPath = '/c/' + conversationId");
    expectPageFunctionSyntax(source);
  });

  it('rejects an archived task page that redirects after its turn appears', async () => {
    const fixture = await browserFixture([pageResult({ protocol, kind: 'archive', conversationId: 'conversation-a' })]);
    await fixture.browser.archive('task-a', 'session-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a');
    const source = await lastScript(fixture.invocations);
    const runArchive = new Function(`return (${source})`)() as (page: object) => Promise<string>;
    const page = archivePageFixture([
      { hostname: 'chatgpt.com', pathname: '/c/conversation-a' },
      { hostname: 'chatgpt.com', pathname: '/c/conversation-b' },
    ]);

    await expect(runArchive(page)).rejects.toThrow('conversation identity changed while restoring');
  });

  it('restores a project-scoped archived conversation under its canonical URL', async () => {
    const fixture = await browserFixture([pageResult({ protocol, kind: 'archive', conversationId: 'conversation-a' })]);
    await fixture.browser.archive(
      'task-a',
      'session-a',
      'conversation-a',
      'https://chatgpt.com/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
    );
    const source = await lastScript(fixture.invocations);
    const runArchive = new Function(`return (${source})`)() as (page: object) => Promise<string>;
    const page = archivePageFixture([
      { hostname: 'chatgpt.com', pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a' },
      { hostname: 'chatgpt.com', pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a' },
    ]);

    await expect(runArchive(page)).resolves.toContain('conversation-a');
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
 * Creates a browser runner that executes the generated start verification function against
 * a live-compatible Projects and model/mode menu fixture.
 *
 * @param options Project, composer, and menu structure exposed to the generated function.
 * @returns Browser, fixture root, captured invocations, and ordered page events.
 * @throws {Error} If the fixture directory or generated script cannot be read.
 */
async function executableStartFixture(options: StartPageOptions) {
  const root = await mkdtemp(join(tmpdir(), 'collab-start-browser-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  const invocations: BrowserCommandInvocation[] = [];
  const pageFixture = startPageFixture(options);
  let childPid = 7000;
  const browser = new PlaywrightBrowser(paths, root, async (invocation) => {
    invocations.push(invocation);
    const invocationChildPid = childPid;
    childPid += 1;
    invocation.onChildSpawned?.(invocationChildPid);
    try {
      invocation.beforeCommandRelease?.();
      invocation.onCommandStarted?.();
      invocation.onCommandSpawned?.(invocationChildPid + 1000);
      if (invocation.arguments.includes('run-code')) {
        const source = await scriptForInvocation(invocation);
        const runPageFunction = new Function(`return (${source})`)() as (page: object) => Promise<unknown>;
        const result = await runPageFunction(pageFixture.page);
        return output(`### Ran Playwright code\n${JSON.stringify(result)}\n`);
      }
      if (invocation.arguments.includes('open')) {
        const sessionName = (invocation.arguments[2] ?? 'session').replace(/^-s=/u, '');
        return output(`### Browser \`${sessionName}\` opened with pid ${invocationChildPid}.`);
      }
      return output('ok');
    } finally {
      invocation.onChildExited?.(invocationChildPid);
    }
  });
  return {
    browser,
    events: pageFixture.events,
    invocations,
    paths,
    root,
  };
}

/**
 * Runs one start task and returns its typed failure without throwing.
 *
 * @param fixture Executable start fixture.
 * @returns The rejected error with its machine code.
 * @throws {Error} If the start unexpectedly succeeds.
 */
async function startTaskFailure(fixture: Awaited<ReturnType<typeof executableStartFixture>>) {
  const failure = await fixture.browser
    .startTask('task-a', 'session-a', fixture.paths.seedState)
    .then(() => {
      throw new Error('start unexpectedly succeeded');
    })
    .catch((error: unknown) => {
      return error;
    });
  expect(failure).toBeInstanceOf(Error);
  const typed = failure as Error & { readonly code?: string };
  expect(typed.code).toBeDefined();
  return typed;
}

/**
 * Creates a browser runner that executes the generated page function against a live-compatible fixture.
 *
 * @param options Page Copy response, control topology, and download-event behavior.
 * @returns Browser, fixture root, captured invocations, and ordered page events.
 * @throws {Error} If the fixture directory or generated script cannot be read.
 */
async function executableBrowserFixture(options: ArtifactPageOptions) {
  const root = await mkdtemp(join(tmpdir(), 'collab-executable-browser-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  const invocations: BrowserCommandInvocation[] = [];
  const pageFixture = artifactPageFixture(options);
  let childPid = 9000;
  const browser = new PlaywrightBrowser(paths, root, async (invocation) => {
    invocations.push(invocation);
    const invocationChildPid = childPid;
    childPid += 1;
    invocation.onChildSpawned?.(invocationChildPid);
    try {
      invocation.beforeCommandRelease?.();
      invocation.onCommandStarted?.();
      invocation.onCommandSpawned?.(invocationChildPid + 1000);
      const source = await scriptForInvocation(invocation);
      const runPageFunction = new Function(`return (${source})`)() as (page: object) => Promise<string>;
      try {
        const result = await runPageFunction(pageFixture.page);
        return output(`### Ran Playwright code\n${JSON.stringify(result)}\n`);
      } catch (error) {
        if (error instanceof Error && error.message === 'fixture download event timeout') {
          throw error;
        }
        return output(`### Error\n${error instanceof Error ? error.message : String(error)}\n`);
      }
    } finally {
      invocation.onChildExited?.(invocationChildPid);
    }
  });
  return {
    browser,
    events: pageFixture.events,
    globalsRestored() {
      return pageFixture.globalsRestored();
    },
    invocations,
    paths,
    root,
  };
}

/**
 * Creates a browser runner that executes normal completion observation against a page fixture.
 *
 * @param options Assistant identity and Stop visibility.
 * @returns Browser and ordered observation events.
 * @throws {Error} If the fixture directory or generated script cannot be read.
 */
async function executableCompletionFixture(options: CompletionPageOptions) {
  const root = await mkdtemp(join(tmpdir(), 'collab-completion-browser-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  const pageFixture = completionPageFixture(options);
  const browser = new PlaywrightBrowser(paths, root, async (invocation) => {
    invocation.beforeCommandRelease?.();
    invocation.onCommandStarted?.();
    invocation.onCommandSpawned?.(10_000);
    invocation.onChildSpawned?.(9000);
    try {
      const source = await scriptForInvocation(invocation);
      const runPageFunction = new Function(`return (${source})`)() as (page: object) => Promise<string>;
      return output(`### Ran Playwright code\n${JSON.stringify(await runPageFunction(pageFixture.page))}\n`);
    } finally {
      invocation.onChildExited?.(9000);
    }
  });
  return { browser, events: pageFixture.events };
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
