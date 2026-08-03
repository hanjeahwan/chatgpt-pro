import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface CollabPaths {
  readonly root: string;
  readonly database: string;
  readonly authDirectory: string;
  readonly seedState: string;
  readonly sessionsDirectory: string;
}

export interface PreparedInputs {
  readonly promptPath: string;
  readonly prompt: Buffer;
  readonly promptText: string;
  readonly attachmentPaths: readonly string[];
}

/**
 * Resolves the fixed Collab data layout.
 *
 * @param root Optional root used by deterministic tests; production callers omit it.
 * @returns Absolute paths for the database, auth seed, and task sessions.
 * @throws {TypeError} If `root` is not a valid path value.
 */
export function collabPaths(root = join(homedir(), '.local', 'chatgpt-pro-collab')): CollabPaths {
  const absoluteRoot = resolve(root);
  return {
    root: absoluteRoot,
    database: join(absoluteRoot, 'state.sqlite'),
    authDirectory: join(absoluteRoot, 'auth'),
    seedState: join(absoluteRoot, 'auth', 'seed.json'),
    sessionsDirectory: join(absoluteRoot, 'sessions'),
  };
}

/**
 * Creates only the directories owned by Collab.
 *
 * @param paths Resolved Collab paths.
 * @returns A promise that resolves when the directories are available.
 * @throws {Error} If a path cannot be created.
 */
export async function ensureCollabDirectories(paths: CollabPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.authDirectory, { recursive: true }),
    mkdir(paths.sessionsDirectory, { recursive: true }),
  ]);
}

/**
 * Returns the directory for one task without creating it.
 *
 * @param paths Resolved Collab paths.
 * @param taskId Unique task identifier.
 * @returns The absolute task session directory.
 * @throws {Error} This pure path operation does not throw for validated string inputs.
 */
export function taskDirectory(paths: CollabPaths, taskId: string): string {
  return join(paths.sessionsDirectory, taskId);
}

/**
 * Creates the task-owned Playwright and turn directories.
 *
 * @param paths Resolved Collab paths.
 * @param taskId Unique task identifier.
 * @returns A promise that resolves when both directories exist.
 * @throws {Error} If a directory cannot be created.
 */
export async function ensureTaskDirectories(paths: CollabPaths, taskId: string): Promise<void> {
  await Promise.all([
    mkdir(join(taskDirectory(paths, taskId), 'playwright'), { recursive: true }),
    mkdir(join(taskDirectory(paths, taskId), 'turns'), { recursive: true }),
  ]);
}

/**
 * Reads the prompt and validates only the attachment paths explicitly supplied by the host.
 *
 * @param promptPath Host-selected text input path.
 * @param attachmentPaths Host-selected opaque attachment paths in upload order.
 * @returns Absolute paths plus the prompt bytes and UTF-8 text.
 * @throws {Error} If any selected path is unreadable or is not a regular file.
 */
export async function prepareInputs(promptPath: string, attachmentPaths: readonly string[]): Promise<PreparedInputs> {
  const absolutePromptPath = resolve(promptPath);
  const absoluteAttachmentPaths = attachmentPaths.map((path) => {
    return resolve(path);
  });
  await assertReadableRegularFile(absolutePromptPath, 'prompt');
  for (const attachmentPath of absoluteAttachmentPaths) {
    await assertReadableRegularFile(attachmentPath, 'attachment');
  }

  const prompt = await readFile(absolutePromptPath);
  return {
    promptPath: absolutePromptPath,
    prompt,
    promptText: prompt.toString('utf8'),
    attachmentPaths: absoluteAttachmentPaths,
  };
}

/**
 * Confirms that setup produced a readable authentication seed.
 *
 * @param paths Resolved Collab paths.
 * @returns A promise that resolves with the absolute seed path.
 * @throws {Error} If setup has not produced a readable regular file.
 */
export async function requireSeedState(paths: CollabPaths): Promise<string> {
  await assertReadableRegularFile(paths.seedState, 'authentication seed');
  return paths.seedState;
}

/**
 * Publishes an immutable prompt copy for a new turn.
 *
 * @param paths Resolved Collab paths.
 * @param taskId Owning task identifier.
 * @param turnId Owning turn identifier.
 * @param prompt Exact prompt bytes read before browser submission.
 * @returns The absolute transcript path.
 * @throws {Error} If the target already exists or cannot be written atomically.
 */
export async function savePromptCopy(
  paths: CollabPaths,
  taskId: string,
  turnId: string,
  prompt: Uint8Array,
): Promise<string> {
  const target = join(turnDirectory(paths, taskId, turnId), 'prompt.md');
  await writeNewFileAtomically(target, prompt);
  return target;
}

/**
 * Publishes an immutable captured response for a completed turn.
 *
 * @param paths Resolved Collab paths.
 * @param taskId Owning task identifier.
 * @param turnId Owning turn identifier.
 * @param response Exact text returned by the page-local Copy response interception.
 * @returns The absolute response transcript path.
 * @throws {Error} If the target already exists or cannot be written atomically.
 */
export async function saveResponse(
  paths: CollabPaths,
  taskId: string,
  turnId: string,
  response: string,
): Promise<string> {
  const target = join(turnDirectory(paths, taskId, turnId), 'response.md');
  await writeNewFileAtomically(target, response);
  return target;
}

/**
 * Writes a unique Playwright `run-code` source file inside the task session.
 *
 * @param paths Resolved Collab paths.
 * @param taskId Owning task identifier or a unique setup identifier.
 * @param action Short action label used only for audit-friendly filenames.
 * @param source JavaScript function source accepted by Playwright CLI.
 * @returns The absolute script path.
 * @throws {Error} If the script cannot be published as a new file.
 */
export async function savePlaywrightScript(
  paths: CollabPaths,
  taskId: string,
  action: string,
  source: string,
): Promise<string> {
  await ensureTaskDirectories(paths, taskId);
  const target = join(taskDirectory(paths, taskId), 'playwright', `${action}-${randomUUID()}.js`);
  await writeNewFileAtomically(target, source);
  return target;
}

/**
 * Verifies that an immutable response still exists before an idempotent wait returns it.
 *
 * @param responsePath Database-recorded response path.
 * @returns A promise that resolves with the same absolute path.
 * @throws {Error} If the database and transcript filesystem are inconsistent.
 */
export async function requireResponse(responsePath: string): Promise<string> {
  await assertReadableRegularFile(responsePath, 'completed response');
  return responsePath;
}

/**
 * Resolves the turn directory without creating it.
 *
 * @param paths Resolved Collab paths.
 * @param taskId Owning task identifier.
 * @param turnId Owning turn identifier.
 * @returns The absolute turn transcript directory.
 * @throws {Error} This pure path operation does not throw for validated string inputs.
 */
export function turnDirectory(paths: CollabPaths, taskId: string, turnId: string): string {
  return join(taskDirectory(paths, taskId), 'turns', turnId);
}

/**
 * Checks readability without copying opaque attachment bytes.
 *
 * @param filePath Absolute host-selected file path.
 * @param label Input label used in failures.
 * @returns A promise that resolves when the file is readable.
 * @throws {Error} If the path is unreadable or is not a regular file.
 */
async function assertReadableRegularFile(filePath: string, label: string): Promise<void> {
  await access(filePath, constants.R_OK);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
}

/**
 * Publishes a new file without an overwrite window.
 *
 * A hard link makes the fully flushed temporary inode visible at the final path and fails
 * atomically when that path already exists. This is stricter than a rename, which would
 * overwrite an earlier transcript on POSIX.
 *
 * @param target Absolute target path.
 * @param data Bytes or text to publish.
 * @returns A promise that resolves after the temporary name is removed.
 * @throws {Error} If writing, syncing, publishing, or cleanup fails.
 */
async function writeNewFileAtomically(target: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx');
  try {
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {
      return undefined;
    });
  }
}
