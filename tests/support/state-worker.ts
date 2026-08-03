import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { StateStore } from '../../skills/chatgpt-pro-collab/scripts/state.ts';

const [databasePath, taskId, turnId] = process.argv.slice(2);
if (databasePath === undefined || taskId === undefined || turnId === undefined) {
  throw new Error('usage: state-worker <databasePath> <taskId> <turnId>');
}

const suffix = taskId.at(-1);
const store = new StateStore(databasePath, 'require-existing');
store.createTask(taskId, `session-${suffix}`);
store.beginTurn(taskId, turnId, `/prompt-${suffix}.md`, [`/attachment-${suffix}`]);
store.markSubmissionAttempting(taskId, turnId);
store.markTurnPending(taskId, turnId, `conversation-${suffix}`, `https://chatgpt.com/c/conversation-${suffix}`);
const responsePath = join(dirname(databasePath), `${taskId}-${turnId}.md`);
writeFileSync(responsePath, `response-${suffix}`, { flag: 'wx' });
store.completeTurn(taskId, turnId, responsePath);
store.closeTask(taskId);
store.close();
