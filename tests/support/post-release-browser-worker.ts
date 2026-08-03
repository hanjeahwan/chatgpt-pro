import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [gatePath, readyPath, sideEffectPath, completedPath] = process.argv.slice(2);
if (gatePath === undefined || readyPath === undefined || sideEffectPath === undefined || completedPath === undefined) {
  throw new Error('usage: post-release-browser-worker <gatePath> <readyPath> <sideEffectPath> <completedPath>');
}

const commandSource = [
  `require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'started');`,
  "setTimeout(() => { process.stdout.write('late stdout'); process.stderr.write('late stderr'); }, 100);",
  `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(completedPath)}, 'completed'); }, 650);`,
  'setTimeout(() => {}, 750);',
].join('');
const gate = spawn(process.execPath, [gatePath, process.execPath, '-e', commandSource], {
  stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
});
if (gate.pid === undefined || gate.stdin === null) {
  throw new Error('post-release gate did not expose its process and release pipe');
}
writeFileSync(readyPath, String(gate.pid), { flag: 'wx' });
gate.stdin.end('go\n');
process.exit(0);
