import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BrowserError, type BrowserOperationObserver } from '../skills/chatgpt-pro-collab/scripts/browser.ts';
import { CollabService, runCli, type CliIo, type CollabBrowser } from '../skills/chatgpt-pro-collab/scripts/collab.ts';
import { artifactPath, collabPaths, ensureCollabDirectories } from '../skills/chatgpt-pro-collab/scripts/session.ts';
import { StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';

describe('BEH-001 through BEH-009 CLI orchestration', () => {
  it('supports setup, isolated tasks, multiple turns, idempotent wait, archive, and close', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const firstTask = await fixture.service.start();
    const secondTask = await fixture.service.start();
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
    expect(fixture.browser.observedOperations).toBe(11);
    await expect(fixture.service.wait(firstTask.taskId, firstTurn.turnId, 20_000, 20_000)).resolves.toEqual(repeated);
    await expect(fixture.service.archive(firstTask.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_ACTIVE' });
  });

  it('records submission ambiguity and blocks an automatic resend', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.service.start();
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

  it('fails the task when an unsubmitted attachment draft cannot be cleared safely', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.service.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'unsafe cleanup');
    fixture.browser.nextSendStatus = 'unsafe-not-submitted';

    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'SUBMISSION_FAILED',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(task.taskId).status).toBe('failed');
    store.close();
    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'TASK_NOT_ACTIVE',
    });
  });

  it('fails a known pre-submission error without creating submission ambiguity', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
    const owner = new StateStore(fixture.paths.database);
    owner.acquireTaskOperation(task.taskId, 'send', 'external-owner');

    await expect(fixture.service.close(task.taskId)).rejects.toMatchObject({
      code: 'TASK_OPERATION_IN_PROGRESS',
    });
    owner.releaseTaskOperation(task.taskId, 'external-owner');
    owner.close();
    await expect(fixture.service.close(task.taskId)).resolves.toMatchObject({ alreadyClosed: false });
  });

  it('lets close take the task between bounded wait polls', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const firstTask = await fixture.service.start();
    const secondTask = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    expect(await readFile(fixture.paths.seedState, 'utf8')).toBe('{}');
    expect(fixture.browser.conversations.get(task.taskId)).toBe(`conversation-${task.taskId}`);
    await expect(fixture.service.archive(task.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_ACTIVE' });
  });

  it('aborts a delayed artifact download at the shared deadline and retries it', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
    const task = await fixture.service.start();
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
  readonly expectedConversationIds: Array<string | null> = [];
  readonly responseArtifacts: Array<{ readonly sourceUrl: string; readonly label: string }> = [];
  readonly downloadedArtifacts: string[] = [];
  nextDownloadFailureSourceUrl: string | null = null;
  observedOperations = 0;
  nextSendStatus: 'submitted' | 'not-submitted' | 'unknown-submission' | 'unsafe-not-submitted' = 'submitted';
  pendingWaitPolls = 0;
  waitPollDelayMs = 0;
  captureDelayMs = 0;
  captureNeverSettles = false;
  captureAbortCount = 0;
  observeResponseCalls = 0;
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
    await writeFile(this.paths.seedState, '{}');
    return this.paths.seedState;
  }

  /**
   * Returns stable isolation evidence for one fake task.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param _seedStatePath Unused shared seed.
   * @returns Fake process and context identity.
   * @throws {Error} This fake start does not throw.
   */
  startTask(taskId: string, _sessionName: string, _seedStatePath: string) {
    this.startCount += 1;
    return Promise.resolve({
      pid: 10_000 + this.startCount,
      url: 'https://chatgpt.com/',
      contextMarker: `context-${taskId}`,
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
    return Promise.resolve({
      status: 'submitted' as const,
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    });
  }

  /**
   * Returns one task-specific fake response.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param expectedConversationId Database-bound identity.
   * @param _localTurnId Unused local turn identity.
   * @param _observationWindowMs Unused finite observation budget.
   * @param observer Task-lease child-process observer.
   * @returns Fake copied response and unchanged conversation.
   * @throws {Error} This fake wait does not throw.
   */
  async observeResponse(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string,
    _localTurnId: string,
    _observationWindowMs: number,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.observeResponseCalls += 1;
    if (this.pendingWaitPolls > 0) {
      this.pendingWaitPolls -= 1;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.waitPollDelayMs);
      });
      return { status: 'pending' as const };
    }
    return {
      status: 'completed' as const,
      conversationId: expectedConversationId,
      conversationUrl: `https://chatgpt.com/c/${expectedConversationId}`,
      assistantTurnId: 'conversation-turn-2',
      completionMode: 'normal' as const,
      contentFingerprint: 'fixture-fingerprint',
    };
  }

  /**
   * Returns both fake Copy response representations for one completed task turn.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param expectedConversationId Database-bound identity.
   * @param _localTurnId Unused local turn identity.
   * @param _expectedAssistantTurnId Unused observed assistant identity.
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
    _localTurnId: string,
    _expectedAssistantTurnId: string | null,
    _captureTimeoutMs: number,
    signal: AbortSignal,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
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
   * @param observer Task-lease child-process observer.
   * @returns The same conversation identity.
   * @throws {Error} This fake archive does not throw.
   */
  archive(taskId: string, _sessionName: string, conversationId: string, observer?: BrowserOperationObserver) {
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
  return { root, paths, browser, service };
}
