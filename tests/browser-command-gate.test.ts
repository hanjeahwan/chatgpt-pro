import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BrowserCommandAbortedError,
  PlaywrightBrowser,
  runBrowserCommand,
} from '../skills/chatgpt-pro-collab/scripts/browser.ts';
import {
  collabPaths,
  ensureCollabDirectories,
  ensureTaskDirectories,
} from '../skills/chatgpt-pro-collab/scripts/session.ts';

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

  it('reports a pre-release signal without launching the guarded command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-command-pre-release-signal-'));
    const markerPath = join(root, 'must-not-exist');
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

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    gate.kill('SIGTERM');

    await expect(waitForExit(gate)).resolves.toBe(128);
    await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('completes a setup command while its parent remains live', async () => {
    await expect(
      runBrowserCommand({
        executable: process.execPath,
        arguments: ['-e', 'process.stdout.write("ready")'],
        cwd: process.cwd(),
        environment: process.env,
        terminateCommandOnParentExit: true,
      }),
    ).resolves.toMatchObject({ stdout: 'ready' });
  });

  it('aborts and reaps both the command gate and a never-ending guarded command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-command-abort-'));
    const controller = new AbortController();
    let gatePid: number | undefined;
    let commandPid: number | undefined;

    await expect(
      runBrowserCommand({
        executable: process.execPath,
        arguments: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        environment: process.env,
        signal: controller.signal,
        onChildSpawned(pid) {
          gatePid = pid;
        },
        onCommandSpawned(pid) {
          commandPid = pid;
          controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(BrowserCommandAbortedError);

    if (gatePid === undefined || commandPid === undefined) {
      throw new Error('abort test did not observe both process identifiers');
    }
    await Promise.all([waitForPidExit(gatePid), waitForPidExit(commandPid)]);
  });

  it('aborts a guarded command process group including its grandchild on POSIX', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'collab-command-group-abort-'));
    const grandchildPidPath = join(root, 'grandchild-pid');
    const grandchildSource = [
      "process.on('SIGTERM', () => {});",
      `require('node:fs').writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const commandSource = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const controller = new AbortController();
    let commandPid: number | undefined;
    let grandchildPid: number | undefined;

    try {
      const completion = runBrowserCommand({
        executable: process.execPath,
        arguments: ['-e', commandSource],
        cwd: root,
        environment: process.env,
        signal: controller.signal,
        onCommandSpawned(pid) {
          commandPid = pid;
        },
      });
      await waitForPath(grandchildPidPath);
      grandchildPid = Number(await readFile(grandchildPidPath, 'utf8'));
      controller.abort();

      await expect(completion).rejects.toBeInstanceOf(BrowserCommandAbortedError);
      if (commandPid === undefined || !Number.isSafeInteger(grandchildPid)) {
        throw new Error('process-group abort test did not observe both process identifiers');
      }
      await Promise.all([waitForPidExit(commandPid), waitForPidExit(grandchildPid)]);
    } finally {
      for (const pid of [commandPid, grandchildPid]) {
        if (pid !== undefined) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The expected path has already terminated the process.
          }
        }
      }
    }
  });

  it('force-aborts a guarded command that ignores SIGTERM when its command observer fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-command-observer-failure-'));
    const readyPath = join(root, 'command-ready');
    let gatePid: number | undefined;
    let commandPid: number | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    try {
      const completion = runBrowserCommand({
        executable: process.execPath,
        arguments: [
          '-e',
          `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(() => {}, 1000)`,
        ],
        cwd: root,
        environment: process.env,
        onChildSpawned(pid) {
          gatePid = pid;
        },
        onCommandSpawned(pid) {
          commandPid = pid;
          const readyDeadline = Date.now() + 2000;
          while (!existsSync(readyPath)) {
            if (Date.now() >= readyDeadline) {
              throw new Error('guarded command did not install its SIGTERM handler');
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          throw new Error('fixture command observer failed');
        },
      });
      const boundedCompletion = Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          deadlineTimer = setTimeout(() => {
            reject(new Error('command observer failure did not settle the guarded command'));
          }, 1000);
        }),
      ]);

      await expect(boundedCompletion).rejects.toThrow('fixture command observer failed');
      if (gatePid === undefined || commandPid === undefined) {
        throw new Error('observer failure test did not observe both process identifiers');
      }
      await Promise.all([waitForPidExit(gatePid), waitForPidExit(commandPid)]);
    } finally {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      for (const pid of [gatePid, commandPid]) {
        if (pid !== undefined) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The expected path has already terminated the process.
          }
        }
      }
    }
  });

  it('threads artifact download cancellation through PlaywrightBrowser and reaps both processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-artifact-command-abort-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    await ensureTaskDirectories(paths, 'task-a');
    const controller = new AbortController();
    let gatePid: number | undefined;
    let commandPid: number | undefined;
    const browser = new PlaywrightBrowser(paths, root, (invocation) => {
      return runBrowserCommand({
        ...invocation,
        executable: process.execPath,
        arguments: ['-e', 'setInterval(() => {}, 1000)'],
        onChildSpawned(pid) {
          gatePid = pid;
          invocation.onChildSpawned?.(pid);
        },
        onChildExited(pid) {
          invocation.onChildExited?.(pid);
        },
        onCommandSpawned(pid) {
          commandPid = pid;
          invocation.onCommandSpawned?.(pid);
          controller.abort();
        },
      });
    });

    await expect(
      browser.downloadArtifact(
        'task-a',
        'session-a',
        'conversation-a',
        'conversation-turn-user-1',
        ['sandbox:/mnt/data/result.txt'],
        'sandbox:/mnt/data/result.txt',
        join(root, 'artifact.tmp'),
        5000,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_COMMAND_FAILED' });

    if (gatePid === undefined || commandPid === undefined) {
      throw new Error('artifact abort test did not observe both process identifiers');
    }
    await Promise.all([waitForPidExit(gatePid), waitForPidExit(commandPid)]);
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

  it('force-stops a setup command when its parent dies before command PID persistence', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'collab-setup-parent-death-'));
    const gatePidPath = join(root, 'gate-pid');
    const commandPidPath = join(root, 'command-pid');
    const workerPath = join(import.meta.dirname, 'support', 'setup-parent-death-worker.ts');
    const worker = spawn(process.execPath, [workerPath, gatePidPath, commandPidPath], { stdio: 'ignore' });
    const workerCompletion = waitForExit(worker);
    await Promise.all([waitForPath(gatePidPath), waitForPath(commandPidPath)]);
    const gatePid = Number(await readFile(gatePidPath, 'utf8'));
    const commandPid = Number(await readFile(commandPidPath, 'utf8'));

    try {
      worker.kill('SIGKILL');
      await workerCompletion;
      await Promise.all([waitForPidExit(gatePid), waitForPidExit(commandPid)]);
    } finally {
      for (const pid of [gatePid, commandPid]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The setup gate is expected to terminate both processes.
        }
      }
    }
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
