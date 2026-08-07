import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collabPaths,
  artifactPath,
  artifactTemporaryPath,
  ensureCollabDirectories,
  prepareInputs,
  publishOrVerifyArtifact,
  publishOrVerifyResponse,
  responsePath,
  savePromptCopy,
  seedStateValid,
} from '../skills/chatgpt-pro-collab/scripts/session.ts';

describe('BEH-003 and BEH-007 artifact boundaries', () => {
  it('reads only explicit paths and preserves attachment order without copying bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-session-'));
    const outside = await mkdtemp(join(tmpdir(), 'collab-outside-'));
    const promptPath = join(root, 'prompt.md');
    const attachmentPath = join(outside, 'attachment.txt');
    const symlinkPath = join(root, 'attachment-link.txt');
    const unselectedPath = join(root, 'must-not-be-read.txt');
    await Promise.all([
      writeFile(promptPath, 'exact prompt'),
      writeFile(attachmentPath, 'opaque attachment'),
      writeFile(unselectedPath, 'unselected'),
      symlink(attachmentPath, symlinkPath),
    ]);

    const prepared = await prepareInputs(promptPath, [symlinkPath, attachmentPath]);

    expect(prepared.promptText).toBe('exact prompt');
    expect(prepared.attachmentPaths).toEqual([symlinkPath, attachmentPath]);
    expect(prepared).not.toHaveProperty('attachmentContents');
  });

  it('keeps prompt and response immutable for each turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-transcript-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);

    const promptPath = await savePromptCopy(paths, 'task-a', 'turn-a', Buffer.from('first'));
    const targetResponsePath = responsePath(paths, 'task-a', 'turn-a');
    await publishOrVerifyResponse(targetResponsePath, 'response');

    await expect(savePromptCopy(paths, 'task-a', 'turn-a', Buffer.from('replacement'))).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(publishOrVerifyResponse(targetResponsePath, 'replacement')).rejects.toMatchObject({
      code: 'TRANSCRIPT_INCONSISTENT',
    });
    expect(await readFile(promptPath, 'utf8')).toBe('first');
    expect(await readFile(targetResponsePath, 'utf8')).toBe('response');
  });

  it('rejects invalid UTF-8 instead of changing the submitted prompt bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-invalid-utf8-'));
    const promptPath = join(root, 'prompt.md');
    await writeFile(promptPath, Buffer.from([0x66, 0x80, 0x6f]));

    await expect(prepareInputs(promptPath, [])).rejects.toThrow(/encoded data/i);
  });

  it('reuses identical interrupted capture files and rejects changed bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-capture-files-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    const targetResponsePath = responsePath(paths, 'task-a', 'turn-a');

    await publishOrVerifyResponse(targetResponsePath, 'response');
    await expect(publishOrVerifyResponse(targetResponsePath, 'response')).resolves.toBe(targetResponsePath);
    await expect(publishOrVerifyResponse(targetResponsePath, 'changed')).rejects.toMatchObject({
      code: 'TRANSCRIPT_INCONSISTENT',
    });

    const firstTemporary = await artifactTemporaryPath(paths, 'task-a', 'turn-a', 1);
    const targetArtifactPath = artifactPath(paths, 'task-a', 'turn-a', 1, '../same-name.txt');
    await writeFile(firstTemporary, 'artifact');
    await publishOrVerifyArtifact(firstTemporary, targetArtifactPath);
    const secondTemporary = await artifactTemporaryPath(paths, 'task-a', 'turn-a', 1);
    await writeFile(secondTemporary, 'artifact');
    await expect(publishOrVerifyArtifact(secondTemporary, targetArtifactPath)).resolves.toBe(targetArtifactPath);
    const changedTemporary = await artifactTemporaryPath(paths, 'task-a', 'turn-a', 1);
    await writeFile(changedTemporary, 'changed');
    await expect(publishOrVerifyArtifact(changedTemporary, targetArtifactPath)).rejects.toMatchObject({
      code: 'ARTIFACT_INCONSISTENT',
    });
    expect(await readFile(targetArtifactPath, 'utf8')).toBe('artifact');
  });
});

describe('BEH-001 seed authentication validation', () => {
  it('accepts a loadable ChatGPT storage state seed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-seed-valid-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    await writeFile(
      paths.seedState,
      JSON.stringify({
        cookies: [{ name: 'session', domain: '.chatgpt.com', path: '/', value: 'test' }],
        origins: [{ origin: 'https://chatgpt.com', localStorage: [{ name: 'oai-did', value: 'test' }] }],
      }),
    );
    await expect(seedStateValid(paths)).resolves.toBe(true);
  });

  it('rejects an empty object as an unauthenticated seed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-seed-empty-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    await writeFile(paths.seedState, '{}');
    await expect(seedStateValid(paths)).resolves.toBe(false);
  });

  it('rejects a readable regular file that is not JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-seed-plain-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    await writeFile(paths.seedState, 'definitely not a storage state');
    await expect(seedStateValid(paths)).resolves.toBe(false);
  });

  it('rejects a storage state without chatgpt.com evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-seed-other-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    await writeFile(
      paths.seedState,
      JSON.stringify({
        cookies: [{ name: 'session', domain: 'example.com', path: '/', value: 'test' }],
        origins: [],
      }),
    );
    await expect(seedStateValid(paths)).resolves.toBe(false);
  });

  it('returns false when the seed file is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-seed-absent-'));
    await expect(seedStateValid(collabPaths(root))).resolves.toBe(false);
  });
});
