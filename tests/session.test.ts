import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collabPaths,
  ensureCollabDirectories,
  prepareInputs,
  savePromptCopy,
  saveResponse,
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
    const responsePath = await saveResponse(paths, 'task-a', 'turn-a', 'response');

    await expect(savePromptCopy(paths, 'task-a', 'turn-a', Buffer.from('replacement'))).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(saveResponse(paths, 'task-a', 'turn-a', 'replacement')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(promptPath, 'utf8')).toBe('first');
    expect(await readFile(responsePath, 'utf8')).toBe('response');
  });
});
