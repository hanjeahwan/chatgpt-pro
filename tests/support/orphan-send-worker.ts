import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';

import { StateStore } from '../../skills/chatgpt-pro-collab/scripts/state.ts';

const [databasePath, readyPath, gatePath] = process.argv.slice(2);
if (databasePath === undefined || readyPath === undefined || gatePath === undefined) {
  throw new Error('usage: orphan-send-worker <databasePath> <readyPath> <gatePath>');
}

const store = new StateStore(databasePath);
store.acquireTaskOperation('task-a', 'send', 'orphan-send-owner');
store.beginTurn('task-a', 'turn-a', '/prompt.md', []);
store.markSubmissionAttempting('task-a', 'turn-a');

const gate = spawn(process.execPath, [gatePath, process.execPath, '-e', 'setTimeout(() => {}, 1500)'], {
  stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
});
if (gate.pid === undefined || gate.stdin === null) {
  throw new Error('orphan send gate did not expose its process and release pipe');
}
const commandEvents = gate.stdio[3];
if (!(commandEvents instanceof Readable)) {
  throw new Error('orphan send gate did not expose its command event pipe');
}
store.attachTaskOperationChild('task-a', 'orphan-send-owner', gate.pid);
commandEvents.once('data', () => {
  writeFileSync(readyPath, String(gate.pid), { flag: 'wx' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
});
gate.stdin.end('go\n');
