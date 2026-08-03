import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
    second.acquireTaskOperation('task-a', 'close', 'recovered-owner');
    second.releaseTaskOperation('task-a', 'recovered-owner');
    first.close();
    second.close();
  });

  it('adds operation leases to an existing two-table task schema', () => {
    const databasePath = join(tmpdir(), `collab-migration-${crypto.randomUUID()}.sqlite`);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        playwright_session TEXT NOT NULL UNIQUE,
        conversation_id TEXT,
        conversation_url TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      ) STRICT;
    `);
    legacy.close();

    const migrated = new StateStore(databasePath);
    migrated.createTask('task-a', 'session-a');
    expect(() => {
      migrated.acquireTaskOperation('task-a', 'send', 'owner');
    }).not.toThrow();
    migrated.releaseTaskOperation('task-a', 'owner');
    migrated.close();
  });
});
