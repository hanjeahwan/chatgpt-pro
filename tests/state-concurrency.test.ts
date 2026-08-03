import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
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
});
