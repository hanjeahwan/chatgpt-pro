import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, writeFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';

const [executable, ...arguments_] = process.argv.slice(2);
if (executable === undefined) {
  throw new Error('browser command gate requires an executable');
}

let command: ChildProcess | undefined;
let commandSettled = false;
let commandPidNotificationFailed = false;
let gateBuffer = '';

process.stdout.on('error', ignoreOutputError);
process.stderr.on('error', ignoreOutputError);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  gateBuffer += chunk;
  if (gateBuffer === 'go\n') {
    process.stdin.pause();
    launchCommand();
    return;
  }
  if (!'go\n'.startsWith(gateBuffer)) {
    writeDiagnostic('browser command gate received an invalid release token\n');
    process.exit(64);
  }
});
process.stdin.on('end', () => {
  if (command === undefined && process.exitCode === undefined) {
    writeDiagnostic('browser command gate closed before release\n');
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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxyCommandOutput(command.stdout, process.stdout);
  proxyCommandOutput(command.stderr, process.stderr);
  if (command.pid !== undefined) {
    const notificationError = notifyCommandPid(command.pid);
    if (notificationError !== undefined) {
      commandPidNotificationFailed = true;
      writeDiagnostic(`guarded command PID notification failed: ${errorMessage(notificationError)}\n`);
    }
  }
  command.on('error', (error) => {
    if (commandSettled) {
      return;
    }
    commandSettled = true;
    writeDiagnostic(`guarded command failed to start: ${error.message}\n`);
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
    writeDiagnostic(`guarded command exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`}\n`);
    process.exitCode = code ?? 1;
  });
}

/**
 * Reports the guarded command PID and closes its one-shot notification descriptor.
 *
 * @param pid Guarded command process identifier.
 * @returns The first write or close failure, or `undefined` after a complete notification.
 * @throws {Error} This helper converts synchronous descriptor failures to its return value.
 */
function notifyCommandPid(pid: number): unknown | undefined {
  let notificationError: unknown;
  try {
    writeFileSync(3, `${pid}\n`);
  } catch (error) {
    notificationError = error;
  }

  const closeError = closeCommandPidNotification();
  return notificationError ?? closeError;
}

/**
 * Closes the command PID notification descriptor exactly once.
 *
 * @returns The close failure, or `undefined` when the descriptor closes normally.
 * @throws {Error} This helper converts synchronous descriptor failures to its return value.
 */
function closeCommandPidNotification(): unknown | undefined {
  try {
    closeSync(3);
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Proxies guarded output while the parent is present, then drains it after the parent pipe breaks.
 *
 * @param source Guarded command output stream.
 * @param destination Gate output stream connected to the invoking parent.
 * @returns Nothing after output forwarding is configured.
 * @throws {Error} This helper does not throw for destination stream failures.
 */
function proxyCommandOutput(source: Readable | null, destination: Writable): void {
  if (source === null) {
    return;
  }
  if (destination.destroyed) {
    source.resume();
    return;
  }

  source.pipe(destination, { end: false });
  destination.once('error', () => {
    source.unpipe(destination);
    source.resume();
  });
}

/**
 * Writes a best-effort diagnostic without making telemetry part of command lifetime.
 *
 * @param message Diagnostic text for a live invoking parent.
 * @returns Nothing after the write is attempted or skipped.
 * @throws {Error} Broken or already-closed output pipes are ignored.
 */
function writeDiagnostic(message: string): void {
  if (process.stderr.destroyed) {
    return;
  }
  try {
    process.stderr.write(message);
  } catch {
    // A disappearing parent must not terminate the persisted command gate.
  }
}

/**
 * Keeps a broken parent output pipe from becoming an uncaught process error.
 *
 * @returns Nothing; command output is drained by `proxyCommandOutput`.
 * @throws {Error} This handler never throws.
 */
function ignoreOutputError(): void {}

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
