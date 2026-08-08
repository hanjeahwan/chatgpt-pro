import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { StateError, StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';

describe('BEH-002, BEH-005, BEH-007, and BEH-008 state gates', () => {
  it('binds one conversation and permits only one unfinished turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-state-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    store.createTask('task-a', 'session-a');
    store.beginTurn('task-a', 'turn-a', '/prompt.md', ['/a', '/b']);

    expect(() => {
      return store.beginTurn('task-a', 'turn-b', '/other.md', []);
    }).toThrowError(StateError);

    store.markSubmissionAttempting('task-a', 'turn-a');
    store.markTurnPending('task-a', 'turn-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a', 'user-turn-a');
    expect(store.requireTurn('task-a', 'turn-a')).toMatchObject({ status: 'pending', error: null });
    const responsePath = join(root, 'response.md');
    store.freezeCapture('task-a', 'turn-a', responsePath, []);
    await writeFile(responsePath, 'response');
    store.completeTurn('task-a', 'turn-a', responsePath);
    store.beginTurn('task-a', 'turn-b', '/other.md', []);
    store.markSubmissionAttempting('task-a', 'turn-b');

    expect(() => {
      return store.markTurnPending(
        'task-a',
        'turn-b',
        'conversation-b',
        'https://chatgpt.com/c/conversation-b',
        'user-turn-b',
      );
    }).toThrowError(/different conversation/);
    expect(() => {
      return store.markTurnPending(
        'task-a',
        'turn-b',
        'conversation-a',
        'https://chatgpt.com/c/conversation-a',
        'user-turn-a',
      );
    }).toThrowError(/user turn identity/);
    store.close();
  });

  it('freezes ordered artifacts before publication and completes only readable files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-artifact-state-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    store.createTask('task-a', 'session-a');
    store.beginTurn('task-a', 'turn-a', '/prompt.md', []);
    store.markSubmissionAttempting('task-a', 'turn-a');
    store.markTurnPending('task-a', 'turn-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a', 'user-turn-a');
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
      return store.beginTurn('task-a', 'turn-b', '/other.md', []);
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
    first.createTask('task-a', 'session-a');
    first.beginTurn('task-a', 'turn-a', '/prompt.md', ['/attachment']);
    first.failSendingTurn('task-a', 'turn-a', 'upload failed');
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
    winner.createTask('task-a', 'session-a');

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
    first.createTask('task-a', 'session-a');
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
    first.createTask('task-a', 'session-a');
    first.acquireTaskOperation('task-a', 'send', 'dead-owner', 999_999);
    first.beginTurn('task-a', 'turn-a', '/prompt.md', []);
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
    first.createTask('task-a', 'session-a');
    const operationId = 'send-operation-a';
    first.beginTurn('task-a', 'turn-a', '/prompt.md', []);
    const operation = first.createOperation({
      id: operationId,
      kind: 'send',
      step: 'draft',
      taskId: 'task-a',
      turnId: 'turn-a',
      sessionName: 'session-a',
    });
    expect(operation).toMatchObject({ kind: 'send', step: 'draft', phase: 'prepared', progress: 0 });
    first.advanceOperationStep(operationId, 'submit');
    first.markOperationEffectUnknown(operationId, {
      observedAt: new Date().toISOString(),
      sessionName: 'session-a',
      postcondition: 'submit command released',
    });
    first.markOperationNeedsDecision(operationId);
    expect(first.requireOperation(operationId).phase).toBe('needs-decision');
    first.markSubmissionAttempting('task-a', 'turn-a');
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

  it('enforces one uncommitted operation per task and one global uncommitted setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-operation-constraints-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    store.createTask('task-a', 'session-a');
    store.createTask('task-b', 'session-b');
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
    store.createTask('task-a', 'session-a');
    expect(store.getStatus('task-a', 'available').nextAction).toBe('none');
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
    store.createTask('task-a', 'session-a');
    store.beginTurn('task-a', 'turn-a', '/prompt.md', []);
    store.markSubmissionAttempting('task-a', 'turn-a');
    store.markTurnPending('task-a', 'turn-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a', 'user-turn-a');
    expect(store.getStatus('task-a', 'missing').nextAction).toBe('recover');
    expect(store.getStatus('task-a', 'available').nextAction).toBe('wait');
    store.close();
  });

  it('returns recover for a closed task with a pending turn and rejects reactivating a non-closed task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-closed-recover-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    store.createTask('task-a', 'session-a');
    store.beginTurn('task-a', 'turn-a', '/prompt.md', []);
    store.markSubmissionAttempting('task-a', 'turn-a');
    store.markTurnPending('task-a', 'turn-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a', 'user-turn-a');
    store.closeTask('task-a');
    expect(store.getStatus('task-a', 'available').nextAction).toBe('recover');
    expect(store.getStatus('task-a', 'missing').nextAction).toBe('recover');

    store.createTask('task-b', 'session-b');
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

describe('fresh-start races', () => {
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
