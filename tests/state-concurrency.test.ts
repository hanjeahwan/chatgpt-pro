import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';
import { seedActiveTask } from './support/state.ts';

const execFileAsync = promisify(execFile);

describe('VER-011 SQLite cross-process concurrency', () => {
  it('reads task and operation status from one SQLite snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-status-snapshot-'));
    const databasePath = join(root, 'state.sqlite');
    const initialized = new StateStore(databasePath);
    initialized.createStartingTask('task-a', 'session-a', 'start-op');
    initialized.close();
    const writer = new DatabaseSync(databasePath);
    const reader = new InterleavedStatusStore(databasePath, () => {
      writer.exec(`
        BEGIN IMMEDIATE;
        UPDATE task SET status = 'active' WHERE id = 'task-a';
        UPDATE operation SET phase = 'committed', committed_at = updated_at WHERE id = 'start-op';
        COMMIT;
      `);
    });

    expect(reader.getStatus('task-a', 'available')).toMatchObject({
      taskStatus: 'starting',
      operationKind: 'start',
      operationPhase: 'prepared',
    });
    reader.close();
    writer.close();
  });

  it('rolls back a subprocess killed after the first artifact insert in the capture transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-capture-transaction-'));
    const databasePath = join(root, 'state.sqlite');
    const readyPath = join(root, 'freeze-ready');
    const workerPath = join(import.meta.dirname, 'support', 'capture-recovery-worker.ts');
    const worker = spawn(process.execPath, [workerPath, 'interrupt-freeze', databasePath, root, readyPath], {
      stdio: 'ignore',
    });
    const workerCompletion = waitForExit(worker);
    await waitForPath(readyPath);

    worker.kill('SIGKILL');
    await workerCompletion;
    const reopened = new StateStore(databasePath);
    expect(reopened.requireTurn('task-a', 'turn-a')).toMatchObject({
      status: 'pending',
      responsePath: null,
      artifactSetRecorded: false,
    });
    expect(reopened.listArtifacts('task-a', 'turn-a')).toEqual([]);
    reopened.freezeCapture('task-a', 'turn-a', join(root, 'response.md'), [
      { sourceUrl: 'sandbox:/mnt/data/first.txt', label: 'first.txt' },
      { sourceUrl: 'sandbox:/mnt/data/second.txt', label: 'second.txt' },
    ]);
    expect(reopened.requireTurn('task-a', 'turn-a')).toMatchObject({
      status: 'capturing',
      responsePath: join(root, 'response.md'),
      artifactSetRecorded: true,
    });
    expect(reopened.listArtifacts('task-a', 'turn-a')).toHaveLength(2);
    reopened.close();
  });

  it.each(['capturing-frozen', 'response-published', 'artifact-published', 'partial-artifacts'] as const)(
    'recovers after a real subprocess is killed at %s',
    async (checkpoint) => {
      const root = await mkdtemp(join(tmpdir(), `collab-capture-${checkpoint}-`));
      const databasePath = join(root, 'state.sqlite');
      const readyPath = join(root, 'prepare-ready');
      const resultPath = join(root, 'recovery-result.json');
      const workerPath = join(import.meta.dirname, 'support', 'capture-recovery-worker.ts');
      const worker = spawn(process.execPath, [workerPath, 'prepare', databasePath, root, checkpoint, readyPath], {
        stdio: 'ignore',
      });
      const workerCompletion = waitForExit(worker);
      await waitForPath(readyPath);

      worker.kill('SIGKILL');
      await workerCompletion;
      const interrupted = new StateStore(databasePath);
      expect(interrupted.requireTurn('task-a', 'turn-a')).toMatchObject({
        status: 'capturing',
        responsePath: join(root, 'response.md'),
        artifactSetRecorded: true,
      });
      expect(interrupted.listArtifacts('task-a', 'turn-a')).toHaveLength(2);
      interrupted.close();

      await execFileAsync(process.execPath, [workerPath, 'recover', databasePath, root, resultPath]);
      const recovered = JSON.parse(await readFile(resultPath, 'utf8')) as {
        readonly turn: { readonly status: string };
        readonly artifacts: readonly { readonly status: string; readonly localPath: string }[];
      };
      expect(recovered.turn.status).toBe('completed');
      expect(recovered.artifacts).toMatchObject([
        { status: 'completed', localPath: join(root, 'artifact-1.txt') },
        { status: 'completed', localPath: join(root, 'artifact-2.txt') },
      ]);
      await expect(readFile(join(root, 'response.md'), 'utf8')).resolves.toBe('stable response');
      await expect(readFile(join(root, 'artifact-1.txt'), 'utf8')).resolves.toBe('artifact 1');
      await expect(readFile(join(root, 'artifact-2.txt'), 'utf8')).resolves.toBe('artifact 2');
    },
  );

  it('serializes a concurrent close behind subprocess capture recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-capture-close-'));
    const databasePath = join(root, 'state.sqlite');
    const prepareReadyPath = join(root, 'prepare-ready');
    const recoveryReadyPath = join(root, 'recovery-ready');
    const continuePath = join(root, 'continue');
    const recoveryResultPath = join(root, 'recovery-result.json');
    const closeResultPath = join(root, 'close-result.json');
    const closeReadyPath = join(root, 'close-ready');
    const workerPath = join(import.meta.dirname, 'support', 'capture-recovery-worker.ts');
    const interrupted = spawn(
      process.execPath,
      [workerPath, 'prepare', databasePath, root, 'partial-artifacts', prepareReadyPath],
      { stdio: 'ignore' },
    );
    const interruptedCompletion = waitForExit(interrupted);
    await waitForPath(prepareReadyPath);
    interrupted.kill('SIGKILL');
    await interruptedCompletion;

    const recovery = spawn(
      process.execPath,
      [workerPath, 'recover', databasePath, root, recoveryResultPath, recoveryReadyPath, continuePath],
      { stdio: 'ignore' },
    );
    const recoveryCompletion = waitForExit(recovery);
    await waitForPath(recoveryReadyPath);
    const close = spawn(process.execPath, [workerPath, 'close', databasePath, root, closeResultPath, closeReadyPath], {
      stdio: 'ignore',
    });
    const closeCompletion = waitForExit(close);
    await waitForPath(closeReadyPath);
    await writeFile(continuePath, 'continue', { flag: 'wx' });

    await expect(recoveryCompletion).resolves.toBe(0);
    await expect(closeCompletion).resolves.toBe(0);
    const closeResult = JSON.parse(await readFile(closeResultPath, 'utf8')) as {
      readonly busyCount: number;
      readonly task: { readonly status: string };
    };
    expect(closeResult.busyCount).toBeGreaterThan(0);
    expect(closeResult.task.status).toBe('closed');
    const reopened = new StateStore(databasePath);
    expect(reopened.requireTurn('task-a', 'turn-a').status).toBe('completed');
    expect(reopened.listArtifacts('task-a', 'turn-a')).toMatchObject([
      { status: 'completed' },
      { status: 'completed' },
    ]);
    reopened.close();
  });

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

  it('keeps a start lease fenced while its browser child and command are still alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-start-fence-'));
    const databasePath = join(root, 'state.sqlite');
    const readyPath = join(root, 'ready');
    const store = new StateStore(databasePath);
    seedActiveTask(store, 'task-a', 'session-a');
    store.close();
    const workerPath = join(import.meta.dirname, 'support', 'orphan-start-worker.ts');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
    const command = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
    const childPid = child.pid;
    const commandPid = command.pid;
    if (childPid === undefined || commandPid === undefined) {
      throw new Error('fixture child or command did not spawn');
    }

    await execFileAsync(process.execPath, [
      workerPath,
      databasePath,
      readyPath,
      childPid.toString(),
      commandPid.toString(),
    ]);
    const contender = new StateStore(databasePath);
    expect(() => {
      contender.acquireTaskOperation('task-a', 'start', 'contender');
    }).toThrowError(/busy with start/);
    child.kill('SIGKILL');
    command.kill('SIGKILL');
    await waitForPidExit(childPid);
    await waitForPidExit(commandPid);
    contender.acquireTaskOperation('task-a', 'start', 'contender');
    contender.releaseTaskOperation('task-a', 'contender');
    contender.close();
  });

  it('keeps an orphan setup lease fenced until its gate and command have both exited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-setup-fence-'));
    const databasePath = join(root, 'state.sqlite');
    const initialized = new StateStore(databasePath);
    initialized.close();
    const workerPath = join(import.meta.dirname, 'support', 'orphan-setup-worker.ts');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
    const command = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
    const childPid = child.pid;
    const commandPid = command.pid;
    let contender: StateStore | undefined;
    try {
      if (childPid === undefined || commandPid === undefined) {
        throw new Error('fixture child or command did not spawn');
      }

      await execFileAsync(process.execPath, [workerPath, databasePath, childPid.toString(), commandPid.toString()]);
      const opened = new StateStore(databasePath);
      contender = opened;
      expect(() => {
        opened.acquireSetupOperation('contender');
      }).toThrowError(/setup browser is busy/);
      child.kill('SIGKILL');
      await waitForPidExit(childPid);
      expect(() => {
        opened.acquireSetupOperation('contender');
      }).toThrowError(/setup browser is busy/);
      command.kill('SIGKILL');
      await waitForPidExit(commandPid);
      opened.acquireSetupOperation('contender');
      opened.releaseSetupOperation('contender');
    } finally {
      contender?.close();
      child.kill('SIGKILL');
      command.kill('SIGKILL');
      await Promise.all([
        childPid === undefined ? Promise.resolve() : waitForPidExit(childPid),
        commandPid === undefined ? Promise.resolve() : waitForPidExit(commandPid),
      ]);
    }
  });

  it('rejects a second process while one task browser lease is live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-operation-concurrency-'));
    const databasePath = join(root, 'state.sqlite');
    const readyPath = join(root, 'ready');
    const store = new StateStore(databasePath);
    seedActiveTask(store, 'task-a', 'session-a');
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
    seedActiveTask(store, 'task-a', 'session-a');
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
    seedActiveTask(store, 'task-a', 'session-a');
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

  it('preserves an effect-unknown send submit across a real subprocess crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-submit-crash-'));
    const databasePath = join(root, 'state.sqlite');
    const readyPath = join(root, 'ready');
    const taskId = 'submitted-before-crash';
    const turnId = 'crashed-turn';
    const workerPath = join(import.meta.dirname, 'support', 'submit-crash-worker.ts');
    const worker = spawn(process.execPath, [workerPath, databasePath, taskId, turnId, readyPath], {
      stdio: 'ignore',
    });
    const workerCompletion = waitForExit(worker);
    await waitForPath(readyPath);

    worker.kill('SIGKILL');
    await workerCompletion;
    const reopened = new StateStore(databasePath);
    expect(reopened.requireTurn(taskId, turnId)).toMatchObject({ status: 'sending' });
    expect(reopened.getUncommittedTaskOperation(taskId)).toMatchObject({
      kind: 'send',
      step: 'submit',
      phase: 'effect-unknown',
    });
    reopened.markSubmissionUnknownAndNeedsDecision(
      taskId,
      turnId,
      'send-op',
      'auto-verification unresolved after crash',
    );
    expect(reopened.requireTurn(taskId, turnId)).toMatchObject({ status: 'unknown-submission' });
    reopened.close();
  });
});

class InterleavedStatusStore extends StateStore {
  readonly #beforeTurns: () => void;

  /**
   * Opens a reader that commits a competing transaction between status queries.
   *
   * @param databasePath Shared SQLite database path.
   * @param beforeTurns Competing writer invoked before the turn query.
   * @throws {Error} If SQLite cannot open the reader.
   */
  constructor(databasePath: string, beforeTurns: () => void) {
    super(databasePath);
    this.#beforeTurns = beforeTurns;
  }

  /**
   * Commits the competing state transition before continuing the status read.
   *
   * @param taskId Task whose turns are listed.
   * @returns Turns visible to the reader snapshot.
   * @throws {Error} If the competing write or turn query fails.
   */
  override listTurns(taskId: string): ReturnType<StateStore['listTurns']> {
    this.#beforeTurns();
    return super.listTurns(taskId);
  }
}

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
