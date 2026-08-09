import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { StateStore } from '../../skills/chatgpt-pro-collab/scripts/state.ts';
import { seedActiveTask } from './state.ts';

const [databasePath, taskId, turnId] = process.argv.slice(2);
if (databasePath === undefined || taskId === undefined || turnId === undefined) {
  throw new Error('usage: state-worker <databasePath> <taskId> <turnId>');
}

const suffix = taskId.at(-1);
const store = new StateStore(databasePath);
seedActiveTask(store, taskId, `session-${suffix}`);
store.beginSendTurn(taskId, turnId, `/prompt-${suffix}.md`, [`/attachment-${suffix}`], `send-operation-${suffix}`);
store.advanceSendToSubmitEffectUnknown(`send-operation-${suffix}`);
store.commitSubmittedTurn(
  taskId,
  turnId,
  `conversation-${suffix}`,
  `https://chatgpt.com/c/conversation-${suffix}`,
  `user-turn-${suffix}`,
  `send-operation-${suffix}`,
);
const responsePath = join(dirname(databasePath), `${taskId}-${turnId}.md`);
store.freezeCapture(taskId, turnId, responsePath, []);
writeFileSync(responsePath, `response-${suffix}`, { flag: 'wx' });
store.completeTurn(taskId, turnId, responsePath);
store.closeTask(taskId);
store.close();
