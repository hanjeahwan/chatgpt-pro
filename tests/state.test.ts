import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { StateError, StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';
import { seedActiveTask } from './support/state.ts';

describe('BEH-002, BEH-005, BEH-007, and BEH-008 state gates', () => {
  it('binds one conversation and permits only one unfinished turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-state-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    store.beginSendTurn('task-a', 'turn-a', '/prompt.md', ['/a', '/b'], 'operation-a');

    expect(() => {
      return store.beginSendTurn('task-a', 'turn-b', '/other.md', [], 'operation-b');
    }).toThrowError(StateError);

    store.advanceSendToSubmitEffectUnknown('operation-a');
    store.commitSubmittedTurn(
      'task-a',
      'turn-a',
      'conversation-a',
      'https://chatgpt.com/c/conversation-a',
      'user-turn-a',
      'operation-a',
    );
    expect(store.requireTurn('task-a', 'turn-a')).toMatchObject({ status: 'pending', error: null });
    const responsePath = join(root, 'response.md');
    store.freezeCapture('task-a', 'turn-a', responsePath, []);
    await writeFile(responsePath, 'response');
    store.completeTurn('task-a', 'turn-a', responsePath);
    store.beginSendTurn('task-a', 'turn-b', '/other.md', [], 'operation-b');
    store.advanceSendToSubmitEffectUnknown('operation-b');

    expect(() => {
      return store.commitSubmittedTurn(
        'task-a',
        'turn-b',
        'conversation-b',
        'https://chatgpt.com/c/conversation-b',
        'user-turn-b',
        'operation-b',
      );
    }).toThrowError(/different conversation/);
    expect(() => {
      return store.commitSubmittedTurn(
        'task-a',
        'turn-b',
        'conversation-a',
        'https://chatgpt.com/c/conversation-a',
        'user-turn-a',
        'operation-b',
      );
    }).toThrowError(/user turn identity/);
    store.close();
  });

  it('keeps the first submitted canonical conversation URL across later turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-canonical-binding-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    store.beginSendTurn('task-a', 'turn-a', '/prompt.md', [], 'operation-a');
    store.advanceSendToSubmitEffectUnknown('operation-a');
    store.commitSubmittedTurn(
      'task-a',
      'turn-a',
      'conversation-a',
      'https://chatgpt.com/c/conversation-a',
      'user-turn-a',
      'operation-a',
    );
    expect(store.requireTask('task-a')).toMatchObject({
      conversationId: 'conversation-a',
      conversationUrl: 'https://chatgpt.com/c/conversation-a',
    });
    const responsePath = join(root, 'response.md');
    store.freezeCapture('task-a', 'turn-a', responsePath, []);
    await writeFile(responsePath, 'done');
    store.completeTurn('task-a', 'turn-a', responsePath);

    store.beginSendTurn('task-a', 'turn-b', '/next.md', [], 'operation-b');
    store.advanceSendToSubmitEffectUnknown('operation-b');
    expect(() => {
      store.commitSubmittedTurn(
        'task-a',
        'turn-b',
        'conversation-a',
        'https://chatgpt.com/g/g-p-123/c/conversation-a',
        'user-turn-b',
        'operation-b',
      );
    }).toThrowError(/different conversation/);
    expect(store.requireTask('task-a').conversationUrl).toBe('https://chatgpt.com/c/conversation-a');

    store.commitSubmittedTurn(
      'task-a',
      'turn-b',
      'conversation-a',
      'https://chatgpt.com/c/conversation-a',
      'user-turn-b',
      'operation-b',
    );
    expect(store.requireTask('task-a').conversationUrl).toBe('https://chatgpt.com/c/conversation-a');
    store.close();
  });

  it('freezes ordered artifacts before publication and completes only readable files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-artifact-state-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    store.beginSendTurn('task-a', 'turn-a', '/prompt.md', [], 'operation-a');
    store.advanceSendToSubmitEffectUnknown('operation-a');
    store.commitSubmittedTurn(
      'task-a',
      'turn-a',
      'conversation-a',
      'https://chatgpt.com/c/conversation-a',
      'user-turn-a',
      'operation-a',
    );
    const responsePath = join(root, 'response.md');
    store.freezeCapture('task-a', 'turn-a', responsePath, [
      { sourceUrl: 'sandbox:/mnt/data/first.txt', label: 'first.txt' },
      { sourceUrl: 'sandbox:/mnt/data/second.txt', label: 'second.txt' },
    ]);

    expect(store.requireTurn('task-a', 'turn-a')).toMatchObject({
      status: 'capturing',
      responsePath,
      artifactSetRecorded: true,
    });
    expect(store.listArtifacts('task-a', 'turn-a')).toMatchObject([
      { ordinal: 1, sourceUrl: 'sandbox:/mnt/data/first.txt', status: 'pending' },
      { ordinal: 2, sourceUrl: 'sandbox:/mnt/data/second.txt', status: 'pending' },
    ]);
    expect(() => {
      return store.beginSendTurn('task-a', 'turn-b', '/other.md', [], 'operation-b');
    }).toThrowError(/unfinished turn/);
    expect(() => {
      return store.verifyArtifactSet('task-a', 'turn-a', [
        { sourceUrl: 'sandbox:/mnt/data/changed.txt', label: 'changed.txt' },
      ]);
    }).toThrowError(/artifact set changed/);

    await writeFile(responsePath, 'response');
    for (const ordinal of [1, 2]) {
      const localPath = join(root, `${ordinal}.txt`);
      store.setArtifactDestination('task-a', 'turn-a', ordinal, `${ordinal}.txt`, localPath);
      await writeFile(localPath, `artifact ${ordinal}`);
      store.completeArtifact('task-a', 'turn-a', ordinal);
    }
    store.completeTurn('task-a', 'turn-a', responsePath);

    expect(store.requireTurn('task-a', 'turn-a').status).toBe('completed');
    expect(
      store.listArtifacts('task-a', 'turn-a').map((artifact) => {
        return artifact.status;
      }),
    ).toEqual(['completed', 'completed']);
    store.close();
  });

  it('keeps transcript metadata readable after idempotent close and process restart', () => {
    const databasePath = join(tmpdir(), `collab-restart-${crypto.randomUUID()}.sqlite`);
    const first = new StateStore(databasePath);
    seedActiveTask(first, 'task-a', 'session-a');
    first.beginSendTurn('task-a', 'turn-a', '/prompt.md', ['/attachment'], 'operation-a');
    first.failSubmissionAndCommit('task-a', 'turn-a', 'operation-a', 'upload failed');
    first.closeTask('task-a');
    first.closeTask('task-a');
    first.close();

    const reopened = new StateStore(databasePath);
    expect(reopened.requireTask('task-a').status).toBe('closed');
    expect(reopened.listTurns('task-a')).toMatchObject([
      {
        id: 'turn-a',
        status: 'failed',
        promptPath: '/prompt.md',
        attachmentPaths: ['/attachment'],
      },
    ]);
    reopened.close();
  });

  it('keeps a stale cross-connection close attempt read-only after another connection closes', async () => {
    const databasePath = join(tmpdir(), `collab-close-race-${crypto.randomUUID()}.sqlite`);
    const winner = new StateStore(databasePath);
    const contender = new StateStore(databasePath);
    seedActiveTask(winner, 'task-a', 'session-a');

    expect(contender.requireTask('task-a').status).toBe('active');
    expect(winner.acquireCloseTaskOperation('task-a', 'winner')).toBe(true);
    winner.closeTask('task-a');
    winner.releaseTaskOperation('task-a', 'winner');
    const closedBeforeStaleAttempt = contender.requireTask('task-a');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });

    expect(contender.acquireCloseTaskOperation('task-a', 'stale-contender')).toBe(false);
    expect(contender.requireTask('task-a')).toEqual(closedBeforeStaleAttempt);
    expect(contender.getTaskOperation('task-a')).toBeNull();
    winner.close();
    contender.close();
  });

  it('serializes same-task browser operations and reclaims a dead process lease', () => {
    const databasePath = join(tmpdir(), `collab-lease-${crypto.randomUUID()}.sqlite`);
    const first = new StateStore(databasePath);
    const second = new StateStore(databasePath);
    seedActiveTask(first, 'task-a', 'session-a');
    first.acquireTaskOperation('task-a', 'wait', 'live-owner');

    expect(() => {
      second.acquireTaskOperation('task-a', 'close', 'contender');
    }).toThrowError(/busy with wait/);
    first.releaseTaskOperation('task-a', 'live-owner');
    first.acquireTaskOperation('task-a', 'wait', 'dead-owner', 999_999);
    first.attachTaskOperationChild('task-a', 'dead-owner', process.pid);
    expect(() => {
      second.acquireTaskOperation('task-a', 'close', 'contender');
    }).toThrowError(/busy with wait/);
    first.detachTaskOperationChild('task-a', 'dead-owner', process.pid);
    second.acquireTaskOperation('task-a', 'close', 'recovered-owner');
    second.releaseTaskOperation('task-a', 'recovered-owner');
    first.close();
    second.close();
  });

  it('keeps an orphaned sending turn recoverable instead of auto-failing it when reclaiming its lease', () => {
    const databasePath = join(tmpdir(), `collab-orphan-sending-${crypto.randomUUID()}.sqlite`);
    const first = new StateStore(databasePath);
    seedActiveTask(first, 'task-a', 'session-a');
    first.acquireTaskOperation('task-a', 'send', 'dead-owner', 999_999);
    first.beginSendTurn('task-a', 'turn-a', '/prompt.md', [], 'send-operation-a');
    first.close();

    const contender = new StateStore(databasePath);
    contender.acquireTaskOperation('task-a', 'send', 'contender');
    expect(contender.requireTurn('task-a', 'turn-a')).toMatchObject({ status: 'sending' });
    expect(contender.requireTask('task-a').status).toBe('active');
    contender.releaseTaskOperation('task-a', 'contender');
    contender.close();
  });

  it('keeps the operation journal and status snapshot after a process restart', () => {
    const databasePath = join(tmpdir(), `collab-journal-${crypto.randomUUID()}.sqlite`);
    const first = new StateStore(databasePath);
    seedActiveTask(first, 'task-a', 'session-a');
    const operationId = 'send-operation-a';
    const { operation } = first.beginSendTurn('task-a', 'turn-a', '/prompt.md', [], operationId);
    expect(operation).toMatchObject({ kind: 'send', step: 'draft', phase: 'prepared', progress: 0 });
    expect(operation.evidence).toBeNull();
    first.advanceSendToSubmitEffectUnknown(operationId, {
      observedAt: new Date().toISOString(),
      sessionName: 'session-a',
      postcondition: 'submit command released',
    });
    first.markSubmissionUnknownAndNeedsDecision('task-a', 'turn-a', operationId, 'submission unresolved');
    expect(first.requireOperation(operationId).phase).toBe('needs-decision');
    first.close();

    const reopened = new StateStore(databasePath);
    expect(reopened.getUncommittedTaskOperation('task-a')).toMatchObject({ phase: 'needs-decision' });
    const status = reopened.getStatus('task-a', 'missing');
    expect(status).toMatchObject({
      taskId: 'task-a',
      taskStatus: 'active',
      turnStatus: 'unknown-submission',
      operationKind: 'send',
      operationStep: 'submit',
      operationPhase: 'needs-decision',
      nextAction: 'resolve-submission',
    });
    reopened.close();
  });

  it('reports only the latest terminal turn failure after active work has settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-terminal-turn-status-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    store.beginSendTurn('task-a', 'turn-a', '/failed.md', [], 'operation-a');
    store.failSubmissionAndCommit('task-a', 'turn-a', 'operation-a', 'upload failed');

    expect(store.getStatus('task-a', 'available')).toMatchObject({
      turnId: null,
      turnStatus: null,
      error: 'upload failed',
      nextAction: 'none',
    });
    expect(store.getStatus('task-a', 'unknown', 'probe failed').error).toBe('probe failed');

    store.beginSendTurn('task-a', 'turn-b', '/completed.md', [], 'operation-b');
    expect(store.getStatus('task-a', 'available')).toMatchObject({
      turnId: 'turn-b',
      turnStatus: 'sending',
      error: null,
      nextAction: 'recover',
    });
    store.advanceSendToSubmitEffectUnknown('operation-b');
    store.commitSubmittedTurn(
      'task-a',
      'turn-b',
      'conversation-a',
      'https://chatgpt.com/c/conversation-a',
      'user-turn-b',
      'operation-b',
    );
    const responsePath = join(root, 'response.md');
    store.freezeCapture('task-a', 'turn-b', responsePath, []);
    await writeFile(responsePath, 'done');
    store.completeTurn('task-a', 'turn-b', responsePath);

    expect(store.getStatus('task-a', 'available')).toMatchObject({
      turnId: null,
      turnStatus: null,
      error: null,
      nextAction: 'none',
    });
    store.close();
  });

  it('reports the committed operation error that terminated a task before its first turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-terminal-task-status-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    store.createStartingTask('task-a', 'session-a', 'start-operation-a');
    store.finishStartTask('task-a', 'start-operation-a', 'failed', undefined, 'project unavailable');

    expect(store.getStatus('task-a', 'missing')).toMatchObject({
      taskStatus: 'failed',
      turnId: null,
      turnStatus: null,
      operationPhase: null,
      error: 'project unavailable',
      nextAction: 'none',
    });
    store.close();
  });

  it('rolls back the task outcome when its start operation cannot commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-start-outcome-rollback-'));
    const databasePath = join(root, 'state.sqlite');
    const store = new StateStore(databasePath);
    store.createStartingTask('task-a', 'session-a', 'start-operation-a');
    store.markOperationEffectUnknown('start-operation-a');
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TRIGGER reject_start_commit BEFORE UPDATE OF phase ON operation
      WHEN NEW.id = 'start-operation-a' AND NEW.phase = 'committed'
      BEGIN SELECT RAISE(ABORT, 'injected operation commit failure'); END;
    `);
    raw.close();

    expect(() => {
      store.finishStartTask('task-a', 'start-operation-a', 'failed', undefined, 'project unavailable');
    }).toThrowError(/injected operation commit failure/);
    expect(store.requireTask('task-a').status).toBe('starting');
    expect(store.requireOperation('start-operation-a').phase).toBe('effect-unknown');
    expect(store.getStatus('task-a', 'missing').nextAction).toBe('recover');
    store.close();
  });

  it('enforces one uncommitted operation per task and one global uncommitted setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-operation-constraints-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    seedActiveTask(store, 'task-b', 'session-b');
    store.createOperation({
      id: 'setup-1',
      kind: 'setup',
      step: 'login',
      taskId: null,
      turnId: null,
      sessionName: 'setup-session',
    });
    expect(() => {
      return store.createOperation({
        id: 'setup-2',
        kind: 'setup',
        step: 'login',
        taskId: null,
        turnId: null,
        sessionName: 'setup-session',
      });
    }).toThrowError(/uncommitted setup/);
    store.createOperation({
      id: 'start-1',
      kind: 'start',
      step: 'session',
      taskId: 'task-a',
      turnId: null,
      sessionName: 'session-a',
    });
    expect(() => {
      return store.createOperation({
        id: 'archive-1',
        kind: 'archive',
        step: 'archive',
        taskId: 'task-a',
        turnId: null,
        sessionName: 'session-a',
      });
    }).toThrowError(/uncommitted operation/);
    expect(() => {
      return store.createOperation({
        id: 'invalid-step',
        kind: 'send',
        step: 'login',
        taskId: 'task-b',
        turnId: null,
        sessionName: 'session-b',
      });
    }).toThrowError(/step login is invalid/);
    store.commitOperation('start-1', 'automatic');
    store.createOperation({
      id: 'archive-2',
      kind: 'archive',
      step: 'archive',
      taskId: 'task-a',
      turnId: null,
      sessionName: 'session-a',
    });
    store.close();
  });

  it('computes closing, closed, and missing-browser next actions from the status snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-next-action-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    expect(store.getStatus('task-a', 'available').nextAction).toBe('none');
    expect(store.getStatus('task-a', 'unknown', 'probe failed')).toMatchObject({
      browserStatus: 'unknown',
      error: 'probe failed',
    });
    expect(store.getStatus('task-a', 'missing').nextAction).toBe('recover');

    store.markTaskClosing('task-a');
    expect(store.getStatus('task-a', 'missing')).toMatchObject({ taskStatus: 'closing', nextAction: 'close' });
    store.closeTask('task-a');
    expect(store.getStatus('task-a', 'missing')).toMatchObject({ taskStatus: 'closed', nextAction: 'recover' });
    expect(store.requireTask('task-a').closedAt).not.toBeNull();
    const reactivated = store.reactivateClosedTask('task-a');
    expect(reactivated).toMatchObject({ status: 'active', closedAt: null });
    expect(store.getStatus('task-a', 'available').nextAction).toBe('none');
    store.close();
  });

  it('routes a missing browser ahead of a pending turn and keeps wait for an available one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-next-action-route-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    store.beginSendTurn('task-a', 'turn-a', '/prompt.md', [], 'operation-a');
    store.advanceSendToSubmitEffectUnknown('operation-a');
    store.commitSubmittedTurn(
      'task-a',
      'turn-a',
      'conversation-a',
      'https://chatgpt.com/c/conversation-a',
      'user-turn-a',
      'operation-a',
    );
    expect(store.getStatus('task-a', 'missing').nextAction).toBe('recover');
    expect(store.getStatus('task-a', 'available').nextAction).toBe('wait');
    store.close();
  });

  it('returns recover for a closed task with a pending turn and rejects reactivating a non-closed task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-closed-recover-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    store.beginSendTurn('task-a', 'turn-a', '/prompt.md', [], 'operation-a');
    store.advanceSendToSubmitEffectUnknown('operation-a');
    store.commitSubmittedTurn(
      'task-a',
      'turn-a',
      'conversation-a',
      'https://chatgpt.com/c/conversation-a',
      'user-turn-a',
      'operation-a',
    );
    store.closeTask('task-a');
    expect(store.getStatus('task-a', 'available').nextAction).toBe('recover');
    expect(store.getStatus('task-a', 'missing').nextAction).toBe('recover');

    seedActiveTask(store, 'task-b', 'session-b');
    store.failTask('task-b');
    expect(store.requireTask('task-b').status).toBe('failed');
    expect(store.getStatus('task-b', 'missing').nextAction).toBe('none');
    expect(() => {
      return store.reactivateClosedTask('task-b');
    }).toThrowError(/expected closed/);
    expect(store.requireTask('task-a').status).toBe('closed');
    expect(store.reactivateClosedTask('task-a')).toMatchObject({ status: 'active', closedAt: null });
    store.close();
  });
});

describe('BEH-013 failed-response and capture-abandonment state gate', () => {
  const pendingTurn = (store: StateStore, taskId: string, turnId: string): void => {
    const operationId = `${taskId}-${turnId}-send-operation`;
    store.beginSendTurn(taskId, turnId, '/prompt.md', [], operationId);
    store.advanceSendToSubmitEffectUnknown(operationId);
    store.commitSubmittedTurn(
      taskId,
      turnId,
      'conversation-a',
      'https://chatgpt.com/c/conversation-a',
      `user-turn-${taskId}`,
      operationId,
    );
  };

  it('atomically fails a pending turn and records the complete human resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-resolve-turn-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    pendingTurn(store, 'task-a', 'turn-a');

    const failed = store.failTurnWithResolution('task-a', 'turn-a', {
      adjudication: 'failed',
      resolvedAt: '2026-08-09T00:00:00.000Z',
      sourceStatus: 'pending',
      pageUrl: 'https://chatgpt.com/c/conversation-a',
      userTurnIdentity: 'user-turn-task-a',
      stop: 'absent',
    });

    expect(failed).toMatchObject({ status: 'failed' });
    expect(JSON.parse(failed.error ?? '{}')).toEqual({
      adjudication: 'failed',
      resolvedAt: '2026-08-09T00:00:00.000Z',
      sourceStatus: 'pending',
      pageUrl: 'https://chatgpt.com/c/conversation-a',
      userTurnIdentity: 'user-turn-task-a',
      stop: 'absent',
    });
    expect(store.getFailedTurnResolution('task-a', 'turn-a')).toEqual({
      adjudication: 'failed',
      resolvedAt: '2026-08-09T00:00:00.000Z',
      sourceStatus: 'pending',
      pageUrl: 'https://chatgpt.com/c/conversation-a',
      userTurnIdentity: 'user-turn-task-a',
      stop: 'absent',
    });
    expect(store.requireTask('task-a').status).toBe('active');
    store.beginSendTurn('task-a', 'turn-b', '/next.md', [], 'operation-b');
    store.close();
  });

  it('atomically abandons a capturing turn without changing its frozen response or artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-abandon-capture-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    pendingTurn(store, 'task-a', 'turn-a');
    const responsePath = join(root, 'response.md');
    const artifactPath = join(root, 'artifact.txt');
    store.freezeCapture('task-a', 'turn-a', responsePath, [
      { sourceUrl: 'sandbox:/mnt/data/artifact.txt', label: 'artifact.txt' },
    ]);
    await writeFile(responsePath, 'published response');
    store.setArtifactDestination('task-a', 'turn-a', 1, 'artifact.txt', artifactPath);
    store.recordArtifactError('task-a', 'turn-a', 1, 'download unavailable');

    const failed = store.failTurnWithResolution('task-a', 'turn-a', {
      adjudication: 'failed',
      resolvedAt: '2026-08-09T00:00:00.000Z',
      sourceStatus: 'capturing',
    });

    expect(failed).toMatchObject({
      status: 'failed',
      responsePath,
      artifactSetRecorded: true,
    });
    expect(JSON.parse(failed.error ?? '{}')).toEqual({
      adjudication: 'failed',
      resolvedAt: '2026-08-09T00:00:00.000Z',
      sourceStatus: 'capturing',
    });
    expect(store.listArtifacts('task-a', 'turn-a')).toMatchObject([
      { status: 'pending', localPath: artifactPath, error: 'download unavailable' },
    ]);
    store.beginSendTurn('task-a', 'turn-b', '/next.md', [], 'operation-b');
    store.close();
  });

  it('rejects completed, sending, unknown-submission, other-failed, and non-active turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-resolve-turn-gates-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-sending', 'session-sending');
    pendingTurn(store, 'task-sending', 'turn-a');
    store.close();

    const sending = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(sending, 'task-other', 'session-other');
    sending.beginSendTurn('task-other', 'turn-sending', '/prompt.md', [], 'operation-sending');
    expect(() => {
      return sending.failTurnWithResolution('task-other', 'turn-sending', {
        adjudication: 'failed',
        resolvedAt: '2026-08-09T00:00:00.000Z',
        sourceStatus: 'pending',
        pageUrl: 'https://chatgpt.com/c/conversation-a',
        userTurnIdentity: 'user-turn-task-other',
        stop: 'absent',
      });
    }).toThrowError(/expected pending/);
    expect(sending.requireTurn('task-other', 'turn-sending').status).toBe('sending');
    expect(sending.getFailedTurnResolution('task-other', 'turn-sending')).toBeNull();

    seedActiveTask(sending, 'task-unknown', 'session-unknown');
    sending.beginSendTurn('task-unknown', 'turn-unknown', '/prompt.md', [], 'operation-unknown');
    sending.advanceSendToSubmitEffectUnknown('operation-unknown');
    sending.markSubmissionUnknownAndNeedsDecision(
      'task-unknown',
      'turn-unknown',
      'operation-unknown',
      'submission unresolved',
    );
    expect(() => {
      return sending.failTurnWithResolution('task-unknown', 'turn-unknown', {
        adjudication: 'failed',
        resolvedAt: '2026-08-09T00:00:00.000Z',
        sourceStatus: 'pending',
        pageUrl: 'https://chatgpt.com/c/conversation-a',
        userTurnIdentity: 'user-turn-task-unknown',
        stop: 'absent',
      });
    }).toThrowError(/expected pending/);
    expect(sending.requireTurn('task-unknown', 'turn-unknown').status).toBe('unknown-submission');

    seedActiveTask(sending, 'task-completed', 'session-completed');
    sending.beginSendTurn('task-completed', 'turn-completed', '/prompt.md', [], 'operation-completed');
    sending.advanceSendToSubmitEffectUnknown('operation-completed');
    sending.commitSubmittedTurn(
      'task-completed',
      'turn-completed',
      'conversation-b',
      'https://chatgpt.com/c/conversation-b',
      'user-turn-completed',
      'operation-completed',
    );
    const responsePath = join(root, 'completed.md');
    sending.freezeCapture('task-completed', 'turn-completed', responsePath, []);
    await writeFile(responsePath, 'done');
    sending.completeTurn('task-completed', 'turn-completed', responsePath);
    expect(() => {
      return sending.failTurnWithResolution('task-completed', 'turn-completed', {
        adjudication: 'failed',
        resolvedAt: '2026-08-09T00:00:00.000Z',
        sourceStatus: 'pending',
        pageUrl: 'https://chatgpt.com/c/conversation-b',
        userTurnIdentity: 'user-turn-completed',
        stop: 'absent',
      });
    }).toThrowError(/expected pending/);
    expect(sending.requireTurn('task-completed', 'turn-completed').status).toBe('completed');

    seedActiveTask(sending, 'task-failed', 'session-failed');
    sending.beginSendTurn('task-failed', 'turn-failed', '/prompt.md', [], 'operation-failed');
    sending.failSubmissionAndCommit('task-failed', 'turn-failed', 'operation-failed', 'pre-submission failure');
    expect(() => {
      return sending.failTurnWithResolution('task-failed', 'turn-failed', {
        adjudication: 'failed',
        resolvedAt: '2026-08-09T00:00:00.000Z',
        sourceStatus: 'pending',
        pageUrl: 'https://chatgpt.com/c/conversation-a',
        userTurnIdentity: 'user-turn-task-failed',
        stop: 'absent',
      });
    }).toThrowError(/expected pending/);
    expect(sending.requireTurn('task-failed', 'turn-failed').error).toBe('pre-submission failure');
    expect(sending.getFailedTurnResolution('task-failed', 'turn-failed')).toBeNull();

    sending.closeTask('task-sending');
    expect(() => {
      return sending.failTurnWithResolution('task-sending', 'turn-a', {
        adjudication: 'failed',
        resolvedAt: '2026-08-09T00:00:00.000Z',
        sourceStatus: 'pending',
        pageUrl: 'https://chatgpt.com/c/conversation-a',
        userTurnIdentity: 'user-turn-task-sending',
        stop: 'absent',
      });
    }).toThrowError(/task is closed/);
    expect(sending.requireTurn('task-sending', 'turn-a').status).toBe('pending');
    sending.close();
  });

  it('rejects a pending turn whose user identity was not persisted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-resolve-turn-identity-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    pendingTurn(store, 'task-a', 'turn-a');
    const raw = new DatabaseSync(join(root, 'state.sqlite'));
    raw.prepare('UPDATE turn SET user_turn_identity = NULL WHERE task_id = ? AND id = ?').run('task-a', 'turn-a');
    raw.close();

    expect(() => {
      return store.failTurnWithResolution('task-a', 'turn-a', {
        adjudication: 'failed',
        resolvedAt: '2026-08-09T00:00:00.000Z',
        sourceStatus: 'pending',
        pageUrl: 'https://chatgpt.com/c/conversation-a',
        userTurnIdentity: 'user-turn-task-a',
        stop: 'stopped',
      });
    }).toThrowError(/no user turn identity/);
    expect(store.requireTurn('task-a', 'turn-a').status).toBe('pending');
    expect(store.getFailedTurnResolution('task-a', 'turn-a')).toBeNull();
    store.close();
  });

  it('keeps the failed turn the only unfinished-free blocker and leaves later turns possible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-resolve-turn-continue-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    seedActiveTask(store, 'task-a', 'session-a');
    pendingTurn(store, 'task-a', 'turn-a');
    store.failTurnWithResolution('task-a', 'turn-a', {
      adjudication: 'failed',
      resolvedAt: '2026-08-09T00:00:00.000Z',
      sourceStatus: 'pending',
      pageUrl: 'https://chatgpt.com/c/conversation-a',
      userTurnIdentity: 'user-turn-task-a',
      stop: 'stopped',
    });

    const continuation = store.beginSendTurn('task-a', 'turn-b', '/continuation.md', [], 'operation-b');
    expect(continuation.turn).toMatchObject({ id: 'turn-b', status: 'sending' });
    store.close();
  });
});

describe('fresh-start races', () => {
  it('rejects an old turn table before creating an index that depends on a missing column', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-incompatible-turn-'));
    const databasePath = join(root, 'state.sqlite');
    const current = new StateStore(databasePath);
    current.close();
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      DROP INDEX turn_task_user_identity;
      DROP TABLE turn;
      CREATE TABLE turn (
        task_id TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('sending', 'pending', 'capturing', 'completed', 'failed', 'unknown-submission')
        ),
        prompt_path TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        response_path TEXT,
        artifact_set_recorded INTEGER NOT NULL DEFAULT 0 CHECK (artifact_set_recorded IN (0, 1)),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, id),
        FOREIGN KEY (task_id) REFERENCES task(id)
      ) STRICT;
    `);
    raw.close();

    let thrown: unknown;
    let opened: StateStore | null = null;
    try {
      opened = new StateStore(databasePath);
    } catch (error) {
      thrown = error;
    }
    opened?.close();
    expect(thrown).toBeInstanceOf(StateError);
    expect(thrown).toMatchObject({
      code: 'STATE_SCHEMA_INCOMPATIBLE',
      message: expect.stringMatching(/does not match the current schema/),
    });
  });

  it('rejects a same-column task table with an obsolete status check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-incompatible-task-status-'));
    const databasePath = join(root, 'state.sqlite');
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        playwright_session TEXT NOT NULL UNIQUE,
        conversation_id TEXT,
        conversation_url TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'closing', 'closed', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        browser_operation_token TEXT,
        browser_operation_pid INTEGER,
        browser_operation_name TEXT,
        browser_operation_child_pid INTEGER,
        browser_operation_command_pid INTEGER
      ) STRICT;
    `);
    raw.close();

    expect(() => {
      const store = new StateStore(databasePath);
      try {
        store.createStartingTask('task-a', 'session-a', 'operation-a');
      } finally {
        store.close();
      }
    }).toThrowError(/does not match the current schema/);
  });

  it('rejects an incompatible task table instead of migrating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-incompatible-task-'));
    const databasePath = join(root, 'state.sqlite');
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        playwright_session TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL
      );
    `);
    raw.close();

    expect(() => {
      return new StateStore(databasePath);
    }).toThrowError(/does not match the current schema/);
  });

  it('keeps a unique-constraint loser from masking a raced start reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-start-race-'));
    const databasePath = join(root, 'state.sqlite');
    const winner = new StateStore(databasePath);
    winner.createStartingTask('task-a', 'chatgpt-pro-collab-task-a', 'winner-op');
    winner.close();

    const loser = new StateStore(databasePath);
    expect(() => {
      loser.createStartingTask('task-a', 'chatgpt-pro-collab-task-a', 'loser-op');
    }).toThrowError(/TASK_CONFLICT|already exists/);
    expect(loser.getTask('task-a')).toMatchObject({ status: 'starting' });
    expect(loser.getUncommittedTaskOperation('task-a')).toMatchObject({ id: 'winner-op' });
    loser.close();
  });
});
