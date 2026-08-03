import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, writeFileSync } from 'node:fs';

const [executable, ...arguments_] = process.argv.slice(2);
if (executable === undefined) {
  throw new Error('browser command gate requires an executable');
}

let command: ChildProcess | undefined;
let commandSettled = false;
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
    writeFileSync(3, `${command.pid}\n`);
    closeSync(3);
  }
  command.on('error', (error) => {
    if (commandSettled) {
      return;
    }
    commandSettled = true;
    process.stderr.write(`guarded command failed to start: ${error.message}\n`);
    process.exitCode = 127;
  });
  command.on('close', (code, signal) => {
    if (commandSettled) {
      return;
    }
    commandSettled = true;
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
