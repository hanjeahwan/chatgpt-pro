import { writeFileSync } from 'node:fs';

import { runBrowserCommand } from '../../skills/chatgpt-pro-collab/scripts/browser.ts';

const [gatePidPath, commandPidPath] = process.argv.slice(2);
if (gatePidPath === undefined || commandPidPath === undefined) {
  throw new Error('usage: setup-parent-death-worker <gatePidPath> <commandPidPath>');
}

await runBrowserCommand({
  executable: process.execPath,
  arguments: [
    '-e',
    `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(commandPidPath)}, String(process.pid)); setInterval(() => {}, 1000)`,
  ],
  cwd: process.cwd(),
  environment: process.env,
  terminateCommandOnParentExit: true,
  onChildSpawned(pid) {
    writeFileSync(gatePidPath, String(pid), { flag: 'wx' });
  },
  onCommandSpawned() {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  },
});
