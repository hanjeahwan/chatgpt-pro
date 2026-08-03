import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, writeFileSync } from 'node:fs';

const [executable, ...arguments_] = process.argv.slice(2);
if (executable === undefined) {
  throw new Error('browser command gate requires an executable');
}

let command: ChildProcess | undefined;
let commandSettled = false;
let commandPidNotificationFailed = false;
let gateBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  gateBuffer += chunk;
  if (gateBuffer === 'go\n') {
    process.stdin.pause();
    launchCommand();
    return;
  }
  if (!'go\n'.startsWith(gateBuffer)) {
    process.stderr.write('browser command gate received an invalid release token\n');
    process.exit(64);
  }
});
process.stdin.on('end', () => {
  if (command === undefined && process.exitCode === undefined) {
    process.stderr.write('browser command gate closed before release\n');
    process.exitCode = 125;
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (command === undefined) {
      process.exit(128);
      return;
    }
    command.kill(signal);
  });
}

/**
 * Starts the guarded command only after the parent persisted this gate's PID.
 *
 * @returns Nothing; process completion follows the guarded command.
 * @throws {Error} This function reports spawn failures through process exit state rather than throwing.
 */
function launchCommand(): void {
  command = spawn(executable, arguments_, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (command.pid !== undefined) {
    try {
      writeFileSync(3, `${command.pid}\n`);
      closeSync(3);
    } catch (error) {
      commandPidNotificationFailed = true;
      process.stderr.write(`guarded command PID notification failed: ${errorMessage(error)}\n`);
      try {
        closeSync(3);
      } catch {
        // The notification descriptor may already be closed by the failed write.
      }
    }
  }
  command.on('error', (error) => {
    if (commandSettled) {
      return;
    }
    commandSettled = true;
    process.stderr.write(`guarded command failed to start: ${error.message}\n`);
    process.exitCode = commandPidNotificationFailed ? 70 : 127;
  });
  command.on('close', (code, signal) => {
    if (commandSettled) {
      return;
    }
    commandSettled = true;
    if (commandPidNotificationFailed) {
      process.exitCode = 70;
      return;
    }
    if (code === 0) {
      process.exitCode = 0;
      return;
    }
    process.stderr.write(
      `guarded command exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`}\n`,
    );
    process.exitCode = code ?? 1;
  });
}

/**
 * Converts an unknown notification failure to a stable diagnostic.
 *
 * @param error Unknown synchronous file-descriptor error.
 * @returns Human-readable failure detail.
 * @throws {Error} This helper does not throw.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
