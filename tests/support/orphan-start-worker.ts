import { writeFileSync } from 'node:fs';

import { StateStore } from '../../skills/chatgpt-pro-collab/scripts/state.ts';

const [databasePath, readyPath, childPidText, commandPidText] = process.argv.slice(2);
if (
  databasePath === undefined ||
  readyPath === undefined ||
  childPidText === undefined ||
  commandPidText === undefined
) {
  throw new Error('usage: orphan-start-worker <databasePath> <readyPath> <childPid> <commandPid>');
}
const childPid = Number(childPidText);
const commandPid = Number(commandPidText);
if (!Number.isSafeInteger(childPid) || !Number.isSafeInteger(commandPid)) {
  throw new Error('orphan start worker requires valid child and command PIDs');
}

const store = new StateStore(databasePath);
store.acquireTaskOperation('task-a', 'start', 'orphan-start-owner');
store.attachTaskOperationChild('task-a', 'orphan-start-owner', childPid);
store.attachTaskOperationCommand('task-a', 'orphan-start-owner', commandPid);
writeFileSync(readyPath, JSON.stringify({ childPid, commandPid }), { flag: 'wx' });
store.close();
