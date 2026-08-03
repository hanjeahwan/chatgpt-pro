import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { StateStore } from '../../skills/chatgpt-pro-collab/scripts/state.ts';

const [databasePath, readyPath] = process.argv.slice(2);
if (databasePath === undefined || readyPath === undefined) {
  throw new Error('usage: orphan-operation-worker <databasePath> <readyPath>');
}

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], {
  detached: true,
  stdio: 'ignore',
});
if (child.pid === undefined) {
  throw new Error('orphan browser-command child did not start');
}
child.unref();

const store = new StateStore(databasePath, 'require-existing');
store.acquireTaskOperation('task-a', 'wait', 'orphan-owner');
store.attachTaskOperationChild('task-a', 'orphan-owner', child.pid);
writeFileSync(readyPath, String(child.pid), { flag: 'wx' });
store.close();
