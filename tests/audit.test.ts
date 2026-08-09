import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  artifactPath,
  collabPaths,
  ensureCollabDirectories,
  ensureTaskDirectories,
  responsePath,
  savePromptCopy,
} from '../skills/chatgpt-pro-collab/scripts/session.ts';
import { StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';
import { seedActiveTask } from './support/state.ts';

describe('BEH-007 per-turn audit record', () => {
  it('reconstructs text order, artifact order, and paths after close and process restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-audit-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    const databasePath = paths.database;

    const first = new StateStore(databasePath);
    seedActiveTask(first, 'task-a', 'chatgpt-pro-collab-task-a');
    const promptPath = join(root, 'prompt.md');
    await writeFile(promptPath, 'first prompt');
    await ensureTaskDirectories(paths, 'task-a');
    first.beginSendTurn('task-a', 'turn-a', promptPath, ['/outside/a.txt', '/outside/b.txt'], 'operation-a');
    await savePromptCopy(paths, 'task-a', 'turn-a', Buffer.from('first prompt'));
    first.advanceSendToSubmitEffectUnknown('operation-a');
    first.commitSubmittedTurn(
      'task-a',
      'turn-a',
      'conversation-a',
      'https://chatgpt.com/c/conversation-a',
      'user-turn-1',
      'operation-a',
    );
    const firstResponsePath = responsePath(paths, 'task-a', 'turn-a');
    first.freezeCapture('task-a', 'turn-a', firstResponsePath, [
      { sourceUrl: 'sandbox:/mnt/data/same.txt', label: 'same.txt' },
    ]);
    await writeFile(firstResponsePath, 'first response');
    const firstArtifact = artifactPath(paths, 'task-a', 'turn-a', 1, 'same.txt');
    await mkdir(dirname(firstArtifact), { recursive: true });
    first.setArtifactDestination('task-a', 'turn-a', 1, 'same.txt', firstArtifact);
    await writeFile(firstArtifact, 'first artifact');
    first.completeArtifact('task-a', 'turn-a', 1);
    first.completeTurn('task-a', 'turn-a', firstResponsePath);

    first.beginSendTurn('task-a', 'turn-b', promptPath, ['/outside/b.txt', '/outside/c.txt'], 'operation-b');
    await savePromptCopy(paths, 'task-a', 'turn-b', Buffer.from('second prompt'));
    first.advanceSendToSubmitEffectUnknown('operation-b');
    first.commitSubmittedTurn(
      'task-a',
      'turn-b',
      'conversation-a',
      'https://chatgpt.com/c/conversation-a',
      'user-turn-2',
      'operation-b',
    );
    const secondResponsePath = responsePath(paths, 'task-a', 'turn-b');
    first.freezeCapture('task-a', 'turn-b', secondResponsePath, [
      { sourceUrl: 'sandbox:/mnt/data/same.txt', label: 'same.txt' },
    ]);
    await writeFile(secondResponsePath, 'second response');
    const secondArtifact = artifactPath(paths, 'task-a', 'turn-b', 1, 'same.txt');
    await mkdir(dirname(secondArtifact), { recursive: true });
    first.setArtifactDestination('task-a', 'turn-b', 1, 'same.txt', secondArtifact);
    await writeFile(secondArtifact, 'second artifact');
    first.completeArtifact('task-a', 'turn-b', 1);
    first.completeTurn('task-a', 'turn-b', secondResponsePath);
    first.closeTask('task-a');
    first.close();

    const reopened = new StateStore(databasePath);
    const turns = reopened.listTurns('task-a');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      id: 'turn-a',
      status: 'completed',
      promptPath,
      attachmentPaths: ['/outside/a.txt', '/outside/b.txt'],
      userTurnIdentity: 'user-turn-1',
      responsePath: firstResponsePath,
    });
    expect(turns[1]).toMatchObject({
      id: 'turn-b',
      status: 'completed',
      attachmentPaths: ['/outside/b.txt', '/outside/c.txt'],
      userTurnIdentity: 'user-turn-2',
    });
    expect(reopened.listArtifacts('task-a', 'turn-a')).toMatchObject([
      { ordinal: 1, sourceUrl: 'sandbox:/mnt/data/same.txt', filename: 'same.txt', localPath: firstArtifact },
    ]);
    expect(reopened.listArtifacts('task-a', 'turn-b')[0]?.localPath).toBe(secondArtifact);
    reopened.close();

    expect(await readFile(firstResponsePath, 'utf8')).toBe('first response');
    expect(await readFile(secondResponsePath, 'utf8')).toBe('second response');
    expect(await readFile(firstArtifact, 'utf8')).toBe('first artifact');
    expect(await readFile(secondArtifact, 'utf8')).toBe('second artifact');
    expect(await readFile(join(paths.sessionsDirectory, 'task-a', 'turns', 'turn-a', 'prompt.md'), 'utf8')).toBe(
      'first prompt',
    );
    expect(await readFile(join(paths.sessionsDirectory, 'task-a', 'turns', 'turn-b', 'prompt.md'), 'utf8')).toBe(
      'second prompt',
    );
  });

  it('keeps the saved prompt copy when the host rewrites the original prompt file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-audit-prompt-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    await ensureTaskDirectories(paths, 'task-a');
    const promptPath = join(root, 'prompt.md');
    await writeFile(promptPath, 'original prompt');
    await savePromptCopy(paths, 'task-a', 'turn-a', Buffer.from('original prompt'));

    await writeFile(promptPath, 'rewritten by the host');

    expect(await readFile(join(paths.sessionsDirectory, 'task-a', 'turns', 'turn-a', 'prompt.md'), 'utf8')).toBe(
      'original prompt',
    );
  });

  it('distinguishes automatic recovery evidence from human adjudication evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-audit-resolution-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    const store = new StateStore(paths.database);
    seedActiveTask(store, 'task-a', 'session-a');
    store.createOperation({
      id: 'automatic-op',
      kind: 'start',
      step: 'session',
      taskId: 'task-a',
      turnId: null,
      sessionName: 'session-a',
    });
    store.commitOperation('automatic-op', 'automatic', {
      observedAt: '2026-08-07T00:00:00.000Z',
      sessionName: 'session-a',
      postcondition: 'start session resumed from seed',
    });

    store.beginSendTurn('task-a', 'turn-a', '/prompt.md', [], 'human-op');
    store.advanceSendToSubmitEffectUnknown('human-op');
    store.markSubmissionUnknownAndNeedsDecision('task-a', 'turn-a', 'human-op', 'submission unresolved');
    store.commitOperation('human-op', 'human', {
      observedAt: '2026-08-07T01:00:00.000Z',
      sessionName: 'session-a',
      pageUrl: 'https://chatgpt.com/c/conversation-a',
      postcondition: 'submitted adjudication verified the unique user turn',
      decision: 'submitted',
      canonicalUrl: 'https://chatgpt.com/c/conversation-a',
      pageVerification: 'canonical conversation and unique matching user turn verified',
    });

    const automatic = store.requireOperation('automatic-op');
    const human = store.requireOperation('human-op');
    expect(automatic.resolutionSource).toBe('automatic');
    expect(human.resolutionSource).toBe('human');
    expect(human.evidence).toMatchObject({
      observedAt: '2026-08-07T01:00:00.000Z',
      decision: 'submitted',
      canonicalUrl: 'https://chatgpt.com/c/conversation-a',
      pageVerification: expect.stringContaining('verified'),
    });
    expect(human.evidence?.pageVerification).not.toContain('automatically proven');
    store.close();
  });

  it('records journal rows for every task side effect and keeps them readable after close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-audit-journal-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    const databasePath = paths.database;
    const first = new StateStore(databasePath);
    first.createStartingTask('task-a', 'session-a', 'start-op');
    first.advanceOperationStep('start-op', 'project');
    first.advanceOperationStep('start-op', 'configuration');
    first.commitOperation('start-op', 'automatic', {
      observedAt: '2026-08-07T00:00:00.000Z',
      sessionName: 'session-a',
      projectIdentity: 'g-p-123',
      modelConfirmed: true,
      powerConfirmed: true,
      powerNow: 4,
      powerMin: 0,
      powerMax: 4,
    });
    first.activateTask('task-a');
    first.closeTask('task-a');
    first.close();

    const reopened = new StateStore(databasePath);
    expect(reopened.listOperations('task-a')).toMatchObject([
      {
        id: 'start-op',
        kind: 'start',
        step: 'configuration',
        phase: 'committed',
        evidence: {
          projectIdentity: 'g-p-123',
          modelConfirmed: true,
          powerConfirmed: true,
          powerNow: 4,
          powerMin: 0,
          powerMax: 4,
        },
      },
    ]);
    expect(reopened.requireTask('task-a').status).toBe('closed');
    reopened.close();
  });
});
