import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runBrowserCommand } from '../skills/chatgpt-pro-collab/scripts/browser.ts';

describe('browser command side-effect gate', () => {
  it('does not launch the guarded command until the parent releases it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-command-gate-'));
    const markerPath = join(root, 'launched');
    const gatePath = join(
      import.meta.dirname,
      '..',
      'skills',
      'chatgpt-pro-collab',
      'scripts',
      'browser-command-gate.ts',
    );
    const gate = spawn(
      process.execPath,
      [gatePath, process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'yes')`],
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
    );
    const completion = waitForExit(gate);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });

    gate.stdin.end('go\n');
    await expect(completion).resolves.toBe(0);
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('yes');
  });

  it('reports when the released command definitely did not spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-command-not-spawned-'));
    let released = false;
    let commandNotSpawned = false;

    await expect(
      runBrowserCommand({
        executable: join(root, 'missing-command'),
        arguments: [],
        cwd: root,
        environment: process.env,
        beforeCommandRelease() {
          released = true;
        },
        onCommandNotSpawned() {
          commandNotSpawned = true;
        },
      }),
    ).rejects.toThrow(/code 127/);

    expect(released).toBe(true);
    expect(commandNotSpawned).toBe(true);
  });

  it('cannot create a browser side effect when the parent dies before child attachment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-pre-attach-death-'));
    const readyPath = join(root, 'ready');
    const markerPath = join(root, 'must-not-exist');
    const workerPath = join(import.meta.dirname, 'support', 'pre-attach-browser-worker.ts');
    const worker = spawn(process.execPath, [workerPath, readyPath, markerPath], { stdio: 'ignore' });
    const workerCompletion = waitForExit(worker);
    await waitForPath(readyPath);
    const gatePid = Number(await readFile(readyPath, 'utf8'));

    worker.kill('SIGKILL');
    await workerCompletion;
    await waitForPidExit(gatePid);

    await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stays alive with the guarded command when its parent output readers disappear', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-command-notification-'));
    const markerPath = join(root, 'command-started');
    const gatePath = join(
      import.meta.dirname,
      '..',
      'skills',
      'chatgpt-pro-collab',
      'scripts',
      'browser-command-gate.ts',
    );
    const commandSource = [
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started');`,
      "setTimeout(() => { process.stdout.write('late stdout'); process.stderr.write('late stderr'); }, 100);",
      'setTimeout(() => {}, 750);',
    ].join('');
    const gate = spawn(process.execPath, [gatePath, process.execPath, '-e', commandSource], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const completion = waitForExit(gate);
    const commandEvents = gate.stdio[3];
    if (commandEvents === null || commandEvents === undefined) {
      throw new Error('gate command notification pipe was not created');
    }
    gate.stdout.destroy();
    gate.stderr.destroy();
    commandEvents.destroy();
    await Promise.all([waitForClose(gate.stdout), waitForClose(gate.stderr), waitForClose(commandEvents)]);

    gate.stdin.end('go\n');
    await waitForPath(markerPath);
    expect(() => {
      if (gate.pid === undefined) {
        throw new Error('gate PID was not assigned');
      }
      process.kill(gate.pid, 0);
    }).not.toThrow();

    await expect(completion).resolves.toBe(70);
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('started');
  });

  it('guards the real command until exit when its parent dies after release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-post-release-death-'));
    const readyPath = join(root, 'ready');
    const markerPath = join(root, 'command-started');
    const completedPath = join(root, 'command-completed');
    const gatePath = join(
      import.meta.dirname,
      '..',
      'skills',
      'chatgpt-pro-collab',
      'scripts',
      'browser-command-gate.ts',
    );
    const workerPath = join(import.meta.dirname, 'support', 'post-release-browser-worker.ts');
    const worker = spawn(process.execPath, [workerPath, gatePath, readyPath, markerPath, completedPath], {
      stdio: 'ignore',
    });

    await expect(waitForExit(worker)).resolves.toBe(0);
    const gatePid = Number(await readFile(readyPath, 'utf8'));
    await waitForPath(markerPath);
    expect(() => {
      process.kill(gatePid, 0);
    }).not.toThrow();

    await waitForPidExit(gatePid);
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('started');
    await expect(readFile(completedPath, 'utf8')).resolves.toBe('completed');
  });
});

/**
 * Waits until one explicitly destroyed stream closes.
 *
 * @param stream Destroyed child-process output stream.
 * @returns Nothing after the close event, or immediately if already closed.
 * @throws {Error} This helper does not reject.
 */
function waitForClose(stream: {
  readonly closed: boolean;
  once(event: 'close', listener: () => void): unknown;
}): Promise<void> {
  if (stream.closed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    stream.once('close', resolve);
  });
}

/**
 * Resolves one spawned test process to its numeric exit code.
 *
 * @param child Spawned gate or worker process.
 * @returns Exit code, using 1 when a signal ended the process.
 * @throws {Error} If the operating system cannot start the child.
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
 * Waits for a worker to publish the gate PID from inside its blocked attachment callback.
 *
 * @param path Ready-file path.
 * @returns Nothing after the file exists.
 * @throws {Error} If readiness is not published within five seconds.
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
 * Waits for an unreleased gate to exit after its parent pipe closes.
 *
 * @param pid Gate process identifier.
 * @returns Nothing after the process is gone.
 * @throws {Error} If the gate remains alive beyond five seconds.
 */
async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`unreleased browser command gate remained alive: ${pid}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
