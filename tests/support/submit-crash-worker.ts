import { writeFileSync } from 'node:fs';

import { StateStore } from '../../skills/chatgpt-pro-collab/scripts/state.ts';

const [databasePath, taskId, turnId, readyPath] = process.argv.slice(2);
if (databasePath === undefined || taskId === undefined || turnId === undefined || readyPath === undefined) {
  throw new Error('usage: submit-crash-worker <databasePath> <taskId> <turnId> <readyPath>');
}

const store = new StateStore(databasePath);
store.createTask(taskId, `chatgpt-pro-collab-${taskId}`);
store.beginSendTurn(taskId, turnId, '/prompt.md', [], 'send-op');
store.advanceSendToSubmitEffectUnknown('send-op', {
  observedAt: new Date().toISOString(),
  sessionName: `chatgpt-pro-collab-${taskId}`,
  postcondition: 'submit command released before the crash',
});
writeFileSync(readyPath, 'ready', { flag: 'wx' });
store.close();
