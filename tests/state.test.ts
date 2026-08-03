import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { StateError, StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';

describe('BEH-002, BEH-005, and BEH-007 state gates', () => {
  it('binds one conversation and permits only one unfinished turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-state-'));
    const store = new StateStore(join(root, 'state.sqlite'));
    store.createTask('task-a', 'session-a');
    store.beginTurn('task-a', 'turn-a', '/prompt.md', ['/a', '/b']);

    expect(() => {
      return store.beginTurn('task-a', 'turn-b', '/other.md', []);
    }).toThrowError(StateError);

    store.markTurnPending('task-a', 'turn-a', 'conversation-a', 'https://chatgpt.com/c/conversation-a');
    const responsePath = join(root, 'response.md');
    await writeFile(responsePath, 'response');
    store.completeTurn('task-a', 'turn-a', responsePath);
    store.beginTurn('task-a', 'turn-b', '/other.md', []);

    expect(() => {
      return store.markTurnPending('task-a', 'turn-b', 'conversation-b', 'https://chatgpt.com/c/conversation-b');
    }).toThrowError(/different conversation/);
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
});
