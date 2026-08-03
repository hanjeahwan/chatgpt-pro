import { writeFileSync } from 'node:fs';

import { StateStore } from '../../skills/chatgpt-pro-collab/scripts/state.ts';

const [databasePath, readyPath] = process.argv.slice(2);
if (databasePath === undefined || readyPath === undefined) {
  throw new Error('usage: operation-lease-worker <databasePath> <readyPath>');
}

const store = new StateStore(databasePath);
store.acquireTaskOperation('task-a', 'wait', 'worker-owner');
writeFileSync(readyPath, String(process.pid), { flag: 'wx' });
await new Promise<void>((resolve) => {
  setTimeout(resolve, 500);
});
store.releaseTaskOperation('task-a', 'worker-owner');
store.close();
