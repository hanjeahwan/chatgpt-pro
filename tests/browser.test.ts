import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
import { projectSendPageFixture } from './support/project-send-page-fixture.ts';
import { resolveTurnPageFixture, type ResolveTurnPageOptions } from './support/resolve-turn-page-fixture.ts';
import { startPageFixture, type StartPageOptions } from './support/start-page-fixture.ts';
import { submissionPageFixture } from './support/submission-page-fixture.ts';

const protocol = 'chatgpt-pro-collab/v1';

class CommandReleasedError extends Error {}

class CommandStartedError extends Error {}

class CommandNotSpawnedError extends Error {}

describe('BEH-001, BEH-002, and BEH-006 browser isolation', () => {
  it('saves the shared authentication seed before closing the one-time setup session', async () => {
    const fixture = await browserFixture([
      output('  (no browsers)'),
      output('setup opened'),
      output('login observed'),
      output('state saved'),
      output('setup closed'),
      output('  (no browsers)'),
    ]);

    await expect(fixture.browser.setup()).resolves.toBe(fixture.paths.seedState);

    expect(
      fixture.invocations.map((invocation) => {
        return invocation.arguments.slice(4);
      }),
    ).toEqual([
      [],
      ['open', 'https://chatgpt.com/', '--browser=chrome', '--headed'],
      ['run-code', '--filename', expect.any(String)],
      ['state-save', fixture.paths.seedState],
      ['close'],
      [],
    ]);
    const sessions = fixture.invocations.flatMap((invocation) => {
      return invocation.arguments[2]?.startsWith('-s=') ? [invocation.arguments[2]] : [];
    });
    expect(new Set(sessions).size).toBe(1);
  });

  it('verifies a seed in a distinct named session even when the interactive setup session is logged in', async () => {
    const fixture = await browserFixture([
      output('Sessions:\n  - name: chatgpt-pro-collab-setup-live\n    state: open\n    pid: 100\n'),
      output('verification opened'),
      output('seed loaded'),
      output('navigated to chatgpt.com'),
      new Error('fixture verify-seed failed'),
      output('verification closed'),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    await expect(
      fixture.browser.verifyAuthenticatedSeed('chatgpt-pro-collab-setup-live', fixture.paths.seedState),
    ).resolves.toEqual({ authenticated: false });

    const sessionArgs = fixture.invocations.flatMap((invocation) => {
      return invocation.arguments[2]?.startsWith('-s=') ? [invocation.arguments[2]] : [];
    });
    expect(sessionArgs).toEqual([
      '-s=chatgpt-pro-collab-setup-live-verify',
      '-s=chatgpt-pro-collab-setup-live-verify',
      '-s=chatgpt-pro-collab-setup-live-verify',
      '-s=chatgpt-pro-collab-setup-live-verify',
      '-s=chatgpt-pro-collab-setup-live-verify',
    ]);
    const commands = fixture.invocations.map((invocation) => {
      return invocation.arguments.slice(4);
    });
    expect(commands).toEqual([
      [],
      ['open', 'about:blank', '--browser=chrome', '--headed'],
      ['state-load', fixture.paths.seedState],
      ['goto', 'https://chatgpt.com/'],
      ['run-code', '--filename', expect.any(String)],
      ['close'],
    ]);
    const touchedSetupSession = fixture.invocations.some((invocation) => {
      return invocation.arguments[2] === '-s=chatgpt-pro-collab-setup-live' && invocation.arguments[4] === 'close';
    });
    expect(touchedSetupSession).toBe(false);
  });

  it('closes a leftover verification session before verifying a fresh seed', async () => {
    const fixture = await browserFixture([
      output('Sessions:\n  - name: chatgpt-pro-collab-setup-live-verify\n    state: open\n    pid: 200\n'),
      output('leftover closed'),
      output('verification opened'),
      output('seed loaded'),
      output('navigated to chatgpt.com'),
      output('verify-seed passed'),
      output('verification closed'),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    await expect(
      fixture.browser.verifyAuthenticatedSeed('chatgpt-pro-collab-setup-live', fixture.paths.seedState),
    ).resolves.toEqual({ authenticated: true });

    const commands = fixture.invocations.map((invocation) => {
      return invocation.arguments.slice(4);
    });
    expect(commands).toEqual([
      [],
      ['close'],
      ['open', 'about:blank', '--browser=chrome', '--headed'],
      ['state-load', fixture.paths.seedState],
      ['goto', 'https://chatgpt.com/'],
      ['run-code', '--filename', expect.any(String)],
      ['close'],
    ]);
  });

  it('closes the verification session when the browser open itself fails', async () => {
    const fixture = await browserFixture([
      output('  (no browsers)'),
      new Error('fixture open failed'),
      output('verification closed'),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    await expect(
      fixture.browser.verifyAuthenticatedSeed('chatgpt-pro-collab-setup-live', fixture.paths.seedState),
    ).rejects.toThrow(/fixture open failed/);

    const commands = fixture.invocations.map((invocation) => {
      return invocation.arguments.slice(4);
    });
    expect(commands).toEqual([[], ['open', 'about:blank', '--browser=chrome', '--headed'], ['close']]);
  });

  it('fails the verification when the page check succeeds but closing the verification session fails', async () => {
    const fixture = await browserFixture([
      output('  (no browsers)'),
      output('verification opened'),
      output('seed loaded'),
      output('navigated to chatgpt.com'),
      output('verify-seed passed'),
      new Error('fixture close failed'),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    const error = await fixture.browser
      .verifyAuthenticatedSeed('chatgpt-pro-collab-setup-live', fixture.paths.seedState)
      .then(
        () => {
          return null;
        },
        (reason: unknown) => {
          return reason;
        },
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/authenticated: true/);
    expect((error as Error).message).toMatch(/could not be closed/);
    expect((error as Error).message).toMatch(/fixture close failed/);

    const commands = fixture.invocations.map((invocation) => {
      return invocation.arguments.slice(4);
    });
    expect(commands).toEqual([
      [],
      ['open', 'about:blank', '--browser=chrome', '--headed'],
      ['state-load', fixture.paths.seedState],
      ['goto', 'https://chatgpt.com/'],
      ['run-code', '--filename', expect.any(String)],
      ['close'],
    ]);
    const setupSessionClosed = fixture.invocations.some((invocation) => {
      return invocation.arguments[2] === '-s=chatgpt-pro-collab-setup-live' && invocation.arguments[4] === 'close';
    });
    expect(setupSessionClosed).toBe(false);
  });

  it('reports both the verification failure and the cleanup failure when both fail', async () => {
    const fixture = await browserFixture([
      output('  (no browsers)'),
      new Error('fixture open failed'),
      new Error('fixture close failed'),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    const error = await fixture.browser
      .verifyAuthenticatedSeed('chatgpt-pro-collab-setup-live', fixture.paths.seedState)
      .then(
        () => {
          return null;
        },
        (reason: unknown) => {
          return reason;
        },
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/fixture open failed/);
    expect((error as Error).message).toMatch(/cleanup also failed/);
    expect((error as Error).message).toMatch(/fixture close failed/);

    const commands = fixture.invocations.map((invocation) => {
      return invocation.arguments.slice(4);
    });
    expect(commands).toEqual([[], ['open', 'about:blank', '--browser=chrome', '--headed'], ['close']]);
    const setupSessionClosed = fixture.invocations.some((invocation) => {
      return invocation.arguments[2] === '-s=chatgpt-pro-collab-setup-live' && invocation.arguments[4] === 'close';
    });
    expect(setupSessionClosed).toBe(false);
  });

  it('fails an unauthenticated verdict when closing the verification session fails', async () => {
    const fixture = await browserFixture([
      output('  (no browsers)'),
      output('verification opened'),
      output('seed loaded'),
      output('navigated to chatgpt.com'),
      new Error('fixture verify-seed failed'),
      new Error('fixture close failed'),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    const error = await fixture.browser
      .verifyAuthenticatedSeed('chatgpt-pro-collab-setup-live', fixture.paths.seedState)
      .then(
        () => {
          return null;
        },
        (reason: unknown) => {
          return reason;
        },
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/authenticated: false/);
    expect((error as Error).message).toMatch(/could not be closed/);
    expect((error as Error).message).toMatch(/fixture close failed/);

    const commands = fixture.invocations.map((invocation) => {
      return invocation.arguments.slice(4);
    });
    expect(commands).toEqual([
      [],
      ['open', 'about:blank', '--browser=chrome', '--headed'],
      ['state-load', fixture.paths.seedState],
      ['goto', 'https://chatgpt.com/'],
      ['run-code', '--filename', expect.any(String)],
      ['close'],
    ]);
  });

  it('authenticates a seed only on the signed-in chatgpt.com composer page', async () => {
    const fixture = await browserFixture([
      output('  (no browsers)'),
      output('verification opened'),
      output('seed loaded'),
      output('navigated to chatgpt.com'),
      output('verify-seed passed'),
      output('verification closed'),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    await expect(
      fixture.browser.verifyAuthenticatedSeed('chatgpt-pro-collab-setup-live', fixture.paths.seedState),
    ).resolves.toEqual({ authenticated: true });

    const source = await lastScript(fixture.invocations);
    expect(source).toContain("location.hostname === 'chatgpt.com'");
    expect(source).toContain("document.querySelectorAll('#prompt-textarea')");
    expect(source).toContain("label === 'Log in'");
    expectPageFunctionSyntax(source);

    const runAuthScript = new Function(`return (${source})`)() as (page: object) => Promise<void>;

    await expect(
      runAuthScript(
        submissionPageFixture({ pathname: '/', hostname: 'chatgpt.com', composerCount: 1, authControls: [] }).page,
      ),
    ).resolves.toBeUndefined();

    await expect(
      runAuthScript(submissionPageFixture({ pathname: '/', hostname: 'about:blank', composerCount: 0 }).page),
    ).rejects.toThrow(/fixture waitForFunction deadline exceeded/);

    await expect(
      runAuthScript(submissionPageFixture({ pathname: '/', hostname: 'chatgpt.com', composerCount: 0 }).page),
    ).rejects.toThrow(/fixture waitForFunction deadline exceeded/);

    await expect(
      runAuthScript(
        submissionPageFixture({
          pathname: '/',
          hostname: 'chatgpt.com',
          composerCount: 1,
          authControls: ['Log in'],
        }).page,
      ),
    ).rejects.toThrow(/fixture waitForFunction deadline exceeded/);

    await expect(
      runAuthScript(
        submissionPageFixture({
          pathname: '/',
          hostname: 'chatgpt.com',
          composerCount: 2,
          authControls: [],
        }).page,
      ),
    ).rejects.toThrow(/fixture waitForFunction deadline exceeded/);
  });

  it('uses the fixed CLI prefix, task output directory, and shared seed without persistence', async () => {
    const fixture = await browserFixture([
      output('### Browser `session-a` opened with pid 4123.'),
      output('state loaded'),
      output('navigated to projects'),
      pageResult({
        protocol,
        kind: 'start',
        url: 'https://chatgpt.com/g/g-p-123/project',
        contextMarker: 'context-a',
        projectId: 'g-p-123',
        modelConfirmed: true,
        powerConfirmed: true,
        powerNow: 4,
        powerMin: 0,
        powerMax: 4,
      }),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    const result = await fixture.browser.startTask('task-a', 'session-a', fixture.paths.seedState);

    expect(result).toEqual({
      pid: 4123,
      url: 'https://chatgpt.com/g/g-p-123/project',
      contextMarker: 'context-a',
      projectId: 'g-p-123',
      modelConfirmed: true,
      powerConfirmed: true,
      powerNow: 4,
      powerMin: 0,
      powerMax: 4,
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

describe('BEH-002 fixed Project and GPT-5.6 Sol Power 5/5 start context', () => {
  it('succeeds only in the unique Project blank composer after model and Power readback', async () => {
    const fixture = await executableStartFixture({});
    await writeFile(fixture.paths.seedState, '{}');

    const result = await fixture.browser.startTask('task-a', 'session-a', fixture.paths.seedState);

    expect(result.url).toBe('https://chatgpt.com/g/g-p-123/project');
    expect(result.contextMarker).toBeTruthy();
    expect(result).toMatchObject({
      modelConfirmed: true,
      powerConfirmed: true,
      powerNow: 4,
      powerMin: 0,
      powerMax: 4,
    });
    expect(fixture.events).toEqual([
      'project-row-click',
      'selector-click',
      'power-home',
      'power-arrow-right',
      'power-arrow-right',
      'power-arrow-right',
      'power-arrow-right',
      'opener-click',
      'model-click',
      'selector-click',
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
    const startSource = await lastScript(fixture.invocations);
    expect(startSource).toContain('role="slider"');
    expect(startSource).toContain('aria-valuenow');
    expect(startSource).toContain('Model');
    expectPageFunctionSyntax(startSource);
  });

  it('confirms already selected targets by readback without clicking', async () => {
    const fixture = await executableStartFixture({ powerInitiallyMax: true, modelInitiallyChecked: true });
    await writeFile(fixture.paths.seedState, '{}');

    const result = await fixture.browser.startTask('task-a', 'session-a', fixture.paths.seedState);

    expect(result.contextMarker).toBeTruthy();
    expect(result).toMatchObject({ powerNow: 4, powerMin: 0, powerMax: 4 });
    expect(fixture.events).toEqual(['project-row-click', 'selector-click', 'selector-click']);
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

  it('rejects with FIXED_TARGET_UNAVAILABLE when the Power slider is missing', async () => {
    const fixture = await executableStartFixture({ powerSliderPresent: false });
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

  it('rejects with SELECTION_UNCONFIRMED when the Power keys cannot be read back', async () => {
    const fixture = await executableStartFixture({ powerKeysApplies: false });
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

  it('still selects model and Power when the composer plus menu also declares aria-haspopup', async () => {
    const fixture = await executableStartFixture({ plusMenuTrigger: true });
    await writeFile(fixture.paths.seedState, '{}');

    const result = await fixture.browser.startTask('task-a', 'session-a', fixture.paths.seedState);

    expect(result.url).toBe('https://chatgpt.com/g/g-p-123/project');
    expect(fixture.events).toEqual([
      'project-row-click',
      'selector-click',
      'power-home',
      'power-arrow-right',
      'power-arrow-right',
      'power-arrow-right',
      'power-arrow-right',
      'opener-click',
      'model-click',
      'selector-click',
      'selector-click',
    ]);
    const startSource = await lastScript(fixture.invocations);
    expect(startSource).toContain(
      'form button[aria-haspopup="menu"]:not([data-testid="send-button"]):not([data-testid="composer-plus-btn"])',
    );
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

  it('rejects with SELECTION_UNCONFIRMED when the model selection resets the Power readback', async () => {
    const fixture = await executableStartFixture({ modelClickResetsPower: true });
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await startTaskFailure(fixture);
    expect(failure.code).toBe('SELECTION_UNCONFIRMED');
    expect(failure.message).toContain('jointly read back');
    expect(fixture.invocations.at(-1)?.arguments).toContain('close');
  });
});

describe('BEH-003 first send stays inside the fixed Project composer', () => {
  it('submits a first send only inside the Project blank composer and binds the conversation', async () => {
    const fixture = await executableProjectSendFixture({ initialPathname: '/g/g-p-123/project' });

    const result = await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', []);

    expect(result).toEqual({
      status: 'submitted',
      conversationId: 'new-conversation',
      conversationUrl: 'https://chatgpt.com/g/g-p-123-chatgpt-pro-collab/c/new-conversation',
      userTurnIdentity: 'conversation-turn-1',
    });
    expect(fixture.events).toEqual(['send-click']);
  });

  it('retries the upload menu when the upload action renders late', async () => {
    const fixture = await executableProjectSendFixture({
      initialPathname: '/g/g-p-123/project',
      beforePrepareUpload: (pageFixture) => {
        pageFixture.setUploadMenuDelay(1);
      },
    });
    await writeFile(fixture.paths.seedState, '{}');
    await writeFile(join(fixture.paths.root, 'a.txt'), 'a');

    const result = await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', [
      join(fixture.paths.root, 'a.txt'),
    ]);

    expect(result).toMatchObject({ status: 'submitted' });
    expect(fixture.events).toEqual(['plus-click', 'plus-click', 'upload-click', 'send-click']);
  });

  it('rejects a first send whose page is on the home root before the preflight', async () => {
    const fixture = await executableProjectSendFixture({ initialPathname: '/' });

    const result = await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', []);

    expect(result).toMatchObject({
      status: 'not-submitted',
      error: expect.stringContaining('conversation identity does not match the send target'),
    });
    expect(fixture.events).toEqual([]);
  });

  it('rejects a first send that drifts from the Project composer to home before submission', async () => {
    const fixture = await executableProjectSendFixture({
      initialPathname: '/g/g-p-123/project',
      beforeSubmit: (pageFixture) => {
        pageFixture.setPathname('/');
      },
    });

    const result = await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', []);

    expect(result).toMatchObject({
      status: 'not-submitted',
      error: expect.stringContaining('conversation identity changed before prompt submission'),
    });
    expect(fixture.events).toEqual([]);
  });

  it('rejects a first send that drifts to an existing conversation before submission', async () => {
    const fixture = await executableProjectSendFixture({
      initialPathname: '/g/g-p-123/project',
      beforeSubmit: (pageFixture) => {
        pageFixture.setPathname('/c/other-conversation');
      },
    });

    const result = await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', []);

    expect(result).toMatchObject({
      status: 'not-submitted',
      error: expect.stringContaining('conversation identity changed before prompt submission'),
    });
    expect(fixture.events).toEqual([]);
  });

  it('rejects a first send that drifts to another Project blank composer before submission', async () => {
    const fixture = await executableProjectSendFixture({
      initialPathname: '/g/g-p-123/project',
      beforeSubmit: (pageFixture) => {
        pageFixture.setPathname('/g/g-p-999-other-project/project');
        pageFixture.setProjectTitle('other-project');
      },
    });

    const result = await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', []);

    expect(result).toMatchObject({
      status: 'not-submitted',
      error: expect.stringContaining('chatgpt-pro-collab Project blank composer was not re-verified'),
    });
    expect(fixture.events).toEqual([]);
  });

  it('rejects a first send whose Project composer gains a draft before submission', async () => {
    const fixture = await executableProjectSendFixture({
      initialPathname: '/g/g-p-123/project',
      beforeSubmit: (pageFixture) => {
        pageFixture.setComposerText('stale draft');
      },
    });

    const result = await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', []);

    expect(result).toMatchObject({
      status: 'not-submitted',
      error: expect.stringContaining('chatgpt-pro-collab'),
    });
    expect(fixture.events).toEqual([]);
  });

  it('rejects a first send whose Project composer gains conversation turns before submission', async () => {
    const fixture = await executableProjectSendFixture({
      initialPathname: '/g/g-p-123/project',
      beforeSubmit: (pageFixture) => {
        pageFixture.setUserTurnCount(1);
      },
    });

    const result = await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', []);

    expect(result).toMatchObject({
      status: 'not-submitted',
      error: expect.stringContaining('chatgpt-pro-collab'),
    });
    expect(fixture.events).toEqual([]);
  });
});

describe('BEH-003 and BEH-013 unbound draft cleanup re-proves the fixed Project identity', () => {
  it('clears an unbound draft only after re-proving the fixed Project blank composer', async () => {
    const fixture = await executableProjectSendFixture({ initialPathname: '/g/g-p-123/project' });

    await expect(fixture.browser.cleanSendComposer('task-a', 'session-a', null, [])).resolves.toBeUndefined();

    const cleanupSource = await lastScript(fixture.invocations);
    expect(cleanupSource).toContain('page.waitForFunction((target) => {');
    expect(cleanupSource).toContain('element.textContent.trim() === target');
    expect(cleanupSource).toContain("'chatgpt-pro-collab'");
    expect(cleanupSource).toContain("kind: 'draft-cleared'");
  });

  it('rejects unbound cleanup when the page drifted to another Project blank composer', async () => {
    const fixture = await executableProjectSendFixture({
      initialPathname: '/g/g-p-123/project',
      beforeCleanup: (pageFixture) => {
        pageFixture.setPathname('/g/g-p-999-other-project/project');
        pageFixture.setProjectTitle('other-project');
      },
    });

    await expect(fixture.browser.cleanSendComposer('task-a', 'session-a', null, [])).rejects.toMatchObject({
      code: 'PLAYWRIGHT_CONTRACT_DRIFT',
      message: expect.stringContaining('fixture waitForFunction deadline exceeded'),
    });
  });

  it('clears a bound draft without re-proving the Project title', async () => {
    const fixture = await executableProjectSendFixture({
      initialPathname: '/c/conversation-a',
      beforeCleanup: (pageFixture) => {
        pageFixture.setProjectTitle('other-project');
      },
    });

    await expect(
      fixture.browser.cleanSendComposer('task-a', 'session-a', 'conversation-a', []),
    ).resolves.toBeUndefined();

    const cleanupSource = await lastScript(fixture.invocations);
    expect(cleanupSource).toContain('const expectedConversationId = "conversation-a"');
    expect(cleanupSource).toContain("kind: 'draft-cleared'");
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
        userTurnIdentity: 'conversation-turn-1',
      }),
    ]);

    const result = await fixture.browser.send('task-a', 'session-a', null, 'exact prompt', ['/tmp/a', '/tmp/b']);

    expect(result).toEqual({
      status: 'submitted',
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
      userTurnIdentity: 'conversation-turn-1',
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

  it('accepts an empty upload-preparation handoff when the following upload succeeds and submits exactly once', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      output(''),
      output('first uploaded'),
      pageResult({
        protocol,
        kind: 'send',
        status: 'submitted',
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
        userTurnIdentity: 'conversation-turn-1',
      }),
    ]);

    const result = await fixture.browser.send('task-a', 'session-a', 'conversation-a', 'exact prompt', [
      '/tmp/attachment.txt',
    ]);

    expect(result).toEqual({
      status: 'submitted',
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
      userTurnIdentity: 'conversation-turn-1',
    });
    const uploads = fixture.invocations.filter((invocation) => {
      return invocation.arguments.includes('upload');
    });
    expect(uploads).toHaveLength(1);
    const sendSource = await lastScript(fixture.invocations);
    expect(sendSource).toContain('exact prompt');
  });

  it('fails the pre-submit path when a handoff upload returns a fixed-CLI tool error', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      output(''),
      output('### Error\nError: No file chooser visible'),
      pageResult({ protocol, kind: 'draft-cleared' }),
    ]);

    await expect(
      fixture.browser.send('task-a', 'session-a', 'conversation-a', 'exact prompt', ['/tmp/attachment.txt']),
    ).resolves.toEqual({
      status: 'not-submitted',
      error: expect.stringContaining('Error: No file chooser visible'),
    });
    const commands = fixture.invocations.map((invocation) => {
      return invocation.arguments.slice(4);
    });
    expect(commands).toEqual([
      ['run-code', '--filename', expect.any(String)],
      ['run-code', '--filename', expect.any(String)],
      ['upload', '/tmp/attachment.txt'],
      ['run-code', '--filename', expect.any(String)],
    ]);
    const cleanupSource = await lastScript(fixture.invocations);
    expect(cleanupSource).toContain("page.reload({ waitUntil: 'domcontentloaded' })");
    expect(cleanupSource).toContain('attachment draft remained after reload');
  });

  it('treats a bare Error: upload result as an explicit fixed-CLI tool error', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      output(''),
      output('Error: No file chooser visible'),
      pageResult({ protocol, kind: 'draft-cleared' }),
    ]);

    await expect(
      fixture.browser.send('task-a', 'session-a', 'conversation-a', 'exact prompt', ['/tmp/attachment.txt']),
    ).resolves.toEqual({
      status: 'not-submitted',
      error: expect.stringContaining('No file chooser visible'),
    });
  });

  it('keeps the upload error and a blocked cleanup error distinguishable', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      output(''),
      output('### Error\nError: No file chooser visible'),
      output('### Error\nError: modal guard blocked draft clearing'),
    ]);

    const result = await fixture.browser.send('task-a', 'session-a', 'conversation-a', 'exact prompt', [
      '/tmp/attachment.txt',
    ]);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'unsafe-not-submitted',
        error: expect.stringContaining('Error: No file chooser visible'),
      }),
    );
    if (result.status === 'unsafe-not-submitted') {
      expect(result.error).toContain('attachment cleanup failed');
      expect(result.error).toContain('modal guard blocked draft clearing');
    }
  });

  it('keeps non-empty malformed preparation output a contract drift with bounded detail', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      output('{"protocol":"chatgpt-pro-collab/v1","kind":"send"}'),
      pageResult({ protocol, kind: 'draft-cleared' }),
    ]);

    const result = await fixture.browser.send('task-a', 'session-a', 'conversation-a', 'exact prompt', [
      '/tmp/attachment.txt',
    ]);

    expect(result).toEqual({
      status: 'not-submitted',
      error: expect.stringContaining('protocol envelope was not present'),
    });
    if (result.status === 'not-submitted') {
      expect(result.error).toContain('"kind":"send"');
    }
  });

  it('fails the pre-submit path when a normal upload reports a fixed-CLI tool error', async () => {
    const fixture = await browserFixture([
      pageResult({ protocol, kind: 'send-ready' }),
      pageResult({ protocol, kind: 'upload-ready' }),
      output('### Error\nError: No file chooser visible'),
      pageResult({ protocol, kind: 'draft-cleared' }),
    ]);

    await expect(
      fixture.browser.send('task-a', 'session-a', 'conversation-a', 'exact prompt', ['/tmp/attachment.txt']),
    ).resolves.toEqual({
      status: 'not-submitted',
      error: expect.stringContaining('No file chooser visible'),
    });
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

    const observed = await fixture.browser.observeResponse(
      'task-a',
      'session-a',
      'conversation-a',
      'conversation-turn-user',
      5000,
    );
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

    await expect(
      fixture.browser.observeResponse('task-a', 'session-a', 'conversation-a', 'conversation-turn-user', 5000),
    ).resolves.toEqual({
      status: 'completed',
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
      assistantTurnId: 'conversation-turn-t1',
    });
    expect(fixture.events).toHaveLength(7);
  });

  it('returns pending without reload when Stop remains visible', async () => {
    const fixture = await executableCompletionFixture({ stopVisible: true });

    await expect(
      fixture.browser.observeResponse('task-a', 'session-a', 'conversation-a', 'conversation-turn-user', 5000),
    ).resolves.toEqual({
      status: 'pending',
    });
    expect(fixture.events).toHaveLength(11);
  });

  it('rejects a missing or non-unique user turn anchor without falling back to the latest user', async () => {
    const fixture = await executableCompletionFixture({ stopVisible: false });

    await expect(
      fixture.browser.observeResponse('task-a', 'session-a', 'conversation-a', 'unknown-anchor', 5000),
    ).rejects.toThrow(/persisted user turn anchor is absent or not unique/);
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

  it('maps a same-name target to its artifact row even when a duplicate occurrence sits between them', async () => {
    const firstSource = 'sandbox:/mnt/data/a/readme.txt';
    const secondSource = 'sandbox:/mnt/data/b/readme.txt';
    const fixture = await executableBrowserFixture({
      responseHtml: [
        '<a href="sandbox:/mnt/data/report.html">report</a>',
        '<a href="sandbox:/mnt/data/archive.zip">archive</a>',
        '<a href="sandbox:/mnt/data/image.png">image</a>',
        '<a href="sandbox:/mnt/data/main.py">main</a>',
        `<a href="${firstSource}">first</a>`,
        `<a href="${firstSource}">first again</a>`,
        `<a href="${secondSource}">second</a>`,
      ].join(''),
      behaviorButtonCount: 7,
      artifactRows: ['report.html', 'archive.zip', 'image.png', 'main.py', 'readme.txt', 'readme.txt'],
      suggestedFilename: 'readme.txt',
      directDownloadDisabled: true,
    });
    const temporaryPath = join(fixture.root, 'second-readme.tmp');

    await expect(
      fixture.browser.downloadArtifact(
        'task-a',
        'session-a',
        'conversation-a',
        [
          'sandbox:/mnt/data/report.html',
          'sandbox:/mnt/data/archive.zip',
          'sandbox:/mnt/data/image.png',
          'sandbox:/mnt/data/main.py',
          firstSource,
          secondSource,
        ],
        secondSource,
        temporaryPath,
        5000,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ sourceUrl: secondSource, suggestedFilename: 'readme.txt' });
    expect(fixture.events).toContain('download:artifact');
    expect(
      fixture.events.some((event) => {
        return event === 'download:direct';
      }),
    ).toBe(false);
    await expect(readFile(temporaryPath, 'utf8')).resolves.toBe('downloaded readme.txt');
  });

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
    store.markTurnPending('task-a', 'turn-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a', 'user-turn-a');
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
    store.markTurnPending('task-a', 'turn-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a', 'user-turn-a');
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

describe('BEH-013 browser boundary support', () => {
  it('classifies the global session listing deterministically', async () => {
    const fixture = await browserFixture([output('  (no browsers)\n')]);
    await expect(fixture.browser.sessionAvailability('session-a')).resolves.toBe('missing');
    expect(fixture.invocations[0]?.arguments).toEqual(['-y', '@playwright/cli@0.1.17', '--raw', 'list']);

    const openFixture = await browserFixture([
      output(`Sessions:\n  - name: session-a\n    state: open\n    pid: 4123\n`),
    ]);
    await expect(openFixture.browser.sessionAvailability('session-a')).resolves.toBe('available');

    const absentFixture = await browserFixture([output('Sessions:\n  - name: other\n    state: open\n')]);
    await expect(absentFixture.browser.sessionAvailability('session-a')).resolves.toBe('missing');

    const failingFixture = await browserFixture([new Error('cli unavailable')]);
    await expect(failingFixture.browser.sessionAvailability('session-a')).resolves.toBe('unknown');
  });

  it('rebuilds a session without opening when the named session already exists', async () => {
    await writeFile(join((await browserFixture([])).paths.seedState), '{}');
    const fixture = await browserFixture([
      output('Sessions:\n  - name: session-a\n    state: open\n    pid: 4123\n'),
      output('navigated to projects'),
      pageResult({
        protocol,
        kind: 'start',
        url: 'https://chatgpt.com/g/g-p-123/project',
        contextMarker: 'ctx',
        projectId: 'g-p-123',
        modelConfirmed: true,
        powerConfirmed: true,
        powerNow: 4,
        powerMin: 0,
        powerMax: 4,
      }),
      output('Sessions:\n  - name: session-a\n    state: open\n    pid: 4123\n'),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    const result = await fixture.browser.startTask('task-a', 'session-a', fixture.paths.seedState, true);

    expect(result).toEqual({
      pid: 4123,
      url: 'https://chatgpt.com/g/g-p-123/project',
      contextMarker: 'ctx',
      projectId: 'g-p-123',
      modelConfirmed: true,
      powerConfirmed: true,
      powerNow: 4,
      powerMin: 0,
      powerMax: 4,
      persistent: false,
    });
    expect(
      fixture.invocations.flatMap((invocation) => {
        return invocation.arguments;
      }),
    ).not.toContain('open');
    expect(
      fixture.invocations.flatMap((invocation) => {
        return invocation.arguments;
      }),
    ).not.toContain('state-load');
  });

  it('verifies a rebuilt session against the recorded canonical conversation', async () => {
    const fixture = await browserFixture([
      pageResult({
        protocol,
        kind: 'recover-conversation',
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
      }),
    ]);

    const result = await fixture.browser.recoverConversation(
      'task-a',
      'session-a',
      'https://chatgpt.com/c/conversation-a',
      'conversation-a',
    );

    expect(result).toEqual({
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
    });
    const source = await lastScript(fixture.invocations);
    expect(source).toContain('recover-conversation');
    expect(source).toContain('conversation-a');
    expectPageFunctionSyntax(source);
  });

  it('closes a reused session when the start context fails definitely', async () => {
    const fixture = await browserFixture([
      output('Sessions:\n  - name: session-a\n    state: open\n    pid: 4123\n'),
      output('navigated to projects'),
      pageResult({
        protocol,
        kind: 'start-failed',
        errorCode: 'PROJECT_NOT_FOUND',
        message: 'no Project exactly named chatgpt-pro-collab was found',
      }),
      output('closed'),
    ]);
    await writeFile(fixture.paths.seedState, '{}');

    const failure = await fixture.browser
      .startTask('task-a', 'session-a', fixture.paths.seedState, true)
      .then(() => {
        throw new Error('start unexpectedly succeeded');
      })
      .catch((error: unknown) => {
        return error;
      });
    const typed = failure as Error & { readonly code?: string };
    expect(typed.code).toBe('PROJECT_NOT_FOUND');
    const flat = fixture.invocations.flatMap((invocation) => {
      return invocation.arguments;
    });
    expect(flat).not.toContain('open');
    expect(flat).toContain('close');
    expect(flat).not.toContain('state-load');
  });

  it('generates the submitted adjudication verification with prompt and attachment matching', async () => {
    const fixture = await browserFixture([
      pageResult({
        protocol,
        kind: 'resolve-submitted',
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
        userTurnIdentity: 'conversation-turn-2',
      }),
    ]);

    const result = await fixture.browser.resolveSubmittedConversation(
      'task-a',
      'session-a',
      'https://chatgpt.com/c/conversation-a',
      'conversation-a',
      'g-p-123',
      'conversation-turn-1',
      'exact prompt',
      ['a.txt'],
    );

    expect(result).toEqual({
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
      userTurnIdentity: 'conversation-turn-2',
    });
    const source = await lastScript(fixture.invocations);
    expect(source).toContain('chatgpt-pro-collab');
    expect(source).toContain('exact prompt');
    expect(source).toContain('a.txt');
    expect(source).toContain('previousUserTurnIdentity');
    expectPageFunctionSyntax(source);
  });

  it('generates the not-submitted safe-composer verification for bound and unbound tasks', async () => {
    const fixture = await browserFixture([pageResult({ protocol, kind: 'resolve-not-submitted' })]);

    await fixture.browser.verifySafeComposer('task-a', 'session-a', null, null, null, 'not sent', []);
    const source = await lastScript(fixture.invocations);
    expect(source).toContain('chatgpt-pro-collab');
    expect(source).toContain('resolve-not-submitted');
    expectPageFunctionSyntax(source);
  });

  it('generates the failed-response resolution verification for the persisted target turn', async () => {
    const fixture = await browserFixture([
      pageResult({
        protocol,
        kind: 'resolve-failed-turn',
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
        userTurnIdentity: 'conversation-turn-2',
        stop: 'absent',
      }),
    ]);

    const result = await fixture.browser.resolveFailedTurn(
      'task-a',
      'session-a',
      'conversation-a',
      'conversation-turn-2',
    );

    expect(result).toEqual({
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
      userTurnIdentity: 'conversation-turn-2',
      stop: 'absent',
    });
    const source = await lastScript(fixture.invocations);
    expect(source).toContain('resolve-failed-turn');
    expect(source).toContain('conversation-a');
    expect(source).toContain('conversation-turn-2');
    expect(source).toContain("name: 'Stop answering', exact: true");
    expect(source).toContain('target user turn is absent or not unique');
    expect(source).toContain('a later user turn exists after the target');
    expect(source).toContain('composer still contains draft text before failed-response resolution');
    expect(source).toContain('composer still has a populated file input before failed-response resolution');
    expect(source).toContain('composer still shows staged attachment chips before failed-response resolution');
    expect(source).toContain('Stop answering did not disappear after one click');
    expectPageFunctionSyntax(source);
  });

  it('rejects a resolve-failed-turn result whose identity or fields drifted', async () => {
    const driftFixture = await browserFixture([
      pageResult({
        protocol,
        kind: 'resolve-failed-turn',
        conversationId: 'conversation-other',
        conversationUrl: 'https://chatgpt.com/c/conversation-other',
        userTurnIdentity: 'conversation-turn-2',
        stop: 'absent',
      }),
    ]);
    await expect(
      driftFixture.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-2'),
    ).rejects.toMatchObject({ code: 'BROWSER_PROTOCOL_ERROR' });

    const missingFixture = await browserFixture([pageResult({ protocol, kind: 'resolve-failed-turn' })]);
    await expect(
      missingFixture.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-2'),
    ).rejects.toMatchObject({ code: 'BROWSER_PROTOCOL_ERROR' });
  });

  it('executes the failed-response resolution while Stop is absent', async () => {
    const fixture = await executableResolveTurnFixture({
      pathname: '/c/conversation-a',
      targetUserTurnId: 'conversation-turn-user',
      turns: [
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
      ],
      stopVisible: false,
    });

    await expect(
      fixture.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-user'),
    ).resolves.toEqual({
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
      userTurnIdentity: 'conversation-turn-user',
      stop: 'absent',
    });
    expect(fixture.events).toContain('stop:count');
    expect(fixture.events).not.toContain('stop:click');
  });

  it('clicks a visible Stop answering exactly once and verifies its disappearance', async () => {
    const fixture = await executableResolveTurnFixture({
      pathname: '/c/conversation-a',
      targetUserTurnId: 'conversation-turn-user',
      turns: [
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
      ],
      stopVisible: true,
      stopDisappears: true,
    });

    await expect(
      fixture.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-user'),
    ).resolves.toEqual({
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
      userTurnIdentity: 'conversation-turn-user',
      stop: 'stopped',
    });
    expect(
      fixture.events.filter((event) => {
        return event === 'stop:click';
      }),
    ).toHaveLength(1);
  });

  it('keeps the resolution failed when Stop stays visible after one click', async () => {
    const fixture = await executableResolveTurnFixture({
      pathname: '/c/conversation-a',
      targetUserTurnId: 'conversation-turn-user',
      turns: [
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
      ],
      stopVisible: true,
      stopDisappears: false,
    });

    await expect(
      fixture.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-user'),
    ).rejects.toThrow(/Stop answering did not disappear after one click/);
    expect(
      fixture.events.filter((event) => {
        return event === 'stop:click';
      }),
    ).toHaveLength(1);
  });

  it('rejects a non-unique visible Stop answering without clicking', async () => {
    const fixture = await executableResolveTurnFixture({
      pathname: '/c/conversation-a',
      targetUserTurnId: 'conversation-turn-user',
      turns: [
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
      ],
      stopVisible: true,
      stopCount: 2,
    });

    await expect(
      fixture.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-user'),
    ).rejects.toThrow(/Stop answering is not unique/);
    expect(fixture.events).not.toContain('stop:click');
  });

  it('rejects a later user turn after the target as identity drift', async () => {
    const fixture = await executableResolveTurnFixture({
      pathname: '/c/conversation-a',
      targetUserTurnId: 'conversation-turn-user',
      turns: [
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
        { testId: 'conversation-turn-later', turn: 'user' },
      ],
    });

    await expect(
      fixture.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-user'),
    ).rejects.toThrow(/a later user turn exists after the target/);
  });

  it('rejects an absent or duplicated target user turn', async () => {
    const absent = await executableResolveTurnFixture({
      pathname: '/c/conversation-a',
      targetUserTurnId: 'conversation-turn-missing',
      turns: [
        { testId: 'conversation-turn-other', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
      ],
    });
    await expect(
      absent.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-missing'),
    ).rejects.toMatchObject({ code: 'PLAYWRIGHT_CONTRACT_DRIFT' });

    const duplicated = await executableResolveTurnFixture({
      pathname: '/c/conversation-a',
      targetUserTurnId: 'conversation-turn-user',
      turns: [
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
      ],
    });
    await expect(
      duplicated.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-user'),
    ).rejects.toThrow(/target user turn is absent or not unique/);
  });

  it('rejects a composer with draft text, staged files, or attachment controls', async () => {
    const draft = await executableResolveTurnFixture({
      pathname: '/c/conversation-a',
      targetUserTurnId: 'conversation-turn-user',
      turns: [
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
      ],
      composerText: 'stale draft',
    });
    await expect(
      draft.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-user'),
    ).rejects.toThrow(/composer still contains draft text/);

    const stagedFile = await executableResolveTurnFixture({
      pathname: '/c/conversation-a',
      targetUserTurnId: 'conversation-turn-user',
      turns: [
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
      ],
      populatedFileInputCount: 1,
    });
    await expect(
      stagedFile.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-user'),
    ).rejects.toThrow(/populated file input/);

    const stagedChip = await executableResolveTurnFixture({
      pathname: '/c/conversation-a',
      targetUserTurnId: 'conversation-turn-user',
      turns: [
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
      ],
      attachmentControlCount: 1,
    });
    await expect(
      stagedChip.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-user'),
    ).rejects.toThrow(/staged attachment chips/);
  });

  it('rejects a drifted conversation identity before touching the composer', async () => {
    const fixture = await executableResolveTurnFixture({
      pathname: '/c/conversation-other',
      targetUserTurnId: 'conversation-turn-user',
      turns: [
        { testId: 'conversation-turn-user', turn: 'user' },
        { testId: 'conversation-turn-assistant', turn: 'assistant' },
      ],
    });

    await expect(
      fixture.browser.resolveFailedTurn('task-a', 'session-a', 'conversation-a', 'conversation-turn-user'),
    ).rejects.toThrow(/conversation identity does not match the failed-response turn/);
    expect(fixture.events).not.toContain('stop:click');
  });
});

describe('BEH-003 and BEH-013 submission verification against page evidence', () => {
  it('matches a first user turn whose prompt and ordered attachment chips match', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        {
          testId: 'conversation-turn-1',
          turn: 'user',
          promptText: 'analyze this',
          chips: ['a.txt', 'b.txt'],
        },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: 'conversation-a',
      previousUserTurnIdentity: null,
      prompt: 'analyze this',
      attachmentNames: ['a.txt', 'b.txt'],
      expectKind: 'auto-verify-submission',
    });

    expect(verified).toMatchObject({ status: 'submitted', userTurnIdentity: 'conversation-turn-1' });
  });

  it('does not match when the prompt matches but attachment chips are out of order', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        {
          testId: 'conversation-turn-1',
          turn: 'user',
          promptText: 'analyze this',
          chips: ['b.txt', 'a.txt'],
        },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: 'conversation-a',
      previousUserTurnIdentity: null,
      prompt: 'analyze this',
      attachmentNames: ['a.txt', 'b.txt'],
      expectKind: 'auto-verify-submission',
    });

    expect(verified).toMatchObject({ status: 'unresolved' });
  });

  it('does not match when a duplicate basename chip is missing', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        {
          testId: 'conversation-turn-1',
          turn: 'user',
          promptText: 'analyze this',
          chips: ['a.txt', 'a.txt'],
        },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: 'conversation-a',
      previousUserTurnIdentity: null,
      prompt: 'analyze this',
      attachmentNames: ['a.txt', 'a.txt', 'a.txt'],
      expectKind: 'auto-verify-submission',
    });

    expect(verified).toMatchObject({ status: 'unresolved' });
  });

  it('requires a first-turn candidate to be the first user turn in the conversation', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        { testId: 'conversation-turn-1', turn: 'user', promptText: 'earlier unrelated' },
        { testId: 'conversation-turn-2', turn: 'assistant' },
        { testId: 'conversation-turn-3', turn: 'user', promptText: 'exact prompt' },
        { testId: 'conversation-turn-4', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: 'conversation-a',
      previousUserTurnIdentity: null,
      prompt: 'exact prompt',
      attachmentNames: [],
      expectKind: 'auto-verify-submission',
    });

    expect(verified).toMatchObject({ status: 'unresolved' });
  });

  it('matches a non-first turn only after the persisted previous user turn anchor', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        { testId: 'conversation-turn-1', turn: 'user', promptText: 'first' },
        { testId: 'conversation-turn-2', turn: 'assistant' },
        { testId: 'conversation-turn-3', turn: 'user', promptText: 'exact prompt' },
        { testId: 'conversation-turn-4', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: 'conversation-a',
      previousUserTurnIdentity: 'conversation-turn-1',
      prompt: 'exact prompt',
      attachmentNames: [],
      expectKind: 'auto-verify-submission',
    });

    expect(verified).toMatchObject({ status: 'submitted', userTurnIdentity: 'conversation-turn-3' });
  });

  it('rejects a submitted adjudication for a conversation outside the recorded Project', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-other/c/conversation-a',
      turns: [
        { testId: 'conversation-turn-1', turn: 'user', promptText: 'exact prompt' },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    await expect(
      runSubmissionScript(fixture.page, {
        canonicalUrl: 'https://chatgpt.com/c/conversation-a',
        conversationId: 'conversation-a',
        projectIdentity: '123',
        previousUserTurnIdentity: null,
        prompt: 'exact prompt',
        attachmentNames: [],
        expectKind: 'resolve-submitted',
      }),
    ).rejects.toThrow(/fixture waitForFunction deadline exceeded/);
  });

  it('accepts a submitted adjudication for the recorded Project conversation', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      mainTitle: 'chatgpt-pro-collab',
      turns: [
        { testId: 'conversation-turn-1', turn: 'user', promptText: 'exact prompt' },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      canonicalUrl: 'https://chatgpt.com/c/conversation-a',
      conversationId: 'conversation-a',
      projectIdentity: '123',
      previousUserTurnIdentity: null,
      prompt: 'exact prompt',
      attachmentNames: [],
      expectKind: 'resolve-submitted',
    });

    expect(verified).toMatchObject({ conversationId: 'conversation-a', userTurnIdentity: 'conversation-turn-1' });
  });

  it('rejects a not-submitted adjudication while the composer still holds the prompt text', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      composerText: 'draft prompt',
      turns: [],
    });

    await expect(
      runSubmissionScript(fixture.page, {
        conversationId: 'conversation-a',
        previousUserTurnIdentity: null,
        prompt: 'exact prompt',
        attachmentNames: [],
        expectKind: 'resolve-not-submitted',
      }),
    ).rejects.toThrow(/composer still contains draft text/);
  });

  it('rejects a not-submitted adjudication while a staged attachment chip is visible', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      composerChips: ['a.txt'],
      turns: [],
    });

    await expect(
      runSubmissionScript(fixture.page, {
        conversationId: 'conversation-a',
        previousUserTurnIdentity: null,
        prompt: 'exact prompt',
        attachmentNames: ['a.txt'],
        expectKind: 'resolve-not-submitted',
      }),
    ).rejects.toThrow(/staged attachment chips/);
  });

  it('accepts a not-submitted adjudication with a residue-free bound composer', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        { testId: 'conversation-turn-1', turn: 'user', promptText: 'exact prompt' },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: 'conversation-a',
      previousUserTurnIdentity: null,
      prompt: 'different prompt',
      attachmentNames: [],
      expectKind: 'resolve-not-submitted',
    });

    expect(verified).toMatchObject({ kind: 'resolve-not-submitted' });
  });

  it('does not claim a verbatim match when the page trimmed leading and trailing whitespace', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        { testId: 'conversation-turn-1', turn: 'user', promptText: 'exact prompt' },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: 'conversation-a',
      previousUserTurnIdentity: null,
      prompt: '  exact prompt  ',
      attachmentNames: [],
      expectKind: 'auto-verify-submission',
    });

    expect(verified).toMatchObject({ status: 'unresolved' });
  });

  it('rejects a submitted adjudication whose page prompt differs by surrounding whitespace', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        { testId: 'conversation-turn-1', turn: 'user', promptText: 'exact prompt' },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    await expect(
      runSubmissionScript(fixture.page, {
        canonicalUrl: 'https://chatgpt.com/c/conversation-a',
        conversationId: 'conversation-a',
        projectIdentity: '123',
        previousUserTurnIdentity: null,
        prompt: '  exact prompt  ',
        attachmentNames: [],
        expectKind: 'resolve-submitted',
      }),
    ).rejects.toThrow(/exactly one matching user turn/);
  });

  it('rejects an unbound not-submitted adjudication on a different Project', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-other/project',
      turns: [],
    });

    await expect(
      runSubmissionScript(fixture.page, {
        conversationId: null,
        projectIdentity: '123',
        previousUserTurnIdentity: null,
        prompt: 'exact prompt',
        attachmentNames: [],
        expectKind: 'resolve-not-submitted',
      }),
    ).rejects.toThrow(/fixture waitForFunction deadline exceeded/);
  });

  it('rejects an unbound not-submitted adjudication with a renamed staged attachment chip', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123/project',
      composerChips: ['renamed(1).txt'],
      turns: [],
    });

    await expect(
      runSubmissionScript(fixture.page, {
        conversationId: null,
        projectIdentity: '123',
        previousUserTurnIdentity: null,
        prompt: 'exact prompt',
        attachmentNames: ['beta.txt'],
        expectKind: 'resolve-not-submitted',
      }),
    ).rejects.toThrow(/staged attachment chips/);
  });

  it('rejects an unbound not-submitted adjudication while Stop answering is visible', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123/project',
      stopVisible: true,
      turns: [],
    });

    await expect(
      runSubmissionScript(fixture.page, {
        conversationId: null,
        projectIdentity: '123',
        previousUserTurnIdentity: null,
        prompt: 'exact prompt',
        attachmentNames: [],
        expectKind: 'resolve-not-submitted',
      }),
    ).rejects.toThrow(/in-flight submission state/);
  });

  it('accepts an unbound not-submitted adjudication only on the recorded Project with a clean composer', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123/project',
      turns: [],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: null,
      projectIdentity: '123',
      previousUserTurnIdentity: null,
      prompt: 'exact prompt',
      attachmentNames: [],
      expectKind: 'resolve-not-submitted',
    });

    expect(verified).toMatchObject({ kind: 'resolve-not-submitted' });
  });

  it('passes the recorded Project identity as a serialized waitForFunction argument, not a closure', async () => {
    const captured = await captureSubmissionScript('resolve-not-submitted', {
      conversationId: null,
      projectIdentity: '123',
      previousUserTurnIdentity: null,
      prompt: 'exact prompt',
      attachmentNames: [],
    });

    const waitCall = captured.slice(captured.indexOf('page.waitForFunction'));
    expect(waitCall).toContain('(identity) =>');
    expect(waitCall).toContain('const projectPathOk = (expectedIdentity) => {');
    expect(waitCall).toContain('projectPathOk(identity)');
    expect(waitCall).toContain('}, expectedProjectIdentity, { timeout: 60000, polling: 250 });');
    expect(captured).not.toMatch(/projectPathOk\(\)/u);
    expectPageFunctionSyntax(captured);
  });

  it('rejects every staged attachment chip shape by its remove-control structure, not its file name', async () => {
    for (const chip of ['LICENSE(1)', 'LICENSE', 'a.report-archive-config', '报告.pdf']) {
      const fixture = submissionPageFixture({
        pathname: '/g/g-p-123/project',
        composerChips: [chip],
        turns: [],
      });

      await expect(
        runSubmissionScript(fixture.page, {
          conversationId: null,
          projectIdentity: '123',
          previousUserTurnIdentity: null,
          prompt: 'exact prompt',
          attachmentNames: ['LICENSE'],
          expectKind: 'resolve-not-submitted',
        }),
      ).rejects.toThrow(/staged attachment chips/);
    }
  });

  it('does not bind a user turn whose body is the literal heading text when the saved prompt is empty', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        {
          testId: 'conversation-turn-1',
          turn: 'user',
          promptText: 'You said:',
          chips: ['a.txt'],
        },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: 'conversation-a',
      previousUserTurnIdentity: null,
      prompt: '',
      attachmentNames: ['a.txt'],
      expectKind: 'auto-verify-submission',
    });

    expect(verified).toMatchObject({ status: 'unresolved' });
  });

  it('keeps a literal You said: prompt verbatim instead of excluding it as the accessible heading', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        {
          testId: 'conversation-turn-1',
          turn: 'user',
          promptText: 'You said:',
        },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: 'conversation-a',
      previousUserTurnIdentity: null,
      prompt: 'You said:',
      attachmentNames: [],
      expectKind: 'auto-verify-submission',
    });

    expect(verified).toMatchObject({ status: 'submitted', userTurnIdentity: 'conversation-turn-1' });
  });

  it('distinguishes the accessible You said: heading from an ordinary prompt leaf', async () => {
    const fixture = submissionPageFixture({
      pathname: '/g/g-p-123-chatgpt-pro-collab/c/conversation-a',
      turns: [
        {
          testId: 'conversation-turn-1',
          turn: 'user',
          promptText: 'analyze this',
        },
        { testId: 'conversation-turn-2', turn: 'assistant' },
      ],
    });

    const verified = await runSubmissionScript(fixture.page, {
      conversationId: 'conversation-a',
      previousUserTurnIdentity: null,
      prompt: 'analyze this',
      attachmentNames: [],
      expectKind: 'auto-verify-submission',
    });

    expect(verified).toMatchObject({ status: 'submitted', userTurnIdentity: 'conversation-turn-1' });
  });
});

/**
 * Captures the generated submission script source and executes it against the fixture page.
 *
 * @param page Submission page fixture.
 * @param options Script parameters and expected protocol kind.
 * @returns The decoded protocol result.
 * @throws {Error} If the generated script or fixture execution fails.
 */
async function runSubmissionScript(
  page: object,
  options: {
    readonly canonicalUrl?: string;
    readonly conversationId: string | null;
    readonly projectIdentity?: string | null;
    readonly previousUserTurnIdentity: string | null;
    readonly prompt: string;
    readonly attachmentNames: readonly string[];
    readonly expectKind: 'auto-verify-submission' | 'resolve-submitted' | 'resolve-not-submitted';
  },
): Promise<Record<string, unknown>> {
  const captured = await captureSubmissionScript(options.expectKind, options);
  const runPageFunction = new Function(`return (${captured})`)() as (page: object) => Promise<string>;
  const result = await runPageFunction(page);
  if (typeof result !== 'string') {
    throw new TypeError('submission script did not return a JSON string');
  }
  return JSON.parse(result) as Record<string, unknown>;
}

/**
 * Captures the generated submission script source via a deterministic runner.
 *
 * @param kind Submission script kind.
 * @param options Script parameters.
 * @returns The generated page function source.
 * @throws {Error} If no run-code script was produced.
 */
async function captureSubmissionScript(
  kind: 'auto-verify-submission' | 'resolve-submitted' | 'resolve-not-submitted',
  options: {
    readonly canonicalUrl?: string;
    readonly conversationId: string | null;
    readonly projectIdentity?: string | null;
    readonly previousUserTurnIdentity: string | null;
    readonly prompt: string;
    readonly attachmentNames: readonly string[];
  },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'collab-submission-capture-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  const invocations: BrowserCommandInvocation[] = [];
  const browser = new PlaywrightBrowser(paths, root, async (invocation) => {
    invocations.push(invocation);
    let result: { readonly protocol: string; readonly kind: string; [key: string]: unknown };
    if (kind === 'auto-verify-submission') {
      result = { protocol, kind, status: 'unresolved', error: 'fixture capture' };
    } else if (kind === 'resolve-submitted') {
      result = {
        protocol,
        kind,
        conversationId: 'conversation-a',
        conversationUrl: 'https://chatgpt.com/c/conversation-a',
        userTurnIdentity: 'conversation-turn-1',
      };
    } else {
      result = { protocol, kind };
    }
    return output(`### Ran Playwright code\n${JSON.stringify(JSON.stringify(result))}\n`);
  });
  if (kind === 'auto-verify-submission') {
    await browser.autoVerifySubmission(
      'task-a',
      'session-a',
      options.conversationId,
      options.projectIdentity ?? null,
      options.previousUserTurnIdentity,
      options.prompt,
      options.attachmentNames,
    );
  } else if (kind === 'resolve-submitted') {
    await browser.resolveSubmittedConversation(
      'task-a',
      'session-a',
      options.canonicalUrl ?? 'https://chatgpt.com/c/conversation-a',
      options.conversationId,
      options.projectIdentity ?? null,
      options.previousUserTurnIdentity,
      options.prompt,
      options.attachmentNames,
    );
  } else {
    await browser.verifySafeComposer(
      'task-a',
      'session-a',
      options.conversationId,
      options.projectIdentity ?? null,
      options.previousUserTurnIdentity,
      options.prompt,
      options.attachmentNames,
    );
  }
  return lastScript(invocations);
}

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
  expectNoProjectModifyEvents(fixture.events);
  return typed;
}

/**
 * Asserts that a start fixture never touched Project create, options, or modify controls.
 *
 * @param events Ordered fixture events.
 * @throws {Error} If any Project-modifying control event was recorded.
 */
function expectNoProjectModifyEvents(events: readonly string[]): void {
  expect(events).not.toContain('project-create-click');
  expect(events).not.toContain('project-options-click');
}

/**
 * Creates a browser runner that executes the generated send boundary scripts against a
 * mutable Project composer fixture, allowing interleaved drift between commands.
 *
 * The wrapped page adds the `reload` and filtered composer `form` surface used by the
 * generated `clear-upload-draft` script on top of the shared Project composer fixture,
 * so draft cleanup executes against the same mutable identity state as the send boundary.
 *
 * @param options Initial pathname and optional state mutation hooks before each script family.
 * @returns Browser, fixture state mutators, captured invocations, and ordered page events.
 * @throws {Error} If the fixture directory or generated script cannot be read.
 */
async function executableProjectSendFixture(options: {
  readonly initialPathname: string;
  readonly beforeCleanup?: (pageFixture: ReturnType<typeof projectSendPageFixture>) => void;
  readonly beforeSubmit?: (pageFixture: ReturnType<typeof projectSendPageFixture>) => void;
  readonly beforePrepareUpload?: (pageFixture: ReturnType<typeof projectSendPageFixture>) => void;
}) {
  const root = await mkdtemp(join(tmpdir(), 'collab-project-send-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  const invocations: BrowserCommandInvocation[] = [];
  const pageFixture = projectSendPageFixture(options.initialPathname);
  const originalLocator = (pageFixture.page as { readonly locator: (selector: string) => object }).locator;
  const composerForm = {
    async count() {
      return 1;
    },
    filter(_options: { readonly has: object }) {
      return composerForm;
    },
    locator(selector: string) {
      if (selector === 'input[type="file"]') {
        return {
          evaluateAll(callback: unknown) {
            if (typeof callback !== 'function') {
              return Promise.reject(new TypeError('fixture file-input callback is not a function'));
            }
            return Promise.resolve(Reflect.apply(callback, undefined, [[]]));
          },
        };
      }
      return originalLocator(selector);
    },
    getByText(_text: string, _options: { readonly exact?: boolean }) {
      return {
        evaluateAll(callback: unknown) {
          if (typeof callback !== 'function') {
            return Promise.reject(new TypeError('fixture composer text callback is not a function'));
          }
          return Promise.resolve(Reflect.apply(callback, undefined, [[]]));
        },
      };
    },
  };
  const page = {
    ...pageFixture.page,
    async reload() {},
    locator(selector: string) {
      if (selector === 'form') {
        return composerForm;
      }
      return originalLocator(selector);
    },
  };
  const browser = new PlaywrightBrowser(paths, root, async (invocation) => {
    invocations.push(invocation);
    try {
      if (invocation.arguments.includes('run-code')) {
        const scriptPath = invocation.arguments[invocation.arguments.indexOf('--filename') + 1] ?? '';
        if (basename(scriptPath).startsWith('clear-upload-draft')) {
          options.beforeCleanup?.(pageFixture);
        }
        if (basename(scriptPath).startsWith('prepare-upload')) {
          options.beforePrepareUpload?.(pageFixture);
        }
        if (basename(scriptPath).startsWith('send-')) {
          options.beforeSubmit?.(pageFixture);
        }
        const source = await scriptForInvocation(invocation);
        const runPageFunction = new Function(`return (${source})`)() as (page: object) => Promise<unknown>;
        const result = await runPageFunction(page);
        return output(`### Ran Playwright code\n${JSON.stringify(result)}\n`);
      }
      return output('ok');
    } catch (error) {
      return output(`### Error\n${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
  return { browser, events: pageFixture.events, fixture: pageFixture, invocations, paths };
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
 * Creates a browser runner that executes failed-response resolution against a page fixture.
 *
 * @param options Conversation path, turns, composer residue, and Stop behavior.
 * @returns Browser and ordered resolution events.
 * @throws {Error} If the fixture directory or generated script cannot be read.
 */
async function executableResolveTurnFixture(options: ResolveTurnPageOptions) {
  const root = await mkdtemp(join(tmpdir(), 'collab-resolve-turn-browser-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  const pageFixture = resolveTurnPageFixture(options);
  const browser = new PlaywrightBrowser(paths, root, async (invocation) => {
    invocation.beforeCommandRelease?.();
    invocation.onCommandStarted?.();
    invocation.onCommandSpawned?.(10_000);
    invocation.onChildSpawned?.(9000);
    try {
      const source = await scriptForInvocation(invocation);
      const runPageFunction = new Function(`return (${source})`)() as (page: object) => Promise<string>;
      return output(`### Ran Playwright code\n${JSON.stringify(await runPageFunction(pageFixture.page))}\n`);
    } catch (error) {
      return output(`### Error\n${error instanceof Error ? error.message : String(error)}\n`);
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
