import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
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
    const initialized = new StateStore(databasePath);
    initialized.close();

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

  it('keeps an orphan browser-command child fenced after its CLI parent exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-orphan-operation-'));
    const databasePath = join(root, 'state.sqlite');
    const readyPath = join(root, 'ready');
    const store = new StateStore(databasePath);
    store.createTask('task-a', 'session-a');
    store.close();
    const workerPath = join(import.meta.dirname, 'support', 'orphan-operation-worker.ts');

    await execFileAsync(process.execPath, [workerPath, databasePath, readyPath]);
    const childPid = Number(await readFile(readyPath, 'utf8'));
    expect(Number.isSafeInteger(childPid)).toBe(true);

    const contender = new StateStore(databasePath);
    expect(() => {
      contender.acquireTaskOperation('task-a', 'close', 'contender');
    }).toThrowError(/busy with wait/);
    await waitForPidExit(childPid);
    contender.acquireTaskOperation('task-a', 'close', 'contender');
    contender.releaseTaskOperation('task-a', 'contender');
    contender.close();
  });

  it('keeps the real command fenced when both its send parent and gate are killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-orphan-send-'));
    const databasePath = join(root, 'state.sqlite');
    const readyPath = join(root, 'ready');
    const store = new StateStore(databasePath);
    store.createTask('task-a', 'session-a');
    store.close();
    const workerPath = join(import.meta.dirname, 'support', 'orphan-send-worker.ts');
    const gatePath = join(
      import.meta.dirname,
      '..',
      'skills',
      'chatgpt-pro-collab',
      'scripts',
      'browser-command-gate.ts',
    );
    const worker = spawn(process.execPath, [workerPath, databasePath, readyPath, gatePath], { stdio: 'ignore' });
    const workerCompletion = waitForExit(worker);
    await waitForPath(readyPath);
    const processRecord = JSON.parse(await readFile(readyPath, 'utf8')) as {
      readonly gatePid: number;
      readonly commandPid: number;
    };

    process.kill(processRecord.gatePid, 'SIGKILL');
    worker.kill('SIGKILL');
    await workerCompletion;
    await waitForPidExit(processRecord.gatePid);
    const contender = new StateStore(databasePath);
    expect(() => {
      contender.acquireTaskOperation('task-a', 'send', 'contender');
    }).toThrowError(/busy with send/);
    await waitForPidExit(processRecord.commandPid);
    contender.acquireTaskOperation('task-a', 'send', 'contender');
    expect(contender.requireTurn('task-a', 'turn-a')).toMatchObject({ status: 'unknown-submission' });
    contender.releaseTaskOperation('task-a', 'contender');
    contender.close();
  });
});

/**
 * Resolves one spawned worker after either ordinary or signal termination.
 *
 * @param child Spawned worker process.
 * @returns Exit code, using 1 for signal termination.
 * @throws {Error} If the operating system cannot start the worker.
 */
function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

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

/**
 * Waits until an intentionally orphaned test child is no longer alive.
 *
 * @param pid Positive child process identifier published by the worker.
 * @returns Nothing after the operating system reports that the process is gone.
 * @throws {Error} If the child remains alive beyond five seconds.
 */
async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isMissingProcess(error)) {
        return;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`orphan test child remained alive: ${pid}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/**
 * Distinguishes a missing process from permission and argument failures.
 *
 * @param error Unknown exception from the process signal probe.
 * @returns Whether the operating system reported ESRCH.
 * @throws {Error} This predicate does not throw.
 */
function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}
