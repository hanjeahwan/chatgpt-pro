import { execFile } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';

const execFileAsync = promisify(execFile);

describe('VER-011 SQLite cross-process concurrency', () => {
  it('does not lose or cross-contaminate task transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-concurrency-'));
    const databasePath = join(root, 'state.sqlite');
    const workerPath = join(import.meta.dirname, 'support', 'state-worker.ts');

    await Promise.all([
      execFileAsync(process.execPath, [workerPath, databasePath, 'task-a', 'turn-a']),
      execFileAsync(process.execPath, [workerPath, databasePath, 'task-b', 'turn-b']),
    ]);

    const reopened = new StateStore(databasePath);
    for (const suffix of ['a', 'b']) {
      const taskId = `task-${suffix}`;
      const turnId = `turn-${suffix}`;
      const task = reopened.requireTask(taskId);
      const turn = reopened.requireTurn(taskId, turnId);
      expect(task).toMatchObject({ status: 'closed', playwrightSession: `session-${suffix}` });
      expect(turn).toMatchObject({ status: 'completed', promptPath: `/prompt-${suffix}.md` });
      expect(turn.responsePath).toContain(`${taskId}-${turnId}.md`);
    }
    reopened.close();
  });

  it('rejects a second process while one task browser lease is live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-operation-concurrency-'));
    const databasePath = join(root, 'state.sqlite');
    const readyPath = join(root, 'ready');
    const store = new StateStore(databasePath);
    store.createTask('task-a', 'session-a');
    store.close();
    const workerPath = join(import.meta.dirname, 'support', 'operation-lease-worker.ts');
    const worker = execFileAsync(process.execPath, [workerPath, databasePath, readyPath]);
    await waitForPath(readyPath);

    const contender = new StateStore(databasePath);
    expect(() => {
      contender.acquireTaskOperation('task-a', 'close', 'contender');
    }).toThrowError(/busy with wait/);
    await worker;
    contender.acquireTaskOperation('task-a', 'close', 'contender');
    contender.releaseTaskOperation('task-a', 'contender');
    contender.close();
  });
});

/**
 * Waits for a worker-owned ready file without assuming process startup latency.
 *
 * @param path Ready-file path written after lease acquisition.
 * @returns Nothing after the file becomes readable.
 * @throws {Error} If the worker never publishes readiness within five seconds.
 */
async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
}
