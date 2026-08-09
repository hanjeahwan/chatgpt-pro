import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { StateError, StateStore } from '../../skills/chatgpt-pro-collab/scripts/state.ts';
import { seedActiveTask } from './state.ts';

type Checkpoint = 'capturing-frozen' | 'response-published' | 'artifact-published' | 'partial-artifacts';

const [mode, databasePath, root, ...parameters] = process.argv.slice(2);
if (mode === undefined || databasePath === undefined || root === undefined) {
  throw new Error(
    'usage: capture-recovery-worker <interrupt-freeze|prepare|recover|close> <databasePath> <root> [...]',
  );
}

const taskId = 'task-a';
const turnId = 'turn-a';
const responsePath = join(root, 'response.md');
const sourceUrls = ['sandbox:/mnt/data/first.txt', 'sandbox:/mnt/data/second.txt'];

if (mode === 'interrupt-freeze') {
  const [readyPath] = parameters;
  if (readyPath === undefined) {
    throw new Error('interrupt-freeze requires a ready path');
  }
  const store = new StateStore(databasePath);
  seedActiveTask(store, taskId, 'session-a');
  store.beginSendTurn(taskId, turnId, '/prompt.md', [], 'send-operation');
  store.advanceSendToSubmitEffectUnknown('send-operation');
  store.commitSubmittedTurn(
    taskId,
    turnId,
    'conversation-a',
    'https://chatgpt.com/c/conversation-a',
    'user-turn-a',
    'send-operation',
  );
  const artifacts = sourceUrls.map((sourceUrl) => {
    return { sourceUrl, label: sourceUrl.slice(sourceUrl.lastIndexOf('/') + 1) };
  });
  Object.defineProperty(artifacts, 'entries', {
    value: function* interruptedEntries() {
      const first = artifacts[0];
      if (first === undefined) {
        throw new Error('freeze fixture requires a first artifact');
      }
      yield [0, first] as const;
      writeFileSync(readyPath, String(process.pid), { flag: 'wx' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      const second = artifacts[1];
      if (second !== undefined) {
        yield [1, second] as const;
      }
    },
  });
  store.freezeCapture(taskId, turnId, responsePath, artifacts);
} else if (mode === 'prepare') {
  const [checkpointValue, readyPath] = parameters;
  if (!isCheckpoint(checkpointValue) || readyPath === undefined) {
    throw new Error('prepare requires a checkpoint and ready path');
  }
  const store = new StateStore(databasePath);
  seedActiveTask(store, taskId, 'session-a');
  store.beginSendTurn(taskId, turnId, '/prompt.md', [], 'send-operation');
  store.advanceSendToSubmitEffectUnknown('send-operation');
  store.commitSubmittedTurn(
    taskId,
    turnId,
    'conversation-a',
    'https://chatgpt.com/c/conversation-a',
    'user-turn-a',
    'send-operation',
  );
  store.freezeCapture(
    taskId,
    turnId,
    responsePath,
    sourceUrls.map((sourceUrl) => {
      return { sourceUrl, label: sourceUrl.slice(sourceUrl.lastIndexOf('/') + 1) };
    }),
  );
  store.acquireTaskOperation(taskId, 'wait', 'interrupted-wait');

  if (checkpointValue !== 'capturing-frozen') {
    writeFileSync(responsePath, 'stable response', { flag: 'wx' });
  }
  if (checkpointValue === 'artifact-published' || checkpointValue === 'partial-artifacts') {
    publishArtifact(store, 1);
  }
  if (checkpointValue === 'partial-artifacts') {
    store.completeArtifact(taskId, turnId, 1);
  }
  writeFileSync(readyPath, String(process.pid), { flag: 'wx' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
} else if (mode === 'recover') {
  const [resultPath, readyPath, continuePath] = parameters;
  if (resultPath === undefined) {
    throw new Error('recover requires a result path');
  }
  const store = new StateStore(databasePath);
  store.acquireTaskOperation(taskId, 'wait', 'recovery-wait');
  if (readyPath !== undefined && continuePath !== undefined) {
    writeFileSync(readyPath, String(process.pid), { flag: 'wx' });
    waitForPath(continuePath);
  }
  publishOrVerify(responsePath, 'stable response');
  for (const artifact of store.listArtifacts(taskId, turnId)) {
    const target = artifact.localPath ?? artifactTarget(artifact.ordinal);
    if (artifact.localPath === null) {
      store.setArtifactDestination(taskId, turnId, artifact.ordinal, `artifact-${artifact.ordinal}.txt`, target);
    }
    publishOrVerify(target, `artifact ${artifact.ordinal}`);
    if (artifact.status === 'pending') {
      store.completeArtifact(taskId, turnId, artifact.ordinal);
    }
  }
  store.completeTurn(taskId, turnId, responsePath);
  store.releaseTaskOperation(taskId, 'recovery-wait');
  writeFileSync(
    resultPath,
    JSON.stringify({
      turn: store.requireTurn(taskId, turnId),
      artifacts: store.listArtifacts(taskId, turnId),
    }),
    { flag: 'wx' },
  );
  store.close();
} else if (mode === 'close') {
  const [resultPath, readyPath] = parameters;
  if (resultPath === undefined || readyPath === undefined) {
    throw new Error('close requires result and ready paths');
  }
  const store = new StateStore(databasePath);
  let busyCount = 0;
  while (true) {
    try {
      store.acquireTaskOperation(taskId, 'close', 'concurrent-close');
      break;
    } catch (error) {
      if (!(error instanceof StateError) || error.code !== 'TASK_OPERATION_IN_PROGRESS') {
        throw error;
      }
      busyCount += 1;
      if (busyCount === 1) {
        writeFileSync(readyPath, String(process.pid), { flag: 'wx' });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  store.closeTask(taskId);
  store.releaseTaskOperation(taskId, 'concurrent-close');
  writeFileSync(resultPath, JSON.stringify({ busyCount, task: store.requireTask(taskId) }), { flag: 'wx' });
  store.close();
} else {
  throw new Error(`unknown capture recovery worker mode: ${mode}`);
}

/**
 * Validates one requested interruption checkpoint.
 *
 * @param value Untrusted worker argument.
 * @returns Whether the value names one supported checkpoint.
 * @throws {Error} This pure predicate does not throw.
 */
function isCheckpoint(value: string | undefined): value is Checkpoint {
  return (
    value === 'capturing-frozen' ||
    value === 'response-published' ||
    value === 'artifact-published' ||
    value === 'partial-artifacts'
  );
}

/**
 * Records and publishes one artifact without completing its state row.
 *
 * @param store Process-local database connection owning the fixture state.
 * @param ordinal One-based artifact row and filename ordinal.
 * @returns Nothing after the destination and bytes are visible.
 * @throws {Error} If state or exclusive file publication fails.
 */
function publishArtifact(store: StateStore, ordinal: number): void {
  const target = artifactTarget(ordinal);
  store.setArtifactDestination(taskId, turnId, ordinal, `artifact-${ordinal}.txt`, target);
  writeFileSync(target, `artifact ${ordinal}`, { flag: 'wx' });
}

/**
 * Resolves one deterministic final artifact path.
 *
 * @param ordinal One-based artifact ordinal.
 * @returns Absolute fixture-owned target path.
 * @throws {Error} This pure path construction does not ordinarily throw.
 */
function artifactTarget(ordinal: number): string {
  return join(root, `artifact-${ordinal}.txt`);
}

/**
 * Publishes missing bytes or verifies a previously published file.
 *
 * @param path Absolute fixture-owned response or artifact path.
 * @param expected Exact bytes required by recovery.
 * @returns Nothing after the target is proven consistent.
 * @throws {Error} If publication fails or existing bytes differ.
 */
function publishOrVerify(path: string, expected: string): void {
  try {
    writeFileSync(path, expected, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
      throw error;
    }
    if (readFileSync(path, 'utf8') !== expected) {
      throw new Error(`recovery bytes changed: ${path}`);
    }
  }
}

/**
 * Blocks a child worker until an explicit filesystem gate appears.
 *
 * @param path Absolute gate path written by the parent test process.
 * @returns Nothing once the gate is readable.
 * @throws {Error} If the gate remains absent for five seconds or cannot be read.
 */
function waitForPath(path: string): void {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      readFileSync(path);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
