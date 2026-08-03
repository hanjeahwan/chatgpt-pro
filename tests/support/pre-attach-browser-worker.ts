import { writeFileSync } from 'node:fs';

import { runBrowserCommand } from '../../skills/chatgpt-pro-collab/scripts/browser.ts';

const [readyPath, sideEffectPath] = process.argv.slice(2);
if (readyPath === undefined || sideEffectPath === undefined) {
  throw new Error('usage: pre-attach-browser-worker <readyPath> <sideEffectPath>');
}

await runBrowserCommand({
  executable: process.execPath,
  arguments: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'launched')`],
  cwd: process.cwd(),
  environment: process.env,
  onChildSpawned(pid) {
    writeFileSync(readyPath, String(pid), { flag: 'wx' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  },
});
