import { StateStore } from '../../skills/chatgpt-pro-collab/scripts/state.ts';

const [databasePath, childPidText, commandPidText] = process.argv.slice(2);
if (databasePath === undefined || childPidText === undefined || commandPidText === undefined) {
  throw new Error('usage: orphan-setup-worker <databasePath> <childPid> <commandPid>');
}
const childPid = Number(childPidText);
const commandPid = Number(commandPidText);
if (!Number.isSafeInteger(childPid) || !Number.isSafeInteger(commandPid)) {
  throw new Error('orphan setup worker requires valid child and command PIDs');
}

const store = new StateStore(databasePath);
store.acquireSetupOperation('orphan-setup-owner');
store.attachSetupOperationChild('orphan-setup-owner', childPid);
store.attachSetupOperationCommand('orphan-setup-owner', commandPid);
store.close();
