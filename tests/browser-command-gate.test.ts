import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
});

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
