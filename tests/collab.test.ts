import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BrowserError, type BrowserOperationObserver } from '../skills/chatgpt-pro-collab/scripts/browser.ts';
import { CollabService, runCli, type CliIo, type CollabBrowser } from '../skills/chatgpt-pro-collab/scripts/collab.ts';
import {
  artifactPath,
  collabPaths,
  ensureCollabDirectories,
  responsePath,
  savePromptCopy,
} from '../skills/chatgpt-pro-collab/scripts/session.ts';
import { StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';

describe('BEH-001 through BEH-009 CLI orchestration', () => {
  it('supports setup, isolated tasks, multiple turns, idempotent wait, archive, and close', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const firstTask = await fixture.start();
    const secondTask = await fixture.start();
    expect(firstTask.taskId).not.toBe(secondTask.taskId);
    expect(firstTask.browserPid).not.toBe(secondTask.browserPid);
    expect(firstTask.contextMarker).not.toBe(secondTask.contextMarker);
    expect(firstTask.sessionDirectory).not.toBe(secondTask.sessionDirectory);

    const promptPath = join(fixture.root, 'prompt.md');
    const attachmentPath = join(fixture.root, 'attachment.txt');
    await Promise.all([writeFile(promptPath, 'first prompt'), writeFile(attachmentPath, 'opaque')]);
    const firstTurn = await fixture.service.send(firstTask.taskId, promptPath, [attachmentPath]);
    const waited = await fixture.service.wait(firstTask.taskId, firstTurn.turnId, 20_000, 20_000);
    const externalOwner = new StateStore(fixture.paths.database);
    externalOwner.acquireTaskOperation(firstTask.taskId, 'send', 'idempotent-read-owner');
    const repeated = await fixture.service.wait(firstTask.taskId, firstTurn.turnId, 20_000, 20_000);
    externalOwner.releaseTaskOperation(firstTask.taskId, 'idempotent-read-owner');
    externalOwner.close();
    expect(waited.status).toBe('completed');
    expect(repeated.status).toBe('completed');
    if (waited.status !== 'completed' || repeated.status !== 'completed') {
      throw new Error('fixture response did not complete');
    }
    expect(repeated.responsePath).toBe(waited.responsePath);
    expect(await readFile(waited.responsePath, 'utf8')).toBe(`response for ${firstTask.taskId}`);
    expect(fixture.browser.expectedAssistantTurnIds[0]).toBe(`conversation-turn-${firstTask.taskId}`);

    await writeFile(promptPath, 'second prompt');
    const secondTurn = await fixture.service.send(firstTask.taskId, promptPath, []);
    await fixture.service.wait(firstTask.taskId, secondTurn.turnId, 20_000, 20_000);
    expect(fixture.browser.expectedConversationIds).toEqual([null, `conversation-${firstTask.taskId}`]);
    const store = new StateStore(fixture.paths.database);
    const turns = store.listTurns(firstTask.taskId);
    expect(turns).toHaveLength(2);
    expect(
      await readFile(
        join(fixture.paths.sessionsDirectory, firstTask.taskId, 'turns', firstTurn.turnId, 'prompt.md'),
        'utf8',
      ),
    ).toBe('first prompt');
    expect(
      await readFile(
        join(fixture.paths.sessionsDirectory, firstTask.taskId, 'turns', secondTurn.turnId, 'prompt.md'),
        'utf8',
      ),
    ).toBe('second prompt');
    expect(turns[0]?.attachmentPaths).toEqual([attachmentPath]);
    store.close();

    await expect(fixture.service.archive(firstTask.taskId)).resolves.toMatchObject({ taskId: firstTask.taskId });
    expect(fixture.browser.archived).toEqual([firstTask.taskId]);
    await writeFile(promptPath, 'after archive');
    const afterArchiveTurn = await fixture.service.send(firstTask.taskId, promptPath, []);
    await fixture.service.wait(firstTask.taskId, afterArchiveTurn.turnId, 20_000, 20_000);
    expect(fixture.browser.expectedConversationIds.at(-1)).toBe(`conversation-${firstTask.taskId}`);
    await expect(fixture.service.close(firstTask.taskId)).resolves.toMatchObject({ alreadyClosed: false });
    const closedStore = new StateStore(fixture.paths.database);
    const closedBeforeRepeat = closedStore.requireTask(firstTask.taskId);
    closedStore.close();
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    await expect(fixture.service.close(firstTask.taskId)).resolves.toMatchObject({ alreadyClosed: true });
    const repeatedCloseStore = new StateStore(fixture.paths.database);
    expect(repeatedCloseStore.requireTask(firstTask.taskId)).toEqual(closedBeforeRepeat);
    repeatedCloseStore.close();
    expect(fixture.browser.closed).toEqual([firstTask.taskId]);
    expect(fixture.browser.observedOperations).toBe(13);
    await expect(fixture.service.wait(firstTask.taskId, firstTurn.turnId, 20_000, 20_000)).resolves.toEqual(repeated);
    await expect(fixture.service.archive(firstTask.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_ACTIVE' });
  });

  it('records submission ambiguity and blocks an automatic resend', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'ambiguous');
    fixture.browser.nextSendStatus = 'unknown-submission';

    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'SUBMISSION_UNKNOWN',
    });
    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'TURN_IN_PROGRESS',
    });
  });

  it('recovers an unsafe-not-submitted draft via clean-or-rebuild and keeps the task active', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'unsafe cleanup');
    fixture.browser.nextSendStatus = 'unsafe-not-submitted';
    fixture.browser.cleanSendComposerFailuresRemaining = 1;

    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'SUBMISSION_FAILED',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(task.taskId).status).toBe('active');
    expect(store.listTurns(task.taskId)).toMatchObject([{ status: 'failed' }]);
    expect(
      store.listOperations(task.taskId).find((operation) => {
        return operation.kind === 'send';
      }),
    ).toMatchObject({ kind: 'send', step: 'draft', phase: 'committed', resolutionSource: 'automatic' });
    store.close();
    expect(fixture.browser.closed).toEqual([task.taskId]);
    expect(fixture.browser.cleanedComposers).toEqual([task.taskId]);
    expect(fixture.browser.cleanSendComposerFailuresRemaining).toBe(0);
    expect(fixture.browser.recoveredConversations).toEqual([]);

    const resent = await fixture.service.send(task.taskId, promptPath, []);
    expect(resent.turnId).toBeTruthy();
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(task.taskId).status).toBe('active');
    reopened.close();
  });

  it('fails a known pre-submission error without creating submission ambiguity', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'known preflight failure');
    fixture.browser.nextSendStatus = 'not-submitted';

    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'SUBMISSION_FAILED',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.listTurns(task.taskId)).toMatchObject([{ status: 'failed', error: 'preflight failed' }]);
    expect(store.requireTask(task.taskId).status).toBe('active');
    store.close();
  });

  it('restores the bound conversation so a pending turn can be captured after archive', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'pending archive');
    const turn = await fixture.service.send(task.taskId, promptPath, []);

    await expect(fixture.service.archive(task.taskId)).resolves.toMatchObject({ taskId: task.taskId });
    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).resolves.toMatchObject({
      turnId: turn.turnId,
    });
    expect(fixture.browser.archived).toEqual([task.taskId]);
  });

  it('rejects a concurrent non-wait same-task browser operation', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const owner = new StateStore(fixture.paths.database);
    owner.acquireTaskOperation(task.taskId, 'send', 'external-owner');

    await expect(fixture.service.close(task.taskId)).rejects.toMatchObject({
      code: 'TASK_OPERATION_IN_PROGRESS',
    });
    owner.releaseTaskOperation(task.taskId, 'external-owner');
    owner.close();
    await expect(fixture.service.close(task.taskId)).resolves.toMatchObject({ alreadyClosed: false });
  });

  it('rejects a prompt whose surrounding whitespace cannot be proven verbatim on the page', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'whitespace-prompt.md');
    await writeFile(promptPath, '  exact prompt  ');

    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'PROMPT_NOT_VERBATIM_PROVABLE',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.listTurns(task.taskId)).toEqual([]);
    store.close();
  });

  it('lets close take the task between bounded wait polls', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'long response');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.pendingWaitPolls = 1;
    fixture.browser.waitPollDelayMs = 100;

    const waiting = fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    await expect(fixture.service.close(task.taskId)).resolves.toMatchObject({ alreadyClosed: false });
    await expect(waiting).rejects.toMatchObject({ code: 'TASK_NOT_ACTIVE' });
  });

  it('returns pending once at observation expiry and resumes the same turn later', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'long response');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.pendingWaitPolls = 1;
    fixture.browser.waitPollDelayMs = 10;

    await expect(fixture.service.wait(task.taskId, turn.turnId, 1, 20_000)).resolves.toEqual({
      status: 'pending',
      taskId: task.taskId,
      turnId: turn.turnId,
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId)).toMatchObject({ status: 'pending', error: null });
    store.close();
    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('keeps a pre-freeze timeout pending and re-observes with a fresh capture timeout', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'capture timeout');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.captureDelayMs = 10;

    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 1)).rejects.toMatchObject({
      code: 'CAPTURE_TIMEOUT',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId)).toMatchObject({
      status: 'pending',
      responsePath: null,
      artifactSetRecorded: false,
    });
    expect(store.listArtifacts(task.taskId, turn.turnId)).toEqual([]);
    expect(store.getTaskOperation(task.taskId)).toBeNull();
    store.close();
    expect(fixture.browser.captureAbortCount).toBe(1);
    expect(fixture.browser.observeResponseCalls).toBe(1);
    fixture.browser.captureDelayMs = 0;
    await expect(fixture.service.wait(task.taskId, turn.turnId, 50, 20_000)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(fixture.browser.observeResponseCalls).toBe(2);
  });

  it('maps a delayed browser failure after a 1ms deadline to CAPTURE_TIMEOUT', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'delayed capture failure');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.captureDelayMs = 10;
    fixture.browser.nextCaptureFailureTaskId = task.taskId;

    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 1)).rejects.toMatchObject({
      code: 'CAPTURE_TIMEOUT',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId)).toMatchObject({ status: 'pending', responsePath: null });
    expect(store.listArtifacts(task.taskId, turn.turnId)).toEqual([]);
    expect(store.getTaskOperation(task.taskId)).toBeNull();
    store.close();
  });

  it('aborts a capture that never resolves and releases its task lease', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'never resolving capture');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.captureNeverSettles = true;

    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 1)).rejects.toMatchObject({
      code: 'CAPTURE_TIMEOUT',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId)).toMatchObject({ status: 'pending', responsePath: null });
    expect(store.getTaskOperation(task.taskId)).toBeNull();
    store.close();
    expect(fixture.browser.captureAbortCount).toBe(1);
    fixture.browser.captureNeverSettles = false;
    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('preserves a real browser error that settles before the capture deadline', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'immediate capture failure');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.nextCaptureFailureTaskId = task.taskId;

    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).rejects.toMatchObject({
      code: 'INJECTED_BROWSER_FAILURE',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId)).toMatchObject({ status: 'pending', responsePath: null });
    expect(store.listArtifacts(task.taskId, turn.turnId)).toEqual([]);
    store.close();
  });

  it('publishes every ordered artifact without same-name collisions and reuses completed files', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'return files');
    fixture.browser.responseArtifacts.push(
      { sourceUrl: 'sandbox:/mnt/data/a/same-name.txt', label: 'first' },
      { sourceUrl: 'sandbox:/mnt/data/b/same-name.txt', label: 'second' },
    );
    const turn = await fixture.service.send(task.taskId, promptPath, []);

    const completed = await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed') {
      throw new Error('fixture response did not complete');
    }
    expect(completed.artifactPaths).toHaveLength(2);
    expect(new Set(completed.artifactPaths).size).toBe(2);
    expect(
      await Promise.all(
        completed.artifactPaths.map((path) => {
          return readFile(path, 'utf8');
        }),
      ),
    ).toEqual(['artifact for sandbox:/mnt/data/a/same-name.txt', 'artifact for sandbox:/mnt/data/b/same-name.txt']);
    const store = new StateStore(fixture.paths.database);
    expect(store.listArtifacts(task.taskId, turn.turnId)).toMatchObject([
      { ordinal: 1, status: 'completed', filename: 'same-name.txt' },
      { ordinal: 2, status: 'completed', filename: 'same-name.txt' },
    ]);
    store.close();

    await expect(fixture.service.wait(task.taskId, turn.turnId, 1, 1)).resolves.toEqual(completed);
    expect(fixture.browser.downloadedArtifacts).toHaveLength(2);
  });

  it('preserves a pre-deadline download error and resumes only pending rows', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'return files with retry');
    const firstSource = 'sandbox:/mnt/data/first.txt';
    const secondSource = 'sandbox:/mnt/data/second.txt';
    fixture.browser.responseArtifacts.push(
      { sourceUrl: firstSource, label: 'first' },
      { sourceUrl: secondSource, label: 'second' },
    );
    fixture.browser.nextDownloadFailureSourceUrl = secondSource;
    const turn = await fixture.service.send(task.taskId, promptPath, []);

    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).rejects.toMatchObject({
      code: 'INJECTED_DOWNLOAD_FAILURE',
    });
    const interruptedStore = new StateStore(fixture.paths.database);
    expect(interruptedStore.listArtifacts(task.taskId, turn.turnId)).toMatchObject([
      { sourceUrl: firstSource, status: 'completed' },
      { sourceUrl: secondSource, status: 'pending', error: expect.stringContaining('injected download failure') },
    ]);
    interruptedStore.close();

    await expect(fixture.service.wait(task.taskId, turn.turnId, 1, 20_000)).resolves.toMatchObject({
      status: 'completed',
      artifactPaths: [expect.any(String), expect.any(String)],
    });
    expect(fixture.browser.downloadedArtifacts).toEqual([firstSource, secondSource, secondSource]);
  });

  it('maps a delayed artifact failure after the shared deadline to CAPTURE_TIMEOUT', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'delayed artifact failure');
    const sourceUrl = 'sandbox:/mnt/data/result.txt';
    fixture.browser.responseArtifacts.push({ sourceUrl, label: 'result.txt' });
    fixture.browser.nextDownloadFailureSourceUrl = sourceUrl;
    fixture.browser.downloadFailureDelayMs = 150;
    const turn = await fixture.service.send(task.taskId, promptPath, []);

    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 50)).rejects.toMatchObject({
      code: 'CAPTURE_TIMEOUT',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId).status).toBe('capturing');
    expect(store.requireArtifact(task.taskId, turn.turnId, 1)).toMatchObject({
      status: 'pending',
      error: expect.stringContaining('artifact capture timed out'),
    });
    expect(store.getTaskOperation(task.taskId)).toBeNull();
    store.close();
    expect(fixture.browser.downloadAbortCount).toBe(1);
  });

  it('bounds a never-settling artifact provider, releases its lease, and retries only the remainder', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'never-settling artifact');
    const firstSource = 'sandbox:/mnt/data/first.txt';
    const secondSource = 'sandbox:/mnt/data/second.txt';
    fixture.browser.responseArtifacts.push(
      { sourceUrl: firstSource, label: 'first.txt' },
      { sourceUrl: secondSource, label: 'second.txt' },
    );
    fixture.browser.downloadDelayMs = 20;
    fixture.browser.downloadNeverSettlesSourceUrl = secondSource;
    const turn = await fixture.service.send(task.taskId, promptPath, []);

    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 100)).rejects.toMatchObject({
      code: 'CAPTURE_TIMEOUT',
    });
    const interruptedStore = new StateStore(fixture.paths.database);
    expect(interruptedStore.requireTurn(task.taskId, turn.turnId).status).toBe('capturing');
    expect(interruptedStore.listArtifacts(task.taskId, turn.turnId)).toMatchObject([
      { sourceUrl: firstSource, status: 'completed' },
      { sourceUrl: secondSource, status: 'pending', error: expect.stringContaining('artifact capture timed out') },
    ]);
    expect(interruptedStore.getTaskOperation(task.taskId)).toBeNull();
    interruptedStore.acquireTaskOperation(task.taskId, 'retry-probe', 'retry-probe-token');
    interruptedStore.releaseTaskOperation(task.taskId, 'retry-probe-token');
    interruptedStore.close();
    expect(fixture.browser.downloadAbortCount).toBe(1);
    expect(fixture.browser.downloadCaptureBudgets[1]).toBeLessThan(fixture.browser.downloadCaptureBudgets[0] ?? 0);

    fixture.browser.downloadDelayMs = 0;
    fixture.browser.downloadNeverSettlesSourceUrl = null;
    await expect(fixture.service.wait(task.taskId, turn.turnId, 1, 20_000)).resolves.toMatchObject({
      status: 'completed',
      artifactPaths: [expect.any(String), expect.any(String)],
    });
    expect(fixture.browser.downloadedArtifacts).toEqual([firstSource, secondSource, secondSource]);
  });

  it('overlaps different task waits and contains a one-sided capture failure', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const firstTask = await fixture.start();
    const secondTask = await fixture.start();
    const firstPrompt = join(fixture.root, 'first.md');
    const secondPrompt = join(fixture.root, 'second.md');
    await Promise.all([writeFile(firstPrompt, 'first'), writeFile(secondPrompt, 'second')]);
    const firstTurn = await fixture.service.send(firstTask.taskId, firstPrompt, []);
    const secondTurn = await fixture.service.send(secondTask.taskId, secondPrompt, []);
    fixture.browser.captureDelayMs = 40;
    fixture.browser.nextCaptureFailureTaskId = firstTask.taskId;

    const [firstResult, secondResult] = await Promise.allSettled([
      fixture.service.wait(firstTask.taskId, firstTurn.turnId, 20_000, 20_000),
      fixture.service.wait(secondTask.taskId, secondTurn.turnId, 20_000, 20_000),
    ]);

    expect(firstResult).toMatchObject({ status: 'rejected' });
    expect(secondResult).toMatchObject({ status: 'fulfilled', value: { status: 'completed' } });
    expect(fixture.browser.maxConcurrentCaptures).toBe(2);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(firstTask.taskId, firstTurn.turnId).status).toBe('pending');
    expect(store.requireTurn(secondTask.taskId, secondTurn.turnId).status).toBe('completed');
    expect(store.requireTask(secondTask.taskId).status).toBe('active');
    store.close();

    fixture.browser.captureDelayMs = 0;
    await expect(fixture.service.wait(firstTask.taskId, firstTurn.turnId, 20_000, 20_000)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('keeps Web archive and local close as separate transcript-preserving side effects', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'lifecycle separation');
    fixture.browser.responseArtifacts.push({
      sourceUrl: 'sandbox:/mnt/data/result.txt',
      label: 'result.txt',
    });
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    const completed = await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed') {
      throw new Error('fixture response did not complete');
    }

    await fixture.service.archive(task.taskId);
    const activeStore = new StateStore(fixture.paths.database);
    expect(activeStore.requireTask(task.taskId).status).toBe('active');
    activeStore.close();
    expect(await readFile(completed.responsePath, 'utf8')).toBe(`response for ${task.taskId}`);
    await expect(
      Promise.all(
        completed.artifactPaths.map((path) => {
          return readFile(path);
        }),
      ),
    ).resolves.toHaveLength(1);

    await fixture.service.close(task.taskId);
    const closedStore = new StateStore(fixture.paths.database);
    expect(closedStore.requireTask(task.taskId).status).toBe('closed');
    expect(closedStore.requireTurn(task.taskId, turn.turnId).status).toBe('completed');
    closedStore.close();
    expect(await readFile(fixture.paths.seedState, 'utf8')).toBe(validSeedText());
    expect(fixture.browser.conversations.get(task.taskId)).toBe(`conversation-${task.taskId}`);
    await expect(fixture.service.archive(task.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_ACTIVE' });
  });

  it('aborts a delayed artifact download at the shared deadline and retries it', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'interrupt after artifact publication');
    const sourceUrl = 'sandbox:/mnt/data/result.txt';
    fixture.browser.responseArtifacts.push({ sourceUrl, label: 'result.txt' });
    fixture.browser.downloadDelayMs = 300;
    const turn = await fixture.service.send(task.taskId, promptPath, []);

    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 200)).rejects.toMatchObject({
      code: 'CAPTURE_TIMEOUT',
    });
    const interruptedStore = new StateStore(fixture.paths.database);
    expect(interruptedStore.requireTurn(task.taskId, turn.turnId).status).toBe('capturing');
    const interruptedArtifact = interruptedStore.requireArtifact(task.taskId, turn.turnId, 1);
    expect(interruptedArtifact).toMatchObject({
      status: 'pending',
      localPath: null,
      error: expect.stringContaining('artifact capture timed out'),
    });
    expect(interruptedStore.getTaskOperation(task.taskId)).toBeNull();
    interruptedStore.close();
    expect(fixture.browser.downloadAbortCount).toBe(1);

    fixture.browser.downloadDelayMs = 0;
    const completed = await fixture.service.wait(task.taskId, turn.turnId, 1, 20_000);
    expect(completed).toMatchObject({ status: 'completed', artifactPaths: [expect.any(String)] });
    expect(fixture.browser.downloadedArtifacts).toEqual([sourceUrl, sourceUrl]);
  });

  it('rejects changed response bytes during capture recovery without overwriting the transcript', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'response consistency');
    const sourceUrl = 'sandbox:/mnt/data/result.txt';
    fixture.browser.responseArtifacts.push({ sourceUrl, label: 'result.txt' });
    fixture.browser.nextDownloadFailureSourceUrl = sourceUrl;
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).rejects.toThrow(
      /injected download failure/,
    );
    const store = new StateStore(fixture.paths.database);
    const responsePath = store.requireTurn(task.taskId, turn.turnId).responsePath;
    store.close();
    if (responsePath === null) {
      throw new Error('fixture response path was not recorded');
    }
    await writeFile(responsePath, 'changed bytes');

    await expect(fixture.service.wait(task.taskId, turn.turnId, 1, 20_000)).rejects.toMatchObject({
      code: 'TRANSCRIPT_INCONSISTENT',
    });
    expect(await readFile(responsePath, 'utf8')).toBe('changed bytes');
  });

  it('rejects a changed logical artifact set before resuming downloads', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'artifact set consistency');
    const sourceUrl = 'sandbox:/mnt/data/result.txt';
    fixture.browser.responseArtifacts.push({ sourceUrl, label: 'result.txt' });
    fixture.browser.nextDownloadFailureSourceUrl = sourceUrl;
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).rejects.toThrow(
      /injected download failure/,
    );
    fixture.browser.responseArtifacts.splice(0, 1, {
      sourceUrl: 'sandbox:/mnt/data/changed.txt',
      label: 'changed.txt',
    });

    await expect(fixture.service.wait(task.taskId, turn.turnId, 1, 20_000)).rejects.toMatchObject({
      code: 'ARTIFACT_SET_INCONSISTENT',
    });
    expect(fixture.browser.downloadedArtifacts).toEqual([sourceUrl]);
  });

  it('rejects changed pending artifact bytes and a missing completed artifact', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'artifact byte consistency');
    const sourceUrl = 'sandbox:/mnt/data/result.txt';
    fixture.browser.responseArtifacts.push({ sourceUrl, label: 'result.txt' });
    fixture.browser.nextDownloadFailureSourceUrl = sourceUrl;
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).rejects.toMatchObject({
      code: 'INJECTED_DOWNLOAD_FAILURE',
    });
    const pendingStore = new StateStore(fixture.paths.database);
    const pendingPath = artifactPath(fixture.paths, task.taskId, turn.turnId, 1, 'result.txt');
    pendingStore.setArtifactDestination(task.taskId, turn.turnId, 1, 'result.txt', pendingPath);
    pendingStore.close();
    await writeFile(pendingPath, 'changed bytes');
    await expect(fixture.service.wait(task.taskId, turn.turnId, 1, 20_000)).rejects.toMatchObject({
      code: 'ARTIFACT_INCONSISTENT',
    });
    expect(await readFile(pendingPath, 'utf8')).toBe('changed bytes');

    await writeFile(pendingPath, `artifact for ${sourceUrl}`);
    const completed = await fixture.service.wait(task.taskId, turn.turnId, 1, 20_000);
    expect(completed.status).toBe('completed');
    await unlink(pendingPath);
    await expect(fixture.service.wait(task.taskId, turn.turnId, 1, 1)).rejects.toMatchObject({
      code: 'ARTIFACT_INCONSISTENT',
    });
  });

  it('re-reads archive lifecycle state after acquiring the task lease', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'establish conversation');
    await fixture.service.send(task.taskId, promptPath, []);
    const service = new CollabService(
      fixture.paths,
      fixture.browser,
      () => {
        return new FailTaskAfterArchiveLeaseStore(fixture.paths.database);
      },
      () => {
        return 'unused-id';
      },
    );

    await expect(service.archive(task.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_ACTIVE' });
    expect(fixture.browser.archived).toEqual([]);
  });

  it('prints stable help and JSON usage errors', async () => {
    const fixture = await serviceFixture();
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIo = {
      writeOutput(value) {
        output.push(value);
      },
      writeError(value) {
        errors.push(value);
      },
    };

    await expect(runCli(['--', 'help'], fixture.service, io)).resolves.toBe(0);
    expect(output.join('')).toContain('node "<skill-directory>/scripts/collab.ts" send <taskId> <promptPath>');
    await expect(runCli(['wait', 'only-task'], fixture.service, io)).resolves.toBe(1);
    expect(JSON.parse(errors.at(-1) ?? '{}')).toMatchObject({ ok: false, error: { code: 'USAGE' } });
    await expect(runCli(['wait', 'task-a', 'turn-a', '0', '1000'], fixture.service, io)).resolves.toBe(1);
    expect(JSON.parse(errors.at(-1) ?? '{}')).toMatchObject({
      ok: false,
      error: { code: 'USAGE', message: expect.stringContaining('observationWindowMs') },
    });
  });

  it('prints one pending CLI result after clearing the reconciled submission diagnostic', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'pending-prompt.md');
    await writeFile(promptPath, 'long response');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.pendingWaitPolls = 1;
    fixture.browser.waitPollDelayMs = 10;
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIo = {
      writeOutput(value) {
        output.push(value);
      },
      writeError(value) {
        errors.push(value);
      },
    };

    await expect(runCli(['wait', task.taskId, turn.turnId, '1', '20000'], fixture.service, io)).resolves.toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      ok: true,
      command: 'wait',
      status: 'pending',
      taskId: task.taskId,
      turnId: turn.turnId,
    });
    expect(errors).toEqual([]);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId)).toMatchObject({ status: 'pending', error: null });
    store.close();
  });

  it('runs the Skill entry from a host without a package manifest', async () => {
    const hostDirectory = await mkdtemp(join(tmpdir(), 'collab-host-'));
    const cliPath = fileURLToPath(new URL('../skills/chatgpt-pro-collab/scripts/collab.ts', import.meta.url));

    const result = spawnSync(process.execPath, [cliPath, 'help'], {
      cwd: hostDirectory,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('node "<skill-directory>/scripts/collab.ts" start');
  });
});

describe('BEH-001 setup journal and interruption recovery', () => {
  it('commits a fresh setup with seed and session-closed evidence', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const store = new StateStore(fixture.paths.database);
    const operations = store.listOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      kind: 'setup',
      step: 'cleanup',
      phase: 'committed',
      resolutionSource: 'automatic',
      evidence: { seedValidated: true, sessionClosed: true },
    });
    store.close();
    expect(fixture.browser.setupSessions).toHaveLength(1);
    expect(fixture.browser.setupClosedSessions).toEqual(fixture.browser.setupSessions);
  });

  it('re-enters the login flow after an interruption before the seed was saved', async () => {
    const fixture = await serviceFixture();
    const store = new StateStore(fixture.paths.database);
    store.createOperation({
      id: 'setup-login-prepared',
      kind: 'setup',
      step: 'login',
      taskId: null,
      turnId: null,
      sessionName: 'chatgpt-pro-collab-setup-interrupted',
    });
    store.close();

    await fixture.service.setup();
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireOperation('setup-login-prepared')).toMatchObject({ phase: 'committed' });
    reopened.close();
    expect(fixture.browser.setupSessions).toEqual(['chatgpt-pro-collab-setup-interrupted']);
  });

  it('skips repeated login and only finishes cleanup when the seed already authenticates', async () => {
    const fixture = await serviceFixture();
    await writeFile(fixture.paths.seedState, validSeedText());
    const store = new StateStore(fixture.paths.database);
    store.createOperation({
      id: 'setup-login-effect-unknown',
      kind: 'setup',
      step: 'login',
      taskId: null,
      turnId: null,
      sessionName: 'chatgpt-pro-collab-setup-halfway',
    });
    store.markOperationEffectUnknown('setup-login-effect-unknown');
    store.close();

    await fixture.service.setup();
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireOperation('setup-login-effect-unknown')).toMatchObject({
      phase: 'committed',
      evidence: { seedValidated: true, sessionClosed: true },
    });
    reopened.close();
    expect(fixture.browser.seedVerifications).toBe(2);
    expect(fixture.browser.setupSessions).toEqual([]);
    expect(fixture.browser.setupClosedSessions).toEqual(['chatgpt-pro-collab-setup-halfway']);
  });

  it('re-enters the interactive login flow when an existing seed does not authenticate', async () => {
    const fixture = await serviceFixture();
    await writeFile(fixture.paths.seedState, validSeedText());
    fixture.browser.seedAuthenticated = false;

    await fixture.service.setup();
    expect(fixture.browser.setupSessions).toHaveLength(1);
    expect(fixture.browser.seedVerifications).toBeGreaterThanOrEqual(2);
    const reopened = new StateStore(fixture.paths.database);
    const setupOperation = reopened.listOperations().find((operation) => {
      return operation.kind === 'setup';
    });
    expect(setupOperation).toMatchObject({ phase: 'committed', evidence: { seedValidated: true } });
    reopened.close();
  });

  it('does not skip login for a structurally valid pseudo-cookie seed that fails page verification', async () => {
    const fixture = await serviceFixture();
    await writeFile(
      fixture.paths.seedState,
      JSON.stringify({
        cookies: [{ name: 'definitely-not-a-session-cookie', domain: '.chatgpt.com', path: '/', value: '' }],
        origins: [],
      }),
    );
    fixture.browser.seedAuthenticated = false;

    await fixture.service.setup();
    expect(fixture.browser.setupSessions).toHaveLength(1);
    expect(fixture.browser.seedVerifications).toBeGreaterThanOrEqual(2);
  });

  it('finishes an interrupted cleanup step without repeating login or state save', async () => {
    const fixture = await serviceFixture();
    await writeFile(fixture.paths.seedState, validSeedText());
    const store = new StateStore(fixture.paths.database);
    store.createOperation({
      id: 'setup-cleanup-prepared',
      kind: 'setup',
      step: 'cleanup',
      taskId: null,
      turnId: null,
      sessionName: 'chatgpt-pro-collab-setup-cleaning',
    });
    store.close();

    await fixture.service.setup();
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireOperation('setup-cleanup-prepared')).toMatchObject({
      phase: 'committed',
      evidence: { sessionClosed: true },
    });
    reopened.close();
    expect(fixture.browser.setupSessions).toEqual([]);
    expect(fixture.browser.setupClosedSessions).toEqual(['chatgpt-pro-collab-setup-cleaning']);
  });

  it('does not commit setup while the interactive session is not confirmed closed', async () => {
    const fixture = await serviceFixture();
    await writeFile(fixture.paths.seedState, validSeedText());
    fixture.browser.nextSetupCloseResult = { sessionClosed: false };

    await expect(fixture.service.setup()).rejects.toMatchObject({
      code: 'SETUP_SESSION_NOT_CLOSED',
      message: expect.stringContaining('run setup again to finish cleanup'),
    });

    const store = new StateStore(fixture.paths.database);
    const setupOperation = store.listOperations().find((operation) => {
      return operation.kind === 'setup';
    });
    expect(setupOperation).toMatchObject({ step: 'cleanup', phase: 'effect-unknown' });
    expect(setupOperation?.phase).not.toBe('committed');
    store.close();

    fixture.browser.nextSetupCloseResult = { sessionClosed: true };
    await fixture.service.setup();

    const reopened = new StateStore(fixture.paths.database);
    const committed = reopened.listOperations().find((operation) => {
      return operation.kind === 'setup';
    });
    expect(committed).toMatchObject({
      phase: 'committed',
      evidence: { seedValidated: true, sessionClosed: true },
    });
    reopened.close();
    expect(fixture.browser.setupSessions).toEqual([]);
    expect(fixture.browser.setupClosedSessions).toHaveLength(2);
  });

  it('re-enters interactive login from seed effect-unknown when a valid seed stops authenticating', async () => {
    const fixture = await serviceFixture();
    await writeFile(fixture.paths.seedState, validSeedText());
    fixture.browser.seedAuthenticated = false;
    const store = new StateStore(fixture.paths.database);
    store.createOperation({
      id: 'setup-seed-effect-unknown',
      kind: 'setup',
      step: 'seed',
      taskId: null,
      turnId: null,
      sessionName: 'chatgpt-pro-collab-setup-reauth',
    });
    store.markOperationEffectUnknown('setup-seed-effect-unknown');
    store.close();

    await fixture.service.setup();

    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireOperation('setup-seed-effect-unknown')).toMatchObject({
      phase: 'committed',
      evidence: { seedValidated: true, sessionClosed: true },
    });
    reopened.close();
    expect(fixture.browser.setupSessions).toEqual(['chatgpt-pro-collab-setup-reauth']);
    expect(fixture.browser.setupClosedSessions).toEqual(['chatgpt-pro-collab-setup-reauth']);
    expect(fixture.browser.seedVerifications).toBeGreaterThanOrEqual(2);
  });
});

describe('BEH-003 send journal and archive attachments', () => {
  it('reserves the sending turn and draft operation before the browser side effect', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'journal-prompt.md');
    await writeFile(promptPath, 'journaled prompt');
    const result = await fixture.service.send(task.taskId, promptPath, []);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, result.turnId)).toMatchObject({ status: 'pending' });
    expect(store.listOperations(task.taskId)).toMatchObject([
      { kind: 'start', phase: 'committed' },
      {
        kind: 'send',
        phase: 'committed',
        resolutionSource: 'automatic',
        evidence: {
          conversationId: `conversation-${task.taskId}`,
          userTurnIdentity: expect.stringContaining('user-turn'),
          promptVerbatimMatch: true,
          attachmentNamesMatch: true,
        },
      },
    ]);
    store.close();
  });

  it('enters needs-decision with the turn unknown-submission when the outcome cannot be proven', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'ambiguous-prompt.md');
    await writeFile(promptPath, 'ambiguous');
    fixture.browser.nextSendStatus = 'unknown-submission';

    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'SUBMISSION_UNKNOWN',
    });
    const store = new StateStore(fixture.paths.database);
    const turns = store.listTurns(task.taskId);
    const sendOperation = store.listOperations(task.taskId).find((operation) => {
      return operation.kind === 'send';
    });
    expect(turns).toMatchObject([{ status: 'unknown-submission' }]);
    expect(sendOperation).toMatchObject({ kind: 'send', step: 'submit', phase: 'needs-decision' });
    store.close();
  });

  it('commits a failed send operation for a proven non-submission', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'not-sent-prompt.md');
    await writeFile(promptPath, 'not sent');
    fixture.browser.nextSendStatus = 'not-submitted';

    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'SUBMISSION_FAILED',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.listTurns(task.taskId)).toMatchObject([{ status: 'failed' }]);
    const failedSendOperation = store.listOperations(task.taskId).find((operation) => {
      return operation.kind === 'send';
    });
    expect(failedSendOperation).toMatchObject({
      phase: 'committed',
      resolutionSource: 'automatic',
      error: expect.stringContaining('preflight failed'),
    });
    store.close();
  });

  it('recovers an interrupted draft to a safe composer and returns nextAction send', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'draft-prompt.md');
    await writeFile(promptPath, 'draft');
    const store = new StateStore(fixture.paths.database);
    const turn = store.beginSendTurn(task.taskId, 'draft-turn', promptPath, [join(fixture.root, 'a.txt')], 'draft-op');
    await savePromptCopy(fixture.paths, task.taskId, turn.turn.id, Buffer.from('draft'));
    store.close();

    const status = await fixture.service.recover(task.taskId);
    expect(status).toMatchObject({ nextAction: 'send', turnStatus: null });
    expect(fixture.browser.cleanedComposers).toEqual([task.taskId]);
    expect(fixture.browser.closed).toEqual([]);
    expect(fixture.browser.startCount).toBe(1);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(task.taskId, 'draft-turn')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('interrupted before submission'),
    });
    expect(reopened.requireOperation('draft-op')).toMatchObject({ phase: 'committed' });
    reopened.close();
  });

  it('rebuilds an unbound interrupted draft from seed when in-page cleanup fails', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'draft-prompt.md');
    await writeFile(promptPath, 'draft');
    const store = new StateStore(fixture.paths.database);
    const turn = store.beginSendTurn(task.taskId, 'draft-turn', promptPath, [join(fixture.root, 'a.txt')], 'draft-op');
    await savePromptCopy(fixture.paths, task.taskId, turn.turn.id, Buffer.from('draft'));
    store.close();
    fixture.browser.cleanSendComposerFailuresRemaining = 1;

    const status = await fixture.service.recover(task.taskId);
    expect(status).toMatchObject({ nextAction: 'send', turnStatus: null });
    expect(fixture.browser.cleanedComposers).toEqual([task.taskId]);
    expect(fixture.browser.cleanSendComposerFailuresRemaining).toBe(0);
    expect(fixture.browser.closed).toEqual([task.taskId]);
    expect(fixture.browser.recoveredConversations).toEqual([]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(task.taskId, 'draft-turn')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('cleaned or rebuilt'),
    });
    expect(reopened.requireOperation('draft-op')).toMatchObject({ phase: 'committed' });
    reopened.close();
  });

  it('rebuilds a bound interrupted draft to its exact canonical conversation', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'bound draft');
    const first = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, first.turnId, 20_000, 20_000);
    const store = new StateStore(fixture.paths.database);
    const bound = store.requireTask(task.taskId);
    expect(bound.conversationId).toBe(`conversation-${task.taskId}`);
    const turn = store.beginSendTurn(
      task.taskId,
      'draft-turn-2',
      promptPath,
      [join(fixture.root, 'a.txt')],
      'draft-op-2',
    );
    await savePromptCopy(fixture.paths, task.taskId, turn.turn.id, Buffer.from('bound draft'));
    store.close();
    fixture.browser.cleanSendComposerFailuresRemaining = 1;

    const status = await fixture.service.recover(task.taskId);
    expect(status).toMatchObject({ nextAction: 'send', turnStatus: null });
    expect(fixture.browser.closed).toEqual([task.taskId]);
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(task.taskId).conversationId).toBe(`conversation-${task.taskId}`);
    expect(reopened.requireTurn(task.taskId, 'draft-turn-2')).toMatchObject({ status: 'failed' });
    expect(reopened.requireOperation('draft-op-2')).toMatchObject({ phase: 'committed' });
    reopened.close();
  });

  it('keeps an unprovable draft recoverable when the rebuild fallback fails', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'draft-prompt.md');
    await writeFile(promptPath, 'draft');
    const store = new StateStore(fixture.paths.database);
    const turn = store.beginSendTurn(task.taskId, 'draft-turn', promptPath, [join(fixture.root, 'a.txt')], 'draft-op');
    await savePromptCopy(fixture.paths, task.taskId, turn.turn.id, Buffer.from('draft'));
    store.close();
    fixture.browser.cleanSendComposerFailuresRemaining = 100;

    await expect(fixture.service.recover(task.taskId)).rejects.toThrow('injected composer cleanup failure');
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(task.taskId).status).toBe('active');
    expect(reopened.requireTurn(task.taskId, 'draft-turn')).toMatchObject({ status: 'sending' });
    expect(reopened.requireOperation('draft-op')).toMatchObject({ kind: 'send', step: 'draft', phase: 'prepared' });
    expect(reopened.getStatus(task.taskId, 'available').nextAction).toBe('recover');
    reopened.close();

    fixture.browser.cleanSendComposerFailuresRemaining = 1;
    const status = await fixture.service.recover(task.taskId);
    expect(status).toMatchObject({ nextAction: 'send', turnStatus: null });
    const settled = new StateStore(fixture.paths.database);
    expect(settled.requireTurn(task.taskId, 'draft-turn')).toMatchObject({ status: 'failed' });
    expect(settled.requireOperation('draft-op')).toMatchObject({ phase: 'committed' });
    settled.close();
  });

  it('keeps an unsafe send recoverable without failing the task when the rebuild fallback fails', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'unsafe cleanup');
    fixture.browser.nextSendStatus = 'unsafe-not-submitted';
    fixture.browser.cleanSendComposerFailuresRemaining = 100;

    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toThrow(
      'injected composer cleanup failure',
    );
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(task.taskId).status).toBe('active');
    expect(store.listTurns(task.taskId)).toMatchObject([{ status: 'sending' }]);
    expect(
      store.listOperations(task.taskId).find((operation) => {
        return operation.kind === 'send';
      }),
    ).toMatchObject({ kind: 'send', step: 'draft', phase: 'prepared' });
    expect(store.getStatus(task.taskId, 'available').nextAction).toBe('recover');
    store.close();
  });

  it('treats a single archive attachment as one opaque upload item', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'archive-prompt.md');
    const archivePath = join(fixture.root, 'inputs.tar.gz');
    await Promise.all([writeFile(promptPath, 'archive'), writeFile(archivePath, 'not-a-real-tarball')]);
    const result = await fixture.service.send(task.taskId, promptPath, [archivePath]);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, result.turnId).attachmentPaths).toEqual([archivePath]);
    store.close();
    expect(fixture.browser.expectedConversationIds).toEqual([null]);
  });
});

describe('BEH-002 caller-provided task start', () => {
  it('rejects a non-canonical taskId before any database or browser side effect', async () => {
    const fixture = await serviceFixture();
    await writeFile(fixture.paths.seedState, validSeedText());
    for (const invalid of ['task-1', '123e4567-e89b-12d3-a456-426614174000', 'ABC', '']) {
      await expect(fixture.service.start(invalid)).rejects.toMatchObject({ code: 'USAGE' });
    }
    const store = new StateStore(fixture.paths.database);
    expect(store.listOperations()).toEqual([]);
    store.close();
    expect(fixture.browser.startCount).toBe(0);
  });

  it('starts a task and journals the fixed Project and model/mode readbacks', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const started = await fixture.service.start(taskId);
    expect(started.taskId).toBe(taskId);
    expect(started.contextMarker).toBe(`context-${taskId}`);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(taskId)).toMatchObject({ status: 'active' });
    expect(store.listOperations(taskId)).toMatchObject([
      {
        kind: 'start',
        phase: 'committed',
        resolutionSource: 'automatic',
        evidence: {
          projectIdentity: 'g-p-123',
          modelConfirmed: true,
          powerConfirmed: true,
          powerNow: 4,
          powerMin: 0,
          powerMax: 4,
        },
      },
    ]);
    store.close();
  });

  it('resumes the same starting task and never allocates a second identity', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const first = await fixture.service.start(taskId);
    const resumed = await fixture.service.start(taskId);
    expect(resumed.taskId).toBe(taskId);
    expect(first.taskId).toBe(taskId);
    const store = new StateStore(fixture.paths.database);
    expect(store.listOperations(taskId)).toHaveLength(1);
    expect(store.requireTask(taskId).playwrightSession).toBe(`chatgpt-pro-collab-${taskId}`);
    store.close();
  });

  it('resumes a start whose journal already reached the configuration step', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const store = new StateStore(fixture.paths.database);
    store.createStartingTask(taskId, `chatgpt-pro-collab-${taskId}`, 'start-op');
    store.markOperationEffectUnknown('start-op', {
      observedAt: new Date().toISOString(),
      sessionName: `chatgpt-pro-collab-${taskId}`,
      postcondition: 'start browser commands released',
    });
    store.advanceOperationStep('start-op', 'project', {
      observedAt: new Date().toISOString(),
      sessionName: `chatgpt-pro-collab-${taskId}`,
      pageUrl: 'https://chatgpt.com/g/g-p-123/project',
      postcondition: 'fixed Project and blank composer verified',
    });
    store.close();

    const resumed = await fixture.service.start(taskId);
    expect(resumed.taskId).toBe(taskId);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(taskId)).toMatchObject({ status: 'active' });
    expect(reopened.requireOperation('start-op')).toMatchObject({ step: 'configuration', phase: 'committed' });
    reopened.close();
  });

  it('activates a starting task whose start operation was already committed', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const store = new StateStore(fixture.paths.database);
    store.createStartingTask(taskId, `chatgpt-pro-collab-${taskId}`, 'start-op');
    store.markOperationEffectUnknown('start-op', {
      observedAt: new Date().toISOString(),
      sessionName: `chatgpt-pro-collab-${taskId}`,
      postcondition: 'start browser commands released',
    });
    store.advanceOperationStep('start-op', 'project', {
      observedAt: new Date().toISOString(),
      sessionName: `chatgpt-pro-collab-${taskId}`,
      postcondition: 'fixed Project and blank composer verified',
    });
    store.advanceOperationStep('start-op', 'configuration', {
      observedAt: new Date().toISOString(),
      sessionName: `chatgpt-pro-collab-${taskId}`,
      postcondition: 'current model GPT-5.6 Sol read back and Power slider at the maximum level',
      projectIdentity: 'g-p-123',
      modelConfirmed: true,
      powerConfirmed: true,
      powerNow: 4,
      powerMin: 0,
      powerMax: 4,
    });
    store.commitOperation('start-op', 'automatic');
    store.close();

    const resumed = await fixture.service.start(taskId);
    expect(resumed.taskId).toBe(taskId);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(taskId)).toMatchObject({ status: 'active' });
    reopened.close();
  });

  it('joins a concurrently reserved starting task instead of returning a conflict', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const store = new StateStore(fixture.paths.database);
    store.createStartingTask(taskId, `chatgpt-pro-collab-${taskId}`, 'winner-op');
    store.close();

    const joined = await fixture.service.start(taskId);
    expect(joined.taskId).toBe(taskId);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(taskId)).toMatchObject({ status: 'active' });
    expect(reopened.listOperations(taskId)).toHaveLength(1);
    reopened.close();
  });

  it('returns the same active task before a conversation is bound and conflicts afterwards', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    await fixture.service.start(taskId);
    const resumed = await fixture.service.start(taskId);
    expect(resumed.taskId).toBe(taskId);

    const promptPath = join(fixture.root, 'bind-prompt.md');
    await writeFile(promptPath, 'bind');
    await fixture.service.send(taskId, promptPath, []);
    await expect(fixture.service.start(taskId)).rejects.toMatchObject({ code: 'TASK_CONFLICT' });
  });

  it('conflicts with closing, closed, and failed task identities', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const closedId = randomUUID();
    await fixture.service.start(closedId);
    await fixture.service.close(closedId);
    await expect(fixture.service.start(closedId)).rejects.toMatchObject({ code: 'TASK_CONFLICT' });

    const failedId = randomUUID();
    fixture.browser.nextStartFailureCode = 'PROJECT_NOT_FOUND';
    await expect(fixture.service.start(failedId)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    fixture.browser.nextStartFailureCode = null;
    await expect(fixture.service.start(failedId)).rejects.toMatchObject({ code: 'TASK_CONFLICT' });
  });

  it('keeps a starting task recoverable when the browser fails without a definite page verdict', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    fixture.browser.nextStartFailureCode = 'BROWSER_COMMAND_FAILED';
    await expect(fixture.service.start(taskId)).rejects.toMatchObject({ code: 'BROWSER_COMMAND_FAILED' });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(taskId)).toMatchObject({ status: 'starting' });
    expect(store.getUncommittedTaskOperation(taskId)).toMatchObject({ kind: 'start', phase: 'effect-unknown' });
    store.close();

    fixture.browser.nextStartFailureCode = null;
    const resumed = await fixture.service.start(taskId);
    expect(resumed.taskId).toBe(taskId);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(taskId)).toMatchObject({ status: 'active' });
    reopened.close();
  });

  it('marks a definitely failed start failed and commits the journal', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    fixture.browser.nextStartFailureCode = 'FIXED_TARGET_UNAVAILABLE';
    await expect(fixture.service.start(taskId)).rejects.toMatchObject({ code: 'FIXED_TARGET_UNAVAILABLE' });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(taskId)).toMatchObject({ status: 'failed' });
    expect(store.getUncommittedTaskOperation(taskId)).toBeNull();
    expect(store.listOperations(taskId)).toMatchObject([
      { kind: 'start', phase: 'committed', error: expect.stringContaining('FIXED_TARGET_UNAVAILABLE') },
    ]);
    store.close();
    expect(fixture.browser.startCount).toBe(1);
  });

  it('rejects a start invocation without a taskId in the CLI', async () => {
    const fixture = await serviceFixture();
    const errors: string[] = [];
    const io: CliIo = {
      writeOutput() {},
      writeError(value) {
        errors.push(value);
      },
    };
    await expect(runCli(['start'], fixture.service, io)).resolves.toBe(1);
    expect(JSON.parse(errors.at(-1) ?? '{}')).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });
});

describe('BEH-013 recovery matrix completion', () => {
  it('auto-verifies a released submission and binds the turn with automatic evidence', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const firstPromptPath = join(fixture.root, 'bound.md');
    await writeFile(firstPromptPath, 'bound prompt');
    const seedStore = new StateStore(fixture.paths.database);
    seedStore.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
    seedStore.close();
    const firstTurn = await fixture.service.send(taskId, firstPromptPath, []);
    await fixture.service.wait(taskId, firstTurn.turnId, 20_000, 20_000);
    const turnId = 'crashed-turn';
    const promptPath = join(fixture.root, 'crashed.md');
    await writeFile(promptPath, 'crashed prompt');
    const store = new StateStore(fixture.paths.database);
    store.beginSendTurn(taskId, turnId, promptPath, [], 'send-op');
    store.advanceSendToSubmitEffectUnknown('send-op', {
      observedAt: new Date().toISOString(),
      sessionName: `chatgpt-pro-collab-${taskId}`,
      postcondition: 'submit command released',
    });
    store.close();
    await savePromptCopy(fixture.paths, taskId, turnId, Buffer.from('crashed prompt'));

    const status = await fixture.service.recover(taskId);
    expect(status).toMatchObject({ taskStatus: 'active', turnStatus: 'pending', nextAction: 'wait' });
    expect(fixture.browser.autoVerifications).toEqual([taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(taskId, turnId)).toMatchObject({
      status: 'pending',
      userTurnIdentity: `user-turn-${taskId}`,
    });
    expect(reopened.requireOperation('send-op')).toMatchObject({
      phase: 'committed',
      resolutionSource: 'automatic',
      evidence: { promptVerbatimMatch: true, attachmentNamesMatch: true },
    });
    reopened.close();
  });

  it('opens the decision gate when page evidence cannot prove the submission', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const turnId = 'unresolved-turn';
    const promptPath = join(fixture.root, 'unresolved.md');
    await writeFile(promptPath, 'unresolved prompt');
    const store = new StateStore(fixture.paths.database);
    store.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
    store.beginSendTurn(taskId, turnId, promptPath, [], 'send-op');
    store.advanceSendToSubmitEffectUnknown('send-op');
    store.close();
    await savePromptCopy(fixture.paths, taskId, turnId, Buffer.from('unresolved prompt'));
    fixture.browser.nextAutoVerifyUnresolved = taskId;

    const status = await fixture.service.recover(taskId);
    expect(status).toMatchObject({ turnStatus: 'unknown-submission', nextAction: 'resolve-submission' });
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireOperation('send-op')).toMatchObject({ phase: 'needs-decision' });
    reopened.close();
  });

  it('rebuilds the Project context and opens the decision gate without guessing for an unbound submission', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const turnId = 'no-browser-turn';
    const promptPath = join(fixture.root, 'no-browser.md');
    await writeFile(promptPath, 'no browser prompt');
    const store = new StateStore(fixture.paths.database);
    store.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
    store.beginSendTurn(taskId, turnId, promptPath, [], 'send-op');
    store.advanceSendToSubmitEffectUnknown('send-op');
    store.close();
    await savePromptCopy(fixture.paths, taskId, turnId, Buffer.from('no browser prompt'));
    fixture.browser.sessionAvailabilityResult = 'missing';

    const status = await fixture.service.recover(taskId);
    expect(status).toMatchObject({
      turnStatus: 'unknown-submission',
      browserStatus: 'available',
      nextAction: 'resolve-submission',
    });
    expect(fixture.browser.autoVerifications).toEqual([taskId]);
    expect(fixture.browser.startCount).toBe(1);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireOperation('send-op')).toMatchObject({ phase: 'needs-decision' });
    reopened.close();
  });

  it('auto-verifies and binds an unbound first submission when the original session shows the canonical conversation', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const turnId = 'unbound-canonical-turn';
    const promptPath = join(fixture.root, 'unbound-canonical.md');
    await writeFile(promptPath, 'unbound canonical prompt');
    const store = new StateStore(fixture.paths.database);
    store.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
    store.beginSendTurn(taskId, turnId, promptPath, [], 'send-op');
    store.advanceSendToSubmitEffectUnknown('send-op');
    store.close();
    await savePromptCopy(fixture.paths, taskId, turnId, Buffer.from('unbound canonical prompt'));
    fixture.browser.autoVerifyConversationId = `canonical-${taskId}`;

    const status = await fixture.service.recover(taskId);
    expect(status).toMatchObject({
      turnStatus: 'pending',
      browserStatus: 'available',
      nextAction: 'wait',
    });
    expect(fixture.browser.autoVerifications).toEqual([taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(taskId)).toMatchObject({
      conversationId: `canonical-${taskId}`,
    });
    expect(reopened.requireTurn(taskId, turnId)).toMatchObject({ status: 'pending' });
    expect(reopened.requireOperation('send-op')).toMatchObject({ phase: 'committed' });
    reopened.close();
  });

  it('serializes concurrent recover calls into one rebuild and one verification', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'concurrent-recover.md');
    await writeFile(promptPath, 'concurrent');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    fixture.browser.sessionAvailabilityResult = 'missing';

    const [first, second] = await Promise.all([
      fixture.service.recover(task.taskId),
      fixture.service.recover(task.taskId),
    ]);
    expect(first.browserStatus).toBe('available');
    expect(second.browserStatus).toBe('available');
    expect(fixture.browser.startCount).toBe(2);
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
  });

  it('rebuilds the session and auto-verifies a bound effect-unknown submission', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const firstPromptPath = join(fixture.root, 'bound-recover.md');
    await writeFile(firstPromptPath, 'bound recover');
    const seedStore = new StateStore(fixture.paths.database);
    seedStore.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
    seedStore.close();
    const firstTurn = await fixture.service.send(taskId, firstPromptPath, []);
    await fixture.service.wait(taskId, firstTurn.turnId, 20_000, 20_000);
    const turnId = 'crashed-bound-turn';
    const promptPath = join(fixture.root, 'crashed-bound.md');
    await writeFile(promptPath, 'crashed bound prompt');
    const store = new StateStore(fixture.paths.database);
    store.beginSendTurn(taskId, turnId, promptPath, [], 'send-op');
    store.advanceSendToSubmitEffectUnknown('send-op');
    store.close();
    await savePromptCopy(fixture.paths, taskId, turnId, Buffer.from('crashed bound prompt'));
    fixture.browser.sessionAvailabilityResult = 'missing';

    const status = await fixture.service.recover(taskId);
    expect(status).toMatchObject({ turnStatus: 'pending', browserStatus: 'available', nextAction: 'wait' });
    expect(fixture.browser.startCount).toBe(1);
    expect(fixture.browser.recoveredConversations).toEqual([taskId]);
    expect(fixture.browser.autoVerifications).toEqual([taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(taskId, turnId)).toMatchObject({ status: 'pending' });
    reopened.close();
  });

  it('rebuilds the session before resolving a submitted adjudication', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const turnId = 'resolved-turn';
    const promptPath = join(fixture.root, 'resolve-rebuild.md');
    await writeFile(promptPath, 'resolved prompt');
    const store = new StateStore(fixture.paths.database);
    store.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
    store.beginTurn(taskId, turnId, promptPath, []);
    store.markSubmissionAttempting(taskId, turnId);
    store.createOperation({
      id: 'send-op',
      kind: 'send',
      step: 'submit',
      taskId,
      turnId,
      sessionName: `chatgpt-pro-collab-${taskId}`,
    });
    store.markOperationEffectUnknown('send-op');
    store.markOperationNeedsDecision('send-op');
    store.close();
    await savePromptCopy(fixture.paths, taskId, turnId, Buffer.from('resolved prompt'));
    fixture.browser.sessionAvailabilityResult = 'missing';

    const status = await fixture.service.resolveSubmission(
      taskId,
      turnId,
      'submitted',
      `https://chatgpt.com/c/conversation-${taskId}`,
    );
    expect(status).toMatchObject({ turnStatus: 'pending', browserStatus: 'available', nextAction: 'wait' });
    expect(fixture.browser.startCount).toBe(1);
    expect(fixture.browser.resolvedSubmissions).toEqual([taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(taskId, turnId)).toMatchObject({ status: 'pending' });
    reopened.close();
  });

  it('rejects a submitted adjudication whose page verification fails', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = randomUUID();
    const turnId = 'failed-verify-turn';
    const promptPath = join(fixture.root, 'failed-verify.md');
    await writeFile(promptPath, 'failed verify');
    const store = new StateStore(fixture.paths.database);
    store.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
    store.beginTurn(taskId, turnId, promptPath, []);
    store.markSubmissionAttempting(taskId, turnId);
    store.createOperation({
      id: 'send-op',
      kind: 'send',
      step: 'submit',
      taskId,
      turnId,
      sessionName: `chatgpt-pro-collab-${taskId}`,
    });
    store.markOperationEffectUnknown('send-op');
    store.markOperationNeedsDecision('send-op');
    store.close();
    await savePromptCopy(fixture.paths, taskId, turnId, Buffer.from('failed verify'));
    fixture.browser.nextVerifySafeComposerFailureTaskId = taskId;

    await expect(fixture.service.resolveSubmission(taskId, turnId, 'not-submitted')).rejects.toThrow(
      /safe composer verification failure/,
    );
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(taskId, turnId).status).toBe('unknown-submission');
    expect(reopened.requireOperation('send-op').phase).toBe('needs-decision');
    reopened.close();
  });
});

describe('BEH-008 local close and BEH-009 archive journal', () => {
  it('persists closing before terminating the browser and completes on a repeated close', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const store = new StateStore(fixture.paths.database);
    store.markTaskClosing(task.taskId);
    store.close();

    const status = await fixture.service.status(task.taskId);
    expect(status).toMatchObject({ taskStatus: 'closing', nextAction: 'close' });
    expect(fixture.browser.closed).toEqual([]);
    await expect(fixture.service.close(task.taskId)).resolves.toMatchObject({ alreadyClosed: false });
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(task.taskId)).toMatchObject({ status: 'closed' });
    reopened.close();
    expect(fixture.browser.closed).toEqual([task.taskId]);
  });

  it('journals the archive click with canonical identity evidence', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'archive-journal.md');
    await writeFile(promptPath, 'archive journal');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);

    await fixture.service.archive(task.taskId);
    const store = new StateStore(fixture.paths.database);
    const archiveOperation = store.listOperations(task.taskId).find((operation) => {
      return operation.kind === 'archive';
    });
    expect(archiveOperation).toMatchObject({
      phase: 'committed',
      resolutionSource: 'automatic',
      evidence: {
        conversationId: `conversation-${task.taskId}`,
        archived: true,
        bindingRestored: true,
      },
    });
    expect(store.requireTask(task.taskId)).toMatchObject({ status: 'active' });
    store.close();
    expect(fixture.browser.archived).toEqual([task.taskId]);
  });

  it('restores the binding without a second Archive click when the Web conversation is already archived', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'already-archived.md');
    await writeFile(promptPath, 'already archived');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    const store = new StateStore(fixture.paths.database);
    store.createOperation({
      id: 'archive-op',
      kind: 'archive',
      step: 'archive',
      taskId: task.taskId,
      turnId: null,
      sessionName: `chatgpt-pro-collab-${task.taskId}`,
    });
    store.markOperationEffectUnknown('archive-op', {
      observedAt: new Date().toISOString(),
      sessionName: `chatgpt-pro-collab-${task.taskId}`,
      conversationId: `conversation-${task.taskId}`,
    });
    store.close();

    await fixture.service.archive(task.taskId);
    expect(fixture.browser.archived).toEqual([]);
    expect(fixture.browser.archiveObservations).toEqual([task.taskId]);
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireOperation('archive-op')).toMatchObject({
      phase: 'committed',
      evidence: { archived: true, bindingRestored: true },
    });
    reopened.close();
  });

  it('retries the archive exactly once when the Web state provably was not archived', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'not-archived.md');
    await writeFile(promptPath, 'not archived');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    fixture.browser.nextArchiveState = 'not-archived';
    const store = new StateStore(fixture.paths.database);
    store.createOperation({
      id: 'archive-op',
      kind: 'archive',
      step: 'archive',
      taskId: task.taskId,
      turnId: null,
      sessionName: `chatgpt-pro-collab-${task.taskId}`,
    });
    store.markOperationEffectUnknown('archive-op');
    store.close();

    await fixture.service.archive(task.taskId);
    expect(fixture.browser.archived).toEqual([task.taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireOperation('archive-op')).toMatchObject({
      phase: 'committed',
      evidence: { archived: true, bindingRestored: true },
    });
    reopened.close();
  });

  it('never repeats an Archive click when the Web state cannot be proven', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'unknown-archive.md');
    await writeFile(promptPath, 'unknown archive');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    fixture.browser.nextArchiveStateUnknown = task.taskId;
    const store = new StateStore(fixture.paths.database);
    store.createOperation({
      id: 'archive-op',
      kind: 'archive',
      step: 'archive',
      taskId: task.taskId,
      turnId: null,
      sessionName: `chatgpt-pro-collab-${task.taskId}`,
    });
    store.markOperationEffectUnknown('archive-op');
    store.close();

    await expect(fixture.service.archive(task.taskId)).rejects.toMatchObject({ code: 'ARCHIVE_STATE_UNKNOWN' });
    expect(fixture.browser.archived).toEqual([]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireOperation('archive-op')).toMatchObject({ phase: 'effect-unknown' });
    reopened.close();
  });
});

describe('BEH-008 closed task recovery to the same conversation', () => {
  it('resumes a closed task with a completed turn on the same canonical conversation for feedback', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'closed-round-one.md');
    await writeFile(promptPath, 'round one');
    const firstTurn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, firstTurn.turnId, 20_000, 20_000);
    const beforeClose = new StateStore(fixture.paths.database);
    const beforeCloseTask = beforeClose.requireTask(task.taskId);
    expect(beforeCloseTask.conversationId).toBe(`conversation-${task.taskId}`);
    expect(beforeCloseTask.conversationUrl).toBe(`https://chatgpt.com/c/conversation-${task.taskId}`);
    beforeClose.close();

    await expect(fixture.service.close(task.taskId)).resolves.toMatchObject({ alreadyClosed: false });
    fixture.browser.sessionAvailabilityResult = 'missing';
    const closedStatus = await fixture.service.status(task.taskId);
    expect(closedStatus).toMatchObject({ taskStatus: 'closed', nextAction: 'recover' });

    const recovered = await fixture.service.recover(task.taskId);
    expect(recovered).toMatchObject({ taskStatus: 'active', browserStatus: 'available', nextAction: 'none' });
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
    const afterRecover = new StateStore(fixture.paths.database);
    const afterRecoverTask = afterRecover.requireTask(task.taskId);
    expect(afterRecoverTask).toMatchObject({
      status: 'active',
      closedAt: null,
      conversationId: `conversation-${task.taskId}`,
      conversationUrl: `https://chatgpt.com/c/conversation-${task.taskId}`,
    });
    expect(afterRecoverTask.playwrightSession).toBe(beforeCloseTask.playwrightSession);
    afterRecover.close();

    await writeFile(promptPath, 'round two feedback');
    const feedbackTurn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, feedbackTurn.turnId, 20_000, 20_000);
    const finalStore = new StateStore(fixture.paths.database);
    expect(finalStore.requireTask(task.taskId).conversationId).toBe(`conversation-${task.taskId}`);
    expect(finalStore.listTurns(task.taskId)).toHaveLength(2);
    finalStore.close();
    expect(fixture.browser.expectedConversationIds).toEqual([null, `conversation-${task.taskId}`]);
  });

  it('recovers a closed task with a pending turn back to wait without resending', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'closed-pending.md');
    await writeFile(promptPath, 'pending close');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.close(task.taskId);
    fixture.browser.sessionAvailabilityResult = 'missing';

    expect(await fixture.service.status(task.taskId)).toMatchObject({ taskStatus: 'closed', nextAction: 'recover' });
    const recovered = await fixture.service.recover(task.taskId);
    expect(recovered).toMatchObject({ taskStatus: 'active', turnStatus: 'pending', nextAction: 'wait' });
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).resolves.toMatchObject({
      status: 'completed',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId).status).toBe('completed');
    store.close();
  });

  it('recovers a closed task with a frozen capturing turn back to wait without resending', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'closed-capturing.md');
    await writeFile(promptPath, 'capturing close');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    const store = new StateStore(fixture.paths.database);
    store.freezeCapture(task.taskId, turn.turnId, responsePath(fixture.paths, task.taskId, turn.turnId), []);
    store.close();
    await fixture.service.close(task.taskId);
    fixture.browser.sessionAvailabilityResult = 'missing';

    expect(await fixture.service.status(task.taskId)).toMatchObject({ taskStatus: 'closed', nextAction: 'recover' });
    const recovered = await fixture.service.recover(task.taskId);
    expect(recovered).toMatchObject({ taskStatus: 'active', turnStatus: 'capturing', nextAction: 'wait' });
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(task.taskId)).toMatchObject({
      status: 'active',
      conversationId: `conversation-${task.taskId}`,
    });
    expect(reopened.requireTurn(task.taskId, turn.turnId)).toMatchObject({ status: 'capturing' });
    reopened.close();

    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).resolves.toMatchObject({
      status: 'completed',
    });
    const finalStore = new StateStore(fixture.paths.database);
    expect(finalStore.requireTurn(task.taskId, turn.turnId).status).toBe('completed');
    expect(finalStore.listTurns(task.taskId)).toHaveLength(1);
    finalStore.close();
    expect(fixture.browser.expectedConversationIds).toEqual([null]);
    expect(fixture.browser.expectedAssistantTurnIds).toEqual([null]);
  });

  it('keeps a closed bound task closed when conversation identity verification fails and recovers on retry', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'closed-identity-fails.md');
    await writeFile(promptPath, 'identity fails');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    await fixture.service.close(task.taskId);
    fixture.browser.sessionAvailabilityResult = 'missing';
    fixture.browser.nextRecoverConversationIdentityFailureTaskId = task.taskId;

    await expect(fixture.service.recover(task.taskId)).rejects.toMatchObject({ code: 'BROWSER_COMMAND_FAILED' });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(task.taskId)).toMatchObject({
      status: 'closed',
      closedAt: expect.any(String),
      conversationId: `conversation-${task.taskId}`,
      conversationUrl: `https://chatgpt.com/c/conversation-${task.taskId}`,
    });
    expect(store.requireTurn(task.taskId, turn.turnId).status).toBe('completed');
    store.close();
    expect(fixture.browser.recoveredConversations).toEqual([]);

    const recovered = await fixture.service.recover(task.taskId);
    expect(recovered).toMatchObject({ taskStatus: 'active', browserStatus: 'available', nextAction: 'none' });
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(task.taskId)).toMatchObject({
      status: 'active',
      closedAt: null,
      conversationId: `conversation-${task.taskId}`,
      conversationUrl: `https://chatgpt.com/c/conversation-${task.taskId}`,
    });
    expect(reopened.requireTurn(task.taskId, turn.turnId).status).toBe('completed');
    reopened.close();
  });

  it('recovers an unbound closed task to the fixed Project blank composer', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    await fixture.service.close(task.taskId);
    fixture.browser.sessionAvailabilityResult = 'missing';

    const recovered = await fixture.service.recover(task.taskId);
    expect(recovered).toMatchObject({ taskStatus: 'active', browserStatus: 'available', nextAction: 'none' });
    expect(fixture.browser.recoveredConversations).toEqual([]);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(task.taskId)).toMatchObject({ status: 'active', conversationId: null, closedAt: null });
    store.close();
  });

  it('keeps a closed task closed when the session rebuild fails and recovers on a later retry', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'closed-rebuild-fails.md');
    await writeFile(promptPath, 'rebuild fails');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    await fixture.service.close(task.taskId);
    fixture.browser.sessionAvailabilityResult = 'missing';
    fixture.browser.nextStartFailureCode = 'BROWSER_COMMAND_FAILED';

    await expect(fixture.service.recover(task.taskId)).rejects.toMatchObject({ code: 'BROWSER_COMMAND_FAILED' });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(task.taskId)).toMatchObject({ status: 'closed' });
    store.close();
    expect(fixture.browser.recoveredConversations).toEqual([]);

    fixture.browser.nextStartFailureCode = null;
    const recovered = await fixture.service.recover(task.taskId);
    expect(recovered).toMatchObject({ taskStatus: 'active', browserStatus: 'available', nextAction: 'none' });
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTask(task.taskId).status).toBe('active');
    reopened.close();
  });

  it('creates only one named session and one conversation recovery for concurrent closed-task recovers', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'closed-concurrent.md');
    await writeFile(promptPath, 'concurrent closed');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    await fixture.service.close(task.taskId);
    fixture.browser.sessionAvailabilityResult = 'missing';

    const [first, second] = await Promise.all([
      fixture.service.recover(task.taskId),
      fixture.service.recover(task.taskId),
    ]);
    expect(first).toMatchObject({ taskStatus: 'active', browserStatus: 'available', nextAction: 'none' });
    expect(second).toMatchObject({ taskStatus: 'active', browserStatus: 'available', nextAction: 'none' });
    expect(fixture.browser.startCount).toBe(2);
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(task.taskId).status).toBe('active');
    store.close();
  });
});

describe('BEH-005 and BEH-006 multi-turn and cross-task concurrency', () => {
  it('keeps one conversation across turns with independent turn files', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'multi.md');
    await writeFile(promptPath, 'turn one');
    const firstTurn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, firstTurn.turnId, 20_000, 20_000);
    await writeFile(promptPath, 'turn two');
    const secondTurn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, secondTurn.turnId, 20_000, 20_000);

    const store = new StateStore(fixture.paths.database);
    const taskRow = store.requireTask(task.taskId);
    expect(taskRow.conversationId).toBe(`conversation-${task.taskId}`);
    const turns = store.listTurns(task.taskId);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.responsePath).not.toBe(turns[1]?.responsePath);
    expect(turns[0]?.userTurnIdentity).not.toBe(turns[1]?.userTurnIdentity);
    store.close();
    expect(fixture.browser.expectedConversationIds).toEqual([null, `conversation-${task.taskId}`]);
    expect(
      await readFile(
        join(fixture.paths.sessionsDirectory, task.taskId, 'turns', firstTurn.turnId, 'prompt.md'),
        'utf8',
      ),
    ).toBe('turn one');
    expect(
      await readFile(
        join(fixture.paths.sessionsDirectory, task.taskId, 'turns', secondTurn.turnId, 'prompt.md'),
        'utf8',
      ),
    ).toBe('turn two');
  });

  it('keeps two tasks fully isolated while their waits overlap', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const firstTask = await fixture.start();
    const secondTask = await fixture.start();
    const firstPrompt = join(fixture.root, 'a.md');
    const secondPrompt = join(fixture.root, 'b.md');
    await Promise.all([writeFile(firstPrompt, 'a'), writeFile(secondPrompt, 'b')]);
    fixture.browser.responseArtifacts.push(
      { sourceUrl: 'sandbox:/mnt/data/only-a.txt', label: 'only-a.txt' },
      { sourceUrl: 'sandbox:/mnt/data/only-b.txt', label: 'only-b.txt' },
    );
    const firstTurn = await fixture.service.send(firstTask.taskId, firstPrompt, []);
    const secondTurn = await fixture.service.send(secondTask.taskId, secondPrompt, []);
    fixture.browser.captureDelayMs = 30;

    const [firstResult, secondResult] = await Promise.all([
      fixture.service.wait(firstTask.taskId, firstTurn.turnId, 20_000, 20_000),
      fixture.service.wait(secondTask.taskId, secondTurn.turnId, 20_000, 20_000),
    ]);
    expect(firstResult).toMatchObject({ status: 'completed' });
    expect(secondResult).toMatchObject({ status: 'completed' });
    expect(fixture.browser.maxConcurrentCaptures).toBe(2);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(firstTask.taskId).conversationId).toBe(`conversation-${firstTask.taskId}`);
    expect(store.requireTask(secondTask.taskId).conversationId).toBe(`conversation-${secondTask.taskId}`);
    expect(store.requireTask(firstTask.taskId).playwrightSession).not.toBe(
      store.requireTask(secondTask.taskId).playwrightSession,
    );
    expect(store.listTurns(firstTask.taskId)[0]?.responsePath).not.toBe(
      store.listTurns(secondTask.taskId)[0]?.responsePath,
    );
    store.close();
    expect(fixture.browser.expectedConversationIds).toEqual([null, null]);
  });
});

describe('BEH-012 returned file capture and recoverable publication', () => {
  it('returns completed with an empty artifact list when the reply has no files', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'no-files.md');
    await writeFile(promptPath, 'no files');
    const turn = await fixture.service.send(task.taskId, promptPath, []);

    const completed = await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    expect(completed).toMatchObject({ status: 'completed', artifactPaths: [] });
    const store = new StateStore(fixture.paths.database);
    expect(store.listArtifacts(task.taskId, turn.turnId)).toEqual([]);
    store.close();
  });

  it('never returns a successful pending after completion was observed even across the observation deadline', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'late-files.md');
    await writeFile(promptPath, 'late files');
    fixture.browser.responseArtifacts.push({
      sourceUrl: 'sandbox:/mnt/data/late.txt',
      label: 'late.txt',
    });
    fixture.browser.captureDelayMs = 60;
    const turn = await fixture.service.send(task.taskId, promptPath, []);

    const completed = await fixture.service.wait(task.taskId, turn.turnId, 1, 20_000);
    expect(completed).toMatchObject({ status: 'completed', artifactPaths: [expect.any(String)] });
    const artifactPaths = (completed as unknown as { artifactPaths: string[] }).artifactPaths;
    expect(await readFile(artifactPaths[0] ?? '', 'utf8')).toBe('artifact for sandbox:/mnt/data/late.txt');
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId).status).toBe('completed');
    store.close();
  });
});

describe('BEH-004 wait observation anchored on the persisted user turn', () => {
  it('observes only the assistant after the exact persisted user turn identity', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'anchor-prompt.md');
    await writeFile(promptPath, 'anchored');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    const store = new StateStore(fixture.paths.database);
    const identity = store.requireTurn(task.taskId, turn.turnId).userTurnIdentity;
    store.close();

    await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    expect(fixture.browser.observedUserTurnIds).toEqual([identity]);
    expect(fixture.browser.observedUserTurnIds[0]).toBe(`user-turn-${task.taskId}-1`);
  });

  it('rejects a pending turn whose persisted user identity is missing', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'missing-anchor.md');
    await writeFile(promptPath, 'missing');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    const store = new StateStore(fixture.paths.database);
    store.close();
    const raw = new DatabaseSync(fixture.paths.database);
    raw.prepare('UPDATE turn SET user_turn_identity = NULL WHERE task_id = ? AND id = ?').run(task.taskId, turn.turnId);
    raw.close();

    await expect(fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000)).rejects.toMatchObject({
      code: 'TRANSCRIPT_INCONSISTENT',
    });
  });
});

describe('BEH-004 periodic reload during pending observation', () => {
  it('reloads the bound conversation purely on 300000ms of uncaptured monotonic time and repeats within the budget', async () => {
    const fixture = await reloadServiceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'reload-prompt.md');
    await writeFile(promptPath, 'long generation');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.pendingWaitPolls = 10_000;

    await expect(fixture.service.wait(task.taskId, turn.turnId, 700_000, 20_000)).resolves.toEqual({
      status: 'pending',
      taskId: task.taskId,
      turnId: turn.turnId,
    });
    expect(fixture.browser.reloadConversationCalls).toBe(2);
    expect(fixture.browser.reloadedConversations).toEqual([
      `conversation-${task.taskId}`,
      `conversation-${task.taskId}`,
    ]);
    expect(fixture.browser.reloadedUserTurnIds).toEqual([`user-turn-${task.taskId}-1`, `user-turn-${task.taskId}-1`]);
    expect(fixture.browser.observeResponseCalls).toBe(14);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId)).toMatchObject({ status: 'pending', responsePath: null });
    expect(store.listArtifacts(task.taskId, turn.turnId)).toEqual([]);
    store.close();
  });

  it('returns pending at window expiry without reload when the window is shorter than one period', async () => {
    const fixture = await reloadServiceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'short-window.md');
    await writeFile(promptPath, 'short window');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.pendingWaitPolls = 10_000;

    await expect(fixture.service.wait(task.taskId, turn.turnId, 100_000, 20_000)).resolves.toEqual({
      status: 'pending',
      taskId: task.taskId,
      turnId: turn.turnId,
    });
    expect(fixture.browser.reloadConversationCalls).toBe(0);
  });

  it('captures the completed response after a periodic reload without changing the turn state', async () => {
    const fixture = await reloadServiceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'reload-complete.md');
    await writeFile(promptPath, 'reload then complete');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.pendingWaitPolls = 7;

    await expect(fixture.service.wait(task.taskId, turn.turnId, 700_000, 20_000)).resolves.toMatchObject({
      status: 'completed',
      turnId: turn.turnId,
    });
    expect(fixture.browser.reloadConversationCalls).toBe(1);
    expect(fixture.browser.observeResponseCalls).toBe(8);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId).status).toBe('completed');
    store.close();
  });

  it('keeps the turn pending without capture when the reload identity check drifts', async () => {
    const fixture = await reloadServiceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'reload-drift.md');
    await writeFile(promptPath, 'reload drift');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.pendingWaitPolls = 10_000;
    fixture.browser.nextReloadConversationFailureTaskId = task.taskId;

    await expect(fixture.service.wait(task.taskId, turn.turnId, 700_000, 20_000)).rejects.toMatchObject({
      code: 'PAGE_CONTRACT_DRIFT',
    });
    expect(fixture.browser.reloadConversationCalls).toBe(1);
    expect(fixture.browser.expectedAssistantTurnIds).toEqual([]);
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId)).toMatchObject({ status: 'pending', responsePath: null });
    expect(store.listArtifacts(task.taskId, turn.turnId)).toEqual([]);
    expect(store.getTaskOperation(task.taskId)).toBeNull();
    store.close();
  });

  it('never reloads while retrying a capturing turn', async () => {
    const fixture = await reloadServiceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'capturing-retry.md');
    await writeFile(promptPath, 'capturing retry');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    const store = new StateStore(fixture.paths.database);
    store.freezeCapture(task.taskId, turn.turnId, responsePath(fixture.paths, task.taskId, turn.turnId), []);
    store.close();

    await expect(fixture.service.wait(task.taskId, turn.turnId, 700_000, 20_000)).resolves.toMatchObject({
      status: 'completed',
      turnId: turn.turnId,
    });
    expect(fixture.browser.reloadConversationCalls).toBe(0);
    expect(fixture.browser.observeResponseCalls).toBe(0);
    expect(fixture.browser.expectedAssistantTurnIds).toEqual([null]);
    const finalStore = new StateStore(fixture.paths.database);
    expect(finalStore.requireTurn(task.taskId, turn.turnId).status).toBe('completed');
    finalStore.close();
  });
});

describe('BEH-013 status, recover, and resolve-submission', () => {
  it('returns a read-only status with browser availability and the safe next action', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'pending-prompt.md');
    await writeFile(promptPath, 'pending');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.sessionAvailabilityResult = 'missing';

    const status = await fixture.service.status(task.taskId);
    expect(status).toMatchObject({
      taskId: task.taskId,
      taskStatus: 'active',
      turnId: turn.turnId,
      turnStatus: 'pending',
      browserStatus: 'missing',
      nextAction: 'recover',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTurn(task.taskId, turn.turnId).status).toBe('pending');
    store.close();
    expect(fixture.browser.startCount).toBe(1);

    const recovered = await fixture.service.recover(task.taskId);
    expect(recovered).toMatchObject({ taskStatus: 'active', browserStatus: 'available', nextAction: 'wait' });
    expect(fixture.browser.startCount).toBe(2);
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
  });

  it('returns nextAction close for a closing task without touching the browser', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const store = new StateStore(fixture.paths.database);
    store.markTaskClosing(task.taskId);
    store.close();

    const status = await fixture.service.recover(task.taskId);
    expect(status).toMatchObject({ taskStatus: 'closing', nextAction: 'close' });
    expect(fixture.browser.closed).toEqual([]);
  });

  it('rebuilds a missing session and keeps nextAction wait for a pending turn', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'wait-prompt.md');
    await writeFile(promptPath, 'pending');
    await fixture.service.send(task.taskId, promptPath, []);
    fixture.browser.sessionAvailabilityResult = 'missing';

    const status = await fixture.service.recover(task.taskId);
    expect(status).toMatchObject({ turnStatus: 'pending', browserStatus: 'available', nextAction: 'wait' });
    expect(fixture.browser.startCount).toBe(2);
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
  });

  it('rebuilds a missing bound browser session and restores the canonical conversation', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'bound-prompt.md');
    await writeFile(promptPath, 'bound');
    const turn = await fixture.service.send(task.taskId, promptPath, []);
    await fixture.service.wait(task.taskId, turn.turnId, 20_000, 20_000);
    fixture.browser.sessionAvailabilityResult = 'missing';

    const status = await fixture.service.recover(task.taskId);
    expect(status).toMatchObject({ taskStatus: 'active', browserStatus: 'available', nextAction: 'none' });
    expect(fixture.browser.startCount).toBe(2);
    expect(fixture.browser.recoveredConversations).toEqual([task.taskId]);
  });

  it('resumes a starting task with its recorded session identity', async () => {
    const fixture = await serviceFixture();
    const taskId = 'task-starting';
    const store = new StateStore(fixture.paths.database);
    store.createTask(taskId, `chatgpt-pro-collab-${taskId}`, 'starting');
    store.createOperation({
      id: 'start-op',
      kind: 'start',
      step: 'session',
      taskId,
      turnId: null,
      sessionName: `chatgpt-pro-collab-${taskId}`,
    });
    store.close();
    await writeFile(fixture.paths.seedState, validSeedText());

    const status = await fixture.service.recover(taskId);
    expect(status).toMatchObject({ taskStatus: 'active', operationPhase: null, nextAction: 'none' });
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireOperation('start-op')).toMatchObject({ phase: 'committed' });
    reopened.close();
  });

  it('binds a submitted adjudication to the unique user turn with human evidence', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = 'adjudicated-task';
    const turnId = 'adjudicated-turn';
    const promptPath = join(fixture.root, 'resolve-prompt.md');
    await writeFile(promptPath, 'resolved prompt');
    const store = new StateStore(fixture.paths.database);
    store.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
    store.beginTurn(taskId, turnId, promptPath, []);
    store.markSubmissionAttempting(taskId, turnId);
    store.createOperation({
      id: 'send-op',
      kind: 'send',
      step: 'submit',
      taskId,
      turnId,
      sessionName: `chatgpt-pro-collab-${taskId}`,
    });
    store.markOperationEffectUnknown('send-op');
    store.markOperationNeedsDecision('send-op');
    store.close();
    await savePromptCopy(fixture.paths, taskId, turnId, Buffer.from('resolved prompt'));

    const status = await fixture.service.resolveSubmission(
      taskId,
      turnId,
      'submitted',
      'https://chatgpt.com/c/conversation-adjudicated-task',
    );
    expect(status).toMatchObject({ turnStatus: 'pending', nextAction: 'wait' });
    const reopened = new StateStore(fixture.paths.database);
    const resolved = reopened.requireTurn(taskId, turnId);
    expect(resolved).toMatchObject({ status: 'pending', userTurnIdentity: `user-turn-${taskId}` });
    expect(reopened.requireOperation('send-op')).toMatchObject({
      phase: 'committed',
      resolutionSource: 'human',
      evidence: { decision: 'submitted', promptVerbatimMatch: true, attachmentNamesMatch: true },
    });
    reopened.close();
    expect(fixture.browser.resolvedSubmissions).toEqual([taskId]);
  });

  it('fails a not-submitted adjudication after verifying the safe composer', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const taskId = 'not-sent-task';
    const turnId = 'not-sent-turn';
    const promptPath = join(fixture.root, 'not-sent-prompt.md');
    await writeFile(promptPath, 'not sent');
    const store = new StateStore(fixture.paths.database);
    store.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
    store.beginTurn(taskId, turnId, promptPath, []);
    store.markSubmissionAttempting(taskId, turnId);
    store.createOperation({
      id: 'send-op',
      kind: 'send',
      step: 'submit',
      taskId,
      turnId,
      sessionName: `chatgpt-pro-collab-${taskId}`,
    });
    store.markOperationEffectUnknown('send-op');
    store.markOperationNeedsDecision('send-op');
    store.close();
    await savePromptCopy(fixture.paths, taskId, turnId, Buffer.from('not sent'));

    const status = await fixture.service.resolveSubmission(taskId, turnId, 'not-submitted');
    expect(status).toMatchObject({ turnStatus: null, nextAction: 'none' });
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(taskId, turnId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('was not submitted'),
    });
    expect(reopened.requireOperation('send-op')).toMatchObject({ phase: 'committed', resolutionSource: 'human' });
    reopened.close();
    expect(fixture.browser.safeComposersVerified).toEqual([taskId]);
  });

  it('rejects a non-canonical adjudication URL before any browser action', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'url-prompt.md');
    await writeFile(promptPath, 'url');
    const turn = await fixture.service.send(task.taskId, promptPath, []);

    await expect(
      fixture.service.resolveSubmission(task.taskId, turn.turnId, 'submitted', 'https://evil.example.com/c/x'),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(
      fixture.service.resolveSubmission(
        task.taskId,
        turn.turnId,
        'submitted',
        'https://chatgpt.com/c/conversation-a?query=1',
      ),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(fixture.browser.resolvedSubmissions).toEqual([]);
  });

  it('rejects an adjudication on a non-unknown-submission turn', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.start();
    const promptPath = join(fixture.root, 'wrong-state-prompt.md');
    await writeFile(promptPath, 'wrong state');
    const turn = await fixture.service.send(task.taskId, promptPath, []);

    await expect(
      fixture.service.resolveSubmission(task.taskId, turn.turnId, 'submitted', 'https://chatgpt.com/c/x'),
    ).rejects.toMatchObject({ code: 'TURN_NOT_RESOLVABLE' });
  });

  it('prints status, recover, and both resolve-submission forms in stable help', async () => {
    const fixture = await serviceFixture();
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIo = {
      writeOutput(value) {
        output.push(value);
      },
      writeError(value) {
        errors.push(value);
      },
    };

    await expect(runCli(['--', 'help'], fixture.service, io)).resolves.toBe(0);
    expect(output.join('')).toContain('node "<skill-directory>/scripts/collab.ts" status <taskId>');
    expect(output.join('')).toContain('node "<skill-directory>/scripts/collab.ts" recover <taskId>');
    expect(output.join('')).toContain('resolve-submission <taskId> <turnId> submitted <conversationUrl>');
    expect(output.join('')).toContain('resolve-submission <taskId> <turnId> not-submitted');
    await expect(runCli(['resolve-submission', 'task-a', 'turn-a', 'maybe'], fixture.service, io)).resolves.toBe(1);
    expect(JSON.parse(errors.at(-1) ?? '{}')).toMatchObject({
      ok: false,
      error: { code: 'USAGE', message: expect.stringContaining('submitted or not-submitted') },
    });
  });
});

describe('BEH-013 resolve-turn failed response resolution', () => {
  const seedPendingBoundTurn = async (
    fixture: Awaited<ReturnType<typeof serviceFixture>>,
    taskId: string,
    turnId: string,
    conversationUrl: string = `https://chatgpt.com/c/conversation-${taskId}`,
  ): Promise<void> => {
    const promptPath = join(fixture.root, `${turnId}.md`);
    await Promise.all([writeFile(promptPath, 'pending'), writeFile(fixture.paths.seedState, validSeedText())]);
    const store = new StateStore(fixture.paths.database);
    store.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
    store.beginTurn(taskId, turnId, promptPath, []);
    store.markSubmissionAttempting(taskId, turnId);
    store.markTurnPending(taskId, turnId, `conversation-${taskId}`, conversationUrl, `user-turn-${taskId}`);
    store.close();
  };

  it('fails a pending turn after page proof and returns nextAction send without a user message', async () => {
    const fixture = await serviceFixture();
    const taskId = randomUUID();
    const turnId = 'pending-turn';
    await seedPendingBoundTurn(fixture, taskId, turnId);

    const status = await fixture.service.resolveTurn(taskId, turnId, 'failed');

    expect(status).toMatchObject({ turnStatus: null, browserStatus: 'available', nextAction: 'send' });
    const reopened = new StateStore(fixture.paths.database);
    const failed = reopened.requireTurn(taskId, turnId);
    expect(failed.status).toBe('failed');
    expect(JSON.parse(failed.error ?? '{}')).toMatchObject({
      adjudication: 'failed',
      pageUrl: `https://chatgpt.com/c/conversation-${taskId}`,
      userTurnIdentity: `user-turn-${taskId}`,
      stop: 'absent',
    });
    expect(reopened.requireTask(taskId).status).toBe('active');
    reopened.close();
    expect(fixture.browser.resolvedFailedTurns).toEqual([taskId]);
    expect(fixture.browser.resolvedFailedTurnUrls).toEqual([`https://chatgpt.com/c/conversation-${taskId}`]);
    expect(fixture.browser.expectedConversationIds).toEqual([]);
  });

  it('passes the exact recorded canonical conversation URL into the browser resolver', async () => {
    const fixture = await serviceFixture();
    const taskId = randomUUID();
    const turnId = 'url-turn';
    const projectScopedUrl = `https://chatgpt.com/g/g-p-123-chatgpt-pro-collab/c/conversation-${taskId}`;
    await seedPendingBoundTurn(fixture, taskId, turnId, projectScopedUrl);

    await fixture.service.resolveTurn(taskId, turnId, 'failed');

    expect(fixture.browser.resolvedFailedTurnUrls).toEqual([projectScopedUrl]);
    const reopened = new StateStore(fixture.paths.database);
    expect(JSON.parse(reopened.requireTurn(taskId, turnId).error ?? '{}')).toMatchObject({
      pageUrl: projectScopedUrl,
      adjudication: 'failed',
    });
    reopened.close();
  });

  it('records the controlled Stop outcome when the exact Stop answering was visible', async () => {
    const fixture = await serviceFixture();
    const taskId = randomUUID();
    const turnId = 'stopped-turn';
    await seedPendingBoundTurn(fixture, taskId, turnId);
    fixture.browser.nextResolveFailedTurnStop = 'stopped';

    const status = await fixture.service.resolveTurn(taskId, turnId, 'failed');

    expect(status).toMatchObject({ turnStatus: null, nextAction: 'send' });
    const reopened = new StateStore(fixture.paths.database);
    expect(JSON.parse(reopened.requireTurn(taskId, turnId).error ?? '{}')).toMatchObject({ stop: 'stopped' });
    reopened.close();
  });

  it('rebuilds the same named browser and canonical conversation when the session is missing', async () => {
    const fixture = await serviceFixture();
    const taskId = randomUUID();
    const turnId = 'rebuild-turn';
    await seedPendingBoundTurn(fixture, taskId, turnId);
    fixture.browser.sessionAvailabilityResult = 'missing';

    const status = await fixture.service.resolveTurn(taskId, turnId, 'failed');

    expect(status).toMatchObject({ turnStatus: null, browserStatus: 'available', nextAction: 'send' });
    expect(fixture.browser.startCount).toBe(1);
    expect(fixture.browser.recoveredConversations).toEqual([taskId]);
    expect(fixture.browser.resolvedFailedTurns).toEqual([taskId]);
  });

  it('preserves the pending turn when page verification fails', async () => {
    const fixture = await serviceFixture();
    const taskId = randomUUID();
    const turnId = 'drift-turn';
    await seedPendingBoundTurn(fixture, taskId, turnId);
    fixture.browser.nextResolveFailedTurnFailureTaskId = taskId;

    await expect(fixture.service.resolveTurn(taskId, turnId, 'failed')).rejects.toMatchObject({
      code: 'PLAYWRIGHT_CONTRACT_DRIFT',
    });
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(taskId, turnId)).toMatchObject({ status: 'pending', error: null });
    expect(reopened.getFailedTurnResolution(taskId, turnId)).toBeNull();
    reopened.close();
    expect(fixture.browser.resolvedFailedTurns).toEqual([]);
    expect(fixture.browser.expectedConversationIds).toEqual([]);
  });

  it('rejects capturing, completed, sending, unknown-submission, and other-failed turns', async () => {
    const fixture = await serviceFixture();
    const capturing = new StateStore(fixture.paths.database);
    capturing.createTask('capturing-task', 'session-capturing');
    capturing.beginTurn('capturing-task', 'turn-capturing', '/prompt.md', []);
    capturing.markSubmissionAttempting('capturing-task', 'turn-capturing');
    capturing.markTurnPending(
      'capturing-task',
      'turn-capturing',
      'conversation-capturing',
      'https://chatgpt.com/c/conversation-capturing',
      'user-turn-capturing',
    );
    capturing.freezeCapture('capturing-task', 'turn-capturing', join(fixture.root, 'capturing.md'), []);
    capturing.createTask('completed-task', 'session-completed');
    capturing.beginTurn('completed-task', 'turn-completed', '/prompt.md', []);
    capturing.markSubmissionAttempting('completed-task', 'turn-completed');
    capturing.markTurnPending(
      'completed-task',
      'turn-completed',
      'conversation-completed',
      'https://chatgpt.com/c/conversation-completed',
      'user-turn-completed',
    );
    capturing.freezeCapture('completed-task', 'turn-completed', join(fixture.root, 'completed.md'), []);
    await writeFile(join(fixture.root, 'completed.md'), 'done');
    capturing.completeTurn('completed-task', 'turn-completed', join(fixture.root, 'completed.md'));
    capturing.createTask('sending-task', 'session-sending');
    capturing.beginTurn('sending-task', 'turn-sending', '/prompt.md', []);
    capturing.createTask('unknown-task', 'session-unknown');
    capturing.beginTurn('unknown-task', 'turn-unknown', '/prompt.md', []);
    capturing.markSubmissionAttempting('unknown-task', 'turn-unknown');
    capturing.createTask('other-failed-task', 'session-other-failed');
    capturing.beginTurn('other-failed-task', 'turn-other-failed', '/prompt.md', []);
    capturing.failSendingTurn('other-failed-task', 'turn-other-failed', 'pre-submission failure');
    capturing.close();

    for (const [taskId, turnId] of [
      ['capturing-task', 'turn-capturing'],
      ['completed-task', 'turn-completed'],
      ['sending-task', 'turn-sending'],
      ['unknown-task', 'turn-unknown'],
      ['other-failed-task', 'turn-other-failed'],
    ] as const) {
      await expect(fixture.service.resolveTurn(taskId, turnId, 'failed')).rejects.toMatchObject({
        code: 'TURN_NOT_RESOLVABLE',
      });
    }
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn('capturing-task', 'turn-capturing').status).toBe('capturing');
    expect(reopened.requireTurn('other-failed-task', 'turn-other-failed').error).toBe('pre-submission failure');
    reopened.close();
    expect(fixture.browser.resolvedFailedTurns).toEqual([]);
  });

  it('rejects a non-active task and unknown identifiers', async () => {
    const fixture = await serviceFixture();
    const taskId = randomUUID();
    const turnId = 'closed-turn';
    await seedPendingBoundTurn(fixture, taskId, turnId);
    const closedStore = new StateStore(fixture.paths.database);
    closedStore.closeTask(taskId);
    closedStore.close();

    await expect(fixture.service.resolveTurn(taskId, turnId, 'failed')).rejects.toMatchObject({
      code: 'TASK_NOT_ACTIVE',
    });
    await expect(fixture.service.resolveTurn(randomUUID(), turnId, 'failed')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(fixture.service.resolveTurn(taskId, 'missing-turn', 'failed')).rejects.toMatchObject({
      code: 'TURN_NOT_FOUND',
    });
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(taskId, turnId).status).toBe('pending');
    reopened.close();
    expect(fixture.browser.resolvedFailedTurns).toEqual([]);
  });

  it('is idempotent after a recorded resolution without additional browser actions', async () => {
    const fixture = await serviceFixture();
    const taskId = randomUUID();
    const turnId = 'repeat-turn';
    await seedPendingBoundTurn(fixture, taskId, turnId);
    const first = await fixture.service.resolveTurn(taskId, turnId, 'failed');
    expect(first).toMatchObject({ turnStatus: null, nextAction: 'send' });
    expect(fixture.browser.startCount).toBe(0);

    const repeated = await fixture.service.resolveTurn(taskId, turnId, 'failed');
    expect(repeated).toMatchObject({ turnStatus: null, nextAction: 'send' });
    expect(fixture.browser.resolvedFailedTurns).toEqual([taskId]);
    expect(fixture.browser.startCount).toBe(0);
    expect(fixture.browser.recoveredConversations).toEqual([]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(taskId, turnId).status).toBe('failed');
    reopened.close();
  });

  it('serializes concurrent adjudications through the task lease with one resolution', async () => {
    const fixture = await serviceFixture();
    const taskId = randomUUID();
    const turnId = 'concurrent-turn';
    await seedPendingBoundTurn(fixture, taskId, turnId);
    let release: (() => void) | undefined;
    fixture.browser.resolveFailedTurnGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = fixture.service.resolveTurn(taskId, turnId, 'failed');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    await expect(fixture.service.resolveTurn(taskId, turnId, 'failed')).rejects.toMatchObject({
      code: 'TASK_OPERATION_IN_PROGRESS',
    });
    release?.();
    await expect(first).resolves.toMatchObject({ turnStatus: null, nextAction: 'send' });
    expect(fixture.browser.resolvedFailedTurns).toEqual([taskId]);
    const reopened = new StateStore(fixture.paths.database);
    expect(reopened.requireTurn(taskId, turnId).status).toBe('failed');
    reopened.close();
  });

  it('resolves a pending turn through the CLI and parses the failed verdict', async () => {
    const fixture = await serviceFixture();
    const taskId = randomUUID();
    const turnId = 'cli-turn';
    await seedPendingBoundTurn(fixture, taskId, turnId);
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIo = {
      writeOutput(value) {
        output.push(value);
      },
      writeError(value) {
        errors.push(value);
      },
    };

    await expect(runCli(['--', 'help'], fixture.service, io)).resolves.toBe(0);
    expect(output.join('')).toContain(
      'node "<skill-directory>/scripts/collab.ts" resolve-turn <taskId> <turnId> failed',
    );
    output.length = 0;
    await expect(runCli(['resolve-turn', taskId, turnId, 'failed'], fixture.service, io)).resolves.toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({
      ok: true,
      command: 'resolve-turn',
      turnStatus: null,
      nextAction: 'send',
    });
    await expect(runCli(['resolve-turn', taskId, turnId, 'maybe'], fixture.service, io)).resolves.toBe(1);
    expect(JSON.parse(errors.at(-1) ?? '{}')).toMatchObject({
      ok: false,
      error: { code: 'USAGE', message: expect.stringContaining('verdict must be failed') },
    });
    await expect(runCli(['resolve-turn', taskId, turnId], fixture.service, io)).resolves.toBe(1);
    expect(JSON.parse(errors.at(-1) ?? '{}')).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });
});

class FailTaskAfterArchiveLeaseStore extends StateStore {
  /**
   * Simulates a lifecycle transition committed at the lease-acquisition boundary.
   *
   * @param taskId Task whose browser lease is acquired.
   * @param operation Browser operation name.
   * @param token Unique lease token.
   * @param ownerPid Lease owner process identifier.
   * @returns Nothing after acquisition and the injected archive transition.
   * @throws {Error} If acquisition or the injected transition fails.
   */
  override acquireTaskOperation(
    taskId: string,
    operation: string,
    token: string,
    ownerPid: number = process.pid,
  ): void {
    super.acquireTaskOperation(taskId, operation, token, ownerPid);
    if (operation === 'archive') {
      this.failTask(taskId);
    }
  }
}

class FakeBrowser implements CollabBrowser {
  readonly paths: ReturnType<typeof collabPaths>;
  readonly conversations = new Map<string, string>();
  readonly closed: string[] = [];
  readonly archived: string[] = [];
  readonly recoveredConversations: string[] = [];
  readonly resolvedSubmissions: string[] = [];
  readonly safeComposersVerified: string[] = [];
  readonly setupSessions: string[] = [];
  readonly setupClosedSessions: string[] = [];
  seedAuthenticated = true;
  seedVerifications = 0;
  nextSetupCloseResult: { readonly sessionClosed: boolean } | null = null;
  readonly cleanedComposers: string[] = [];
  readonly archiveObservations: string[] = [];
  readonly autoVerifications: string[] = [];
  nextArchiveState: 'archived' | 'not-archived' = 'archived';
  nextArchiveStateUnknown: string | null = null;
  nextAutoVerifyUnresolved: string | null = null;
  autoVerifyConversationId: string | null = null;
  readonly expectedConversationIds: Array<string | null> = [];
  readonly expectedAssistantTurnIds: Array<string | null> = [];
  readonly responseArtifacts: Array<{ readonly sourceUrl: string; readonly label: string }> = [];
  readonly downloadedArtifacts: string[] = [];
  nextDownloadFailureSourceUrl: string | null = null;
  nextStartFailureCode: string | null = null;
  nextRecoverConversationIdentityFailureTaskId: string | null = null;
  sessionAvailabilityResult: 'available' | 'missing' | 'unknown' = 'available';
  nextVerifySafeComposerFailureTaskId: string | null = null;
  readonly resolvedFailedTurns: string[] = [];
  readonly resolvedFailedTurnUrls: string[] = [];
  nextResolveFailedTurnFailureTaskId: string | null = null;
  nextResolveFailedTurnStop: 'absent' | 'stopped' = 'absent';
  resolveFailedTurnGate: Promise<void> | null = null;
  observedOperations = 0;
  nextSendStatus: 'submitted' | 'not-submitted' | 'unknown-submission' | 'unsafe-not-submitted' = 'submitted';
  cleanSendComposerFailuresRemaining = 0;
  pendingWaitPolls = 0;
  waitPollDelayMs = 0;
  captureDelayMs = 0;
  captureNeverSettles = false;
  captureAbortCount = 0;
  observeResponseCalls = 0;
  readonly observedUserTurnIds: string[] = [];
  readonly reloadedConversations: string[] = [];
  readonly reloadedUserTurnIds: string[] = [];
  reloadConversationCalls = 0;
  nextReloadConversationFailureTaskId: string | null = null;
  onPendingPoll: (() => void) | null = null;
  downloadDelayMs = 0;
  downloadFailureDelayMs = 0;
  downloadNeverSettlesSourceUrl: string | null = null;
  downloadAbortCount = 0;
  readonly downloadCaptureBudgets: number[] = [];
  activeCaptures = 0;
  maxConcurrentCaptures = 0;
  nextCaptureFailureTaskId: string | null = null;
  startCount = 0;
  nextChildPid = 20_000;
  nextUserTurnOrdinal = 0;

  /**
   * Creates a deterministic browser boundary rooted in the test data directory.
   *
   * @param paths Test Collab paths.
   * @throws {Error} This constructor does not perform I/O.
   */
  constructor(paths: ReturnType<typeof collabPaths>) {
    this.paths = paths;
  }

  /**
   * Writes the fake shared authentication seed.
   *
   * @returns The fake seed path.
   * @throws {Error} If the test file cannot be written.
   */
  async setup(): Promise<string> {
    await writeFile(this.paths.seedState, validSeedText());
    return this.paths.seedState;
  }

  /**
   * Records one fake setup login observation.
   *
   * @param sessionName Recorded setup session name.
   * @returns Nothing after the fake login wait.
   * @throws {Error} This fake setup open does not throw.
   */
  async setupOpen(sessionName: string): Promise<void> {
    this.setupSessions.push(sessionName);
  }

  /**
   * Writes the fake seed and reports its validation.
   *
   * @param sessionName Recorded setup session name.
   * @param seedStatePath Fake authentication seed path.
   * @returns The validated seed flag.
   * @throws {Error} If the test file cannot be written.
   */
  async setupSaveSeed(sessionName: string, seedStatePath: string): Promise<{ readonly seedValidated: boolean }> {
    await writeFile(seedStatePath, validSeedText());
    this.seedAuthenticated = true;
    return { seedValidated: true };
  }

  /**
   * Reports the fake setup session close, with an optional injected unconfirmed result.
   *
   * @param sessionName Recorded setup session name.
   * @returns The configured or default closed-session flag.
   * @throws {Error} This fake setup close does not throw.
   */
  async setupClose(sessionName: string): Promise<{ readonly sessionClosed: boolean }> {
    this.setupClosedSessions.push(sessionName);
    return this.nextSetupCloseResult ?? { sessionClosed: true };
  }

  /**
   * Reports whether the fake seed would produce an authenticated ChatGPT page.
   *
   * @param _sessionName Unused named session.
   * @param _seedStatePath Unused authentication seed path.
   * @returns The configured seed-authentication verdict.
   * @throws {Error} This fake verification does not throw.
   */
  async verifyAuthenticatedSeed(
    _sessionName: string,
    _seedStatePath: string,
  ): Promise<{ readonly authenticated: boolean }> {
    this.seedVerifications += 1;
    return { authenticated: this.seedAuthenticated };
  }

  /**
   * Returns stable isolation evidence for one fake task.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param _seedStatePath Unused shared seed.
   * @param _rebuild Unused rebuild flag.
   * @param observer Task-lease child-process observer.
   * @returns Fake process and context identity.
   * @throws {Error} This fake start does not throw.
   */
  startTask(
    taskId: string,
    _sessionName: string,
    _seedStatePath: string,
    _rebuild?: boolean,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.startCount += 1;
    this.sessionAvailabilityResult = 'available';
    if (this.nextStartFailureCode !== null) {
      const code = this.nextStartFailureCode;
      this.nextStartFailureCode = null;
      return Promise.reject(new BrowserError(code, 'start task', `injected ${code} failure`));
    }
    return Promise.resolve({
      pid: 10_000 + this.startCount,
      url: 'https://chatgpt.com/g/g-p-123/project',
      contextMarker: `context-${taskId}`,
      projectId: 'g-p-123',
      modelConfirmed: true,
      powerConfirmed: true,
      powerNow: 4,
      powerMin: 0,
      powerMax: 4,
      persistent: false as const,
    });
  }

  /**
   * Returns a task-stable conversation or an injected ambiguous result.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param expectedConversationId Database-bound conversation, or null for a first turn.
   * @param _prompt Exact prompt under test.
   * @param _attachmentPaths Ordered attachment paths under test.
   * @param observer Task-lease child-process observer.
   * @param beforeSubmissionRelease Submission-boundary callback under test.
   * @returns Confirmed or ambiguous fake submission.
   * @throws {Error} This fake send does not throw.
   */
  send(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string | null,
    _prompt: string,
    _attachmentPaths: readonly string[],
    observer?: BrowserOperationObserver,
    beforeSubmissionRelease?: () => void,
  ) {
    this.observe(observer);
    this.expectedConversationIds.push(expectedConversationId);
    if (this.nextSendStatus === 'not-submitted') {
      this.nextSendStatus = 'submitted';
      return Promise.resolve({ status: 'not-submitted' as const, error: 'preflight failed' });
    }
    if (this.nextSendStatus === 'unknown-submission') {
      this.nextSendStatus = 'submitted';
      beforeSubmissionRelease?.();
      return Promise.resolve({ status: 'unknown-submission' as const, error: 'transport ended after click' });
    }
    if (this.nextSendStatus === 'unsafe-not-submitted') {
      this.nextSendStatus = 'submitted';
      return Promise.resolve({ status: 'unsafe-not-submitted' as const, error: 'attachment cleanup failed' });
    }
    const conversationId = this.conversations.get(taskId) ?? `conversation-${taskId}`;
    this.conversations.set(taskId, conversationId);
    beforeSubmissionRelease?.();
    this.nextUserTurnOrdinal += 1;
    return Promise.resolve({
      status: 'submitted' as const,
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      userTurnIdentity: `user-turn-${taskId}-${this.nextUserTurnOrdinal}`,
    });
  }

  /**
   * Returns the fake session availability probe result.
   *
   * @param _sessionName Unused named session.
   * @returns The configured availability classification.
   * @throws {Error} This fake probe does not throw.
   */
  async sessionAvailability(_sessionName: string) {
    return this.sessionAvailabilityResult;
  }

  /**
   * Records one fake conversation recovery navigation, with an optional injected identity failure.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param conversationUrl Recorded canonical URL.
   * @param conversationId Database-bound identity.
   * @param observer Task-lease child-process observer.
   * @returns The recovered conversation identity.
   * @throws {BrowserError} While the injected one-shot identity mismatch is armed.
   */
  async recoverConversation(
    taskId: string,
    _sessionName: string,
    conversationUrl: string,
    conversationId: string,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    if (this.nextRecoverConversationIdentityFailureTaskId === taskId) {
      this.nextRecoverConversationIdentityFailureTaskId = null;
      throw new BrowserError(
        'BROWSER_COMMAND_FAILED',
        'recover conversation',
        `injected conversation identity mismatch for ${taskId}`,
      );
    }
    this.recoveredConversations.push(taskId);
    return Promise.resolve({ conversationId, conversationUrl });
  }

  /**
   * Records one fake periodic reload of the bound pending conversation.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param expectedConversationId Database-bound identity.
   * @param expectedUserTurnId Persisted user turn anchor passed to the reload.
   * @param observer Task-lease child-process observer.
   * @returns The unchanged fake conversation identity.
   * @throws {BrowserError} When the injected identity-drift failure is armed.
   */
  async reloadConversation(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string,
    expectedUserTurnId: string,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.reloadConversationCalls += 1;
    this.reloadedConversations.push(expectedConversationId);
    this.reloadedUserTurnIds.push(expectedUserTurnId);
    if (this.nextReloadConversationFailureTaskId === taskId) {
      this.nextReloadConversationFailureTaskId = null;
      throw new BrowserError(
        'PAGE_CONTRACT_DRIFT',
        'reload pending conversation',
        `injected reload identity drift for ${taskId}`,
      );
    }
    return Promise.resolve({
      conversationId: expectedConversationId,
      conversationUrl: `https://chatgpt.com/c/${expectedConversationId}`,
    });
  }

  /**
   * Records one fake automatic submission verification.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param expectedConversationId Database-bound identity.
   * @param _expectedProjectIdentity Unused recorded project identity.
   * @param _previousUserTurnIdentity Unused anchor.
   * @param _prompt Unused saved prompt.
   * @param _attachmentNames Unused ordered attachment names.
   * @param observer Task-lease child-process observer.
   * @returns The configured auto-verification result.
   * @throws {Error} This fake verification does not throw.
   */
  async autoVerifySubmission(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string | null,
    _expectedProjectIdentity: string | null,
    _previousUserTurnIdentity: string | null,
    _prompt: string,
    _attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.autoVerifications.push(taskId);
    if (this.nextAutoVerifyUnresolved === taskId) {
      this.nextAutoVerifyUnresolved = null;
      return { status: 'unresolved' as const, reason: 'injected unresolved auto-verification' };
    }
    if (expectedConversationId === null) {
      if (this.autoVerifyConversationId === null) {
        return {
          status: 'unresolved' as const,
          reason: 'the current page is not a canonical conversation',
        };
      }
      const conversationId = this.autoVerifyConversationId;
      return {
        status: 'submitted' as const,
        conversationId,
        conversationUrl: `https://chatgpt.com/c/${conversationId}`,
        userTurnIdentity: `user-turn-${taskId}`,
      };
    }
    const conversationId = expectedConversationId;
    return {
      status: 'submitted' as const,
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      userTurnIdentity: `user-turn-${taskId}`,
    };
  }

  /**
   * Records one fake archive-state observation.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param _conversationUrl Unused canonical URL.
   * @param _conversationId Unused identity.
   * @param observer Task-lease child-process observer.
   * @returns The configured archive state.
   * @throws {Error} This fake observation does not throw.
   */
  async observeArchiveState(
    taskId: string,
    _sessionName: string,
    _conversationUrl: string,
    _conversationId: string,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.archiveObservations.push(taskId);
    if (this.nextArchiveStateUnknown === taskId) {
      this.nextArchiveStateUnknown = null;
      return { status: 'unknown' as const, error: 'injected unverifiable archive state' };
    }
    if (this.nextArchiveState === 'archived') {
      return { status: 'archived' as const };
    }
    return { status: 'not-archived' as const };
  }

  /**
   * Records one fake composer cleanup, with an optional injected failure.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param _expectedConversationId Unused bound identity.
   * @param _attachmentFileNames Unused attachment basenames.
   * @param observer Task-lease child-process observer.
   * @returns Nothing after the fake cleanup.
   * @throws {Error} While an injected cleanup failure is armed.
   */
  async cleanSendComposer(
    taskId: string,
    _sessionName: string,
    _expectedConversationId: string | null,
    _attachmentFileNames: readonly string[],
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    if (this.cleanSendComposerFailuresRemaining > 0) {
      this.cleanSendComposerFailuresRemaining -= 1;
      throw new Error('injected composer cleanup failure');
    }
    this.cleanedComposers.push(taskId);
  }

  /**
   * Returns a fake unique matching user turn for a submitted adjudication.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param _canonicalUrl Supplied canonical URL.
   * @param expectedConversationId Database-bound identity.
   * @param _expectedProjectIdentity Unused recorded project identity.
   * @param _previousUserTurnIdentity Unused anchor.
   * @param _prompt Unused saved prompt.
   * @param _attachmentNames Unused ordered attachment names.
   * @param observer Task-lease child-process observer.
   * @returns The adjudicated conversation and user turn identity.
   * @throws {Error} This fake resolution does not throw.
   */
  async resolveSubmittedConversation(
    taskId: string,
    _sessionName: string,
    _canonicalUrl: string,
    expectedConversationId: string | null,
    _expectedProjectIdentity: string | null,
    _previousUserTurnIdentity: string | null,
    _prompt: string,
    _attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.resolvedSubmissions.push(taskId);
    const conversationId = expectedConversationId ?? `conversation-${taskId}`;
    return Promise.resolve({
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      userTurnIdentity: `user-turn-${taskId}`,
    });
  }

  /**
   * Records one fake safe-composer verification.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param _expectedConversationId Unused bound identity.
   * @param _expectedProjectIdentity Unused recorded project identity.
   * @param _previousUserTurnIdentity Unused anchor.
   * @param _prompt Unused saved prompt.
   * @param _attachmentNames Unused ordered attachment names.
   * @param observer Task-lease child-process observer.
   * @returns Nothing after the fake verification.
   * @throws {Error} If the injected not-submitted failure is armed.
   */
  async verifySafeComposer(
    taskId: string,
    _sessionName: string,
    _expectedConversationId: string | null,
    _expectedProjectIdentity: string | null,
    _previousUserTurnIdentity: string | null,
    _prompt: string,
    _attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    if (this.nextVerifySafeComposerFailureTaskId === taskId) {
      this.nextVerifySafeComposerFailureTaskId = null;
      throw new Error('injected safe composer verification failure');
    }
    this.safeComposersVerified.push(taskId);
  }

  /**
   * Records one fake failed-response adjudication with an optional injected drift.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param expectedConversationId Database-bound identity.
   * @param expectedUserTurnId Persisted target user turn identity.
   * @param conversationUrl Recorded exact canonical conversation URL.
   * @param observer Task-lease child-process observer.
   * @returns The verified conversation, user turn, and configured Stop outcome.
   * @throws {BrowserError} While the injected identity-drift failure is armed.
   */
  async resolveFailedTurn(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string,
    expectedUserTurnId: string,
    conversationUrl: string,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    if (this.resolveFailedTurnGate !== null) {
      await this.resolveFailedTurnGate;
    }
    if (this.nextResolveFailedTurnFailureTaskId === taskId) {
      this.nextResolveFailedTurnFailureTaskId = null;
      throw new BrowserError(
        'PLAYWRIGHT_CONTRACT_DRIFT',
        'verify failed response turn',
        `injected page drift for ${taskId}`,
      );
    }
    this.resolvedFailedTurns.push(taskId);
    this.resolvedFailedTurnUrls.push(conversationUrl);
    return {
      conversationId: expectedConversationId,
      conversationUrl,
      userTurnIdentity: expectedUserTurnId,
      stop: this.nextResolveFailedTurnStop,
    };
  }

  /**
   * Returns one task-specific fake response.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param expectedConversationId Database-bound identity.
   * @param expectedUserTurnId Persisted user turn anchor.
   * @param _observationWindowMs Unused finite observation budget.
   * @param observer Task-lease child-process observer.
   * @returns Fake copied response and unchanged conversation.
   * @throws {Error} This fake wait does not throw.
   */
  async observeResponse(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string,
    expectedUserTurnId: string,
    _observationWindowMs: number,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.observeResponseCalls += 1;
    this.observedUserTurnIds.push(expectedUserTurnId);
    if (this.pendingWaitPolls > 0) {
      this.pendingWaitPolls -= 1;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.waitPollDelayMs);
      });
      this.onPendingPoll?.();
      return { status: 'pending' as const };
    }
    return {
      status: 'completed' as const,
      conversationId: expectedConversationId,
      conversationUrl: `https://chatgpt.com/c/${expectedConversationId}`,
      assistantTurnId: `conversation-turn-${taskId}`,
    };
  }

  /**
   * Returns both fake Copy response representations for one completed task turn.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param expectedConversationId Database-bound identity.
   * @param expectedAssistantTurnId Assistant identity observed for a pending turn, or null on capturing retry.
   * @param _captureTimeoutMs Unused finite capture budget.
   * @param signal Host cancellation used by capture timeout tests.
   * @param observer Task-lease child-process observer.
   * @returns Fake plain text, HTML, and unchanged conversation.
   * @throws {Error} This fake capture does not throw.
   */
  async captureResponse(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string,
    expectedAssistantTurnId: string | null,
    _captureTimeoutMs: number,
    signal: AbortSignal,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.expectedAssistantTurnIds.push(expectedAssistantTurnId);
    this.activeCaptures += 1;
    this.maxConcurrentCaptures = Math.max(this.maxConcurrentCaptures, this.activeCaptures);
    try {
      if (this.captureNeverSettles) {
        await waitForCaptureSignal(signal, () => {
          this.captureAbortCount += 1;
        });
      }
      if (this.captureDelayMs > 0) {
        await abortableCaptureDelay(this.captureDelayMs, signal, () => {
          this.captureAbortCount += 1;
        });
      }
      if (this.nextCaptureFailureTaskId === taskId) {
        this.nextCaptureFailureTaskId = null;
        throw new BrowserError('INJECTED_BROWSER_FAILURE', 'capture response', `injected failure for ${taskId}`);
      }
      return {
        response: `response for ${taskId}`,
        responseHtml: `<p>response for ${taskId}</p>`,
        artifacts: [...this.responseArtifacts],
        conversationId: expectedConversationId,
        conversationUrl: `https://chatgpt.com/c/${expectedConversationId}`,
      };
    } finally {
      this.activeCaptures -= 1;
    }
  }

  /**
   * Saves deterministic fake artifact bytes at the task-owned temporary path.
   *
   * @param _taskId Unused task identifier.
   * @param _sessionName Unused named session.
   * @param _expectedConversationId Unused database-bound identity.
   * @param _expectedSourceUrls Unused complete recorded artifact set.
   * @param sourceUrl Exact logical artifact target.
   * @param temporaryPath Fresh browser save path.
   * @param captureTimeoutMs Remaining finite budget from the shared capture deadline.
   * @param signal Host cancellation used by download timeout tests.
   * @param observer Task-lease child-process observer.
   * @returns Fake download metadata after writing the bytes.
   * @throws {Error} If the fake artifact cannot be written.
   */
  async downloadArtifact(
    _taskId: string,
    _sessionName: string,
    _expectedConversationId: string,
    _expectedSourceUrls: readonly string[],
    sourceUrl: string,
    temporaryPath: string,
    captureTimeoutMs: number,
    signal: AbortSignal,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.downloadedArtifacts.push(sourceUrl);
    this.downloadCaptureBudgets.push(captureTimeoutMs);
    if (this.downloadNeverSettlesSourceUrl === sourceUrl) {
      signal.addEventListener(
        'abort',
        () => {
          this.downloadAbortCount += 1;
        },
        { once: true },
      );
      await new Promise<void>(() => {});
    }
    if (this.downloadFailureDelayMs > 0) {
      await delayedFailureWait(this.downloadFailureDelayMs, signal, () => {
        this.downloadAbortCount += 1;
      });
    }
    if (this.nextDownloadFailureSourceUrl === sourceUrl) {
      this.nextDownloadFailureSourceUrl = null;
      throw new BrowserError(
        'INJECTED_DOWNLOAD_FAILURE',
        'download artifact',
        `injected download failure for ${sourceUrl}`,
      );
    }
    if (this.downloadDelayMs > 0) {
      await abortableCaptureDelay(this.downloadDelayMs, signal, () => {
        this.downloadAbortCount += 1;
      });
    }
    await writeFile(temporaryPath, `artifact for ${sourceUrl}`);
    return {
      sourceUrl,
      suggestedFilename: sourceUrl.slice(sourceUrl.lastIndexOf('/') + 1),
      downloadUrl: `https://chatgpt.com/backend-api/estuary/content/${this.downloadedArtifacts.length}`,
    };
  }

  /**
   * Records one fake local browser close.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param observer Task-lease child-process observer.
   * @returns An open-session cleanup result.
   * @throws {Error} This fake close does not throw.
   */
  closeTask(taskId: string, _sessionName: string, observer?: BrowserOperationObserver) {
    this.observe(observer);
    this.closed.push(taskId);
    return Promise.resolve({ wasOpen: true });
  }

  /**
   * Records one fake Web archive without closing the task.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param conversationId Database-bound identity.
   * @param _conversationUrl Unused canonical conversation URL.
   * @param observer Task-lease child-process observer.
   * @returns The same conversation identity.
   * @throws {Error} This fake archive does not throw.
   */
  archive(
    taskId: string,
    _sessionName: string,
    conversationId: string,
    _conversationUrl: string,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.archived.push(taskId);
    return Promise.resolve({ conversationId });
  }

  /**
   * Simulates one complete spawned browser command under the service lease.
   *
   * @param observer Observer passed through the production service boundary.
   * @returns Nothing after the fake child is attached and detached.
   * @throws {Error} If the service omitted the required operation observer.
   */
  observe(observer: BrowserOperationObserver | undefined): void {
    if (observer === undefined) {
      throw new Error('task operation observer was not supplied');
    }
    const pid = this.nextChildPid;
    this.nextChildPid += 1;
    observer.childSpawned(pid);
    observer.commandSpawned(pid + 1000);
    observer.childExited(pid);
    this.observedOperations += 1;
  }
}

/**
 * Holds a fake capture until the host watchdog aborts it.
 *
 * @param signal Required host cancellation signal.
 * @param onAbort Test audit invoked exactly once on cancellation.
 * @returns A promise that only rejects when capture is aborted.
 * @throws {Error} If the service omits cancellation or the host aborts capture.
 */
function waitForCaptureSignal(signal: AbortSignal | undefined, onAbort: () => void): Promise<void> {
  if (signal === undefined) {
    throw new Error('capture watchdog signal was not supplied');
  }
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      onAbort();
      reject(new Error('fake capture aborted'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Delays a fake capture while allowing the host watchdog to cancel it safely.
 *
 * @param milliseconds Finite deterministic delay.
 * @param signal Optional host cancellation signal.
 * @param onAbort Test audit invoked exactly once on cancellation.
 * @returns Nothing after delay completion.
 * @throws {Error} When the host aborts before the delay completes.
 */
function abortableCaptureDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      onAbort();
      reject(new Error('fake capture delay aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Delays an injected provider failure while intentionally ignoring cancellation for settlement.
 *
 * @param milliseconds Finite deterministic delay.
 * @param signal Host cancellation signal observed but not honored by the provider fixture.
 * @param onAbort Test audit invoked exactly once on cancellation.
 * @returns Nothing after the delayed provider boundary settles.
 * @throws {Error} Timers and AbortSignal listeners do not ordinarily throw.
 */
function delayedFailureWait(milliseconds: number, signal: AbortSignal, onAbort: () => void): Promise<void> {
  return new Promise((resolve) => {
    const abort = (): void => {
      onAbort();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    if (signal.aborted) {
      clearTimeout(timer);
      abort();
      resolve();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Creates an isolated service with deterministic IDs and a fake browser.
 *
 * @returns Test root, paths, browser, and service.
 * @throws {Error} If the temporary directory or state setup fails.
 */
/**
 * Returns a minimal loadable ChatGPT storage state accepted by `seedStateValid`.
 *
 * @returns A Playwright storage state JSON with a chatgpt.com cookie and origin.
 * @throws {Error} This pure helper does not throw.
 */
function validSeedText(): string {
  return JSON.stringify({
    cookies: [{ name: 'session', domain: '.chatgpt.com', path: '/', value: 'test' }],
    origins: [{ origin: 'https://chatgpt.com', localStorage: [{ name: 'oai-did', value: 'test' }] }],
  });
}

async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'collab-service-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  const browser = new FakeBrowser(paths);
  let id = 0;
  const service = new CollabService(
    paths,
    browser,
    () => {
      return new StateStore(paths.database);
    },
    () => {
      id += 1;
      return `id-${id}`;
    },
  );
  return {
    root,
    paths,
    browser,
    service,
    start() {
      return service.start(randomUUID());
    },
  };
}

/**
 * Creates a service fixture whose monotonic wait clock and fake browser polls share one
 * test-controlled time base, so the 300000ms reload schedule runs deterministically.
 *
 * @returns Fixture with the controllable clock, fake browser, and service.
 * @throws {Error} If the temporary fixture cannot be created.
 */
async function reloadServiceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'collab-reload-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  let now = 0;
  const clock = {
    now(): number {
      return now;
    },
    advance(ms: number): void {
      now += ms;
    },
  };
  const browser = new FakeBrowser(paths);
  browser.onPendingPoll = () => {
    clock.advance(50_000);
  };
  let id = 0;
  const service = new CollabService(
    paths,
    browser,
    () => {
      return new StateStore(paths.database);
    },
    () => {
      id += 1;
      return `id-${id}`;
    },
    clock.now,
  );
  return {
    root,
    paths,
    browser,
    service,
    clock,
    start() {
      return service.start(randomUUID());
    },
  };
}
