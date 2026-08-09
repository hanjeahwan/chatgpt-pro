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
    promptText: new TextDecoder('utf-8', { fatal: true }).decode(prompt),
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
 * Reports whether setup produced a currently readable authentication seed.
 *
 * The seed must be a Playwright storage state that can authenticate a ChatGPT
 * session: a JSON object carrying `cookies` and `origins`, with at least one
 * chatgpt.com cookie or a chatgpt.com origin entry. A readable regular file
 * that is not such a storage state is never treated as an authenticated seed.
 *
 * @param paths Resolved Collab paths.
 * @returns `true` only when the seed is a loadable authenticated storage state.
 * @throws {Error} This probe does not throw for ordinary absence or malformed content.
 */
export async function seedStateValid(paths: CollabPaths): Promise<boolean> {
  try {
    await requireSeedState(paths);
    const seed = JSON.parse(await readFile(paths.seedState, 'utf8')) as unknown;
    if (typeof seed !== 'object' || seed === null) {
      return false;
    }
    const state = seed as { readonly cookies?: unknown; readonly origins?: unknown };
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      return false;
    }
    const hasChatGptCookie = state.cookies.some((cookie) => {
      return (
        typeof cookie === 'object' &&
        cookie !== null &&
        typeof (cookie as { readonly domain?: unknown }).domain === 'string' &&
        /(^|\.)chatgpt\.com$/u.test((cookie as { readonly domain: string }).domain)
      );
    });
    const hasChatGptOrigin = state.origins.some((origin) => {
      return (
        typeof origin === 'object' &&
        origin !== null &&
        (origin as { readonly origin?: unknown }).origin === 'https://chatgpt.com' &&
        Array.isArray((origin as { readonly localStorage?: unknown }).localStorage)
      );
    });
    return hasChatGptCookie || hasChatGptOrigin;
  } catch {
    return false;
  }
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
 * Returns the deterministic response path recorded before capture files are published.
 *
 * @param paths Resolved Collab paths.
 * @param taskId Owning task identifier.
 * @param turnId Owning turn identifier.
 * @returns The absolute immutable response path.
 * @throws {Error} This pure path operation does not throw for validated string inputs.
 */
export function responsePath(paths: CollabPaths, taskId: string, turnId: string): string {
  return join(turnDirectory(paths, taskId, turnId), 'response.md');
}

/**
 * Publishes a response once, or verifies byte equality during interrupted capture recovery.
 *
 * @param target Database-recorded response path.
 * @param response Newly copied exact response text.
 * @returns The same absolute response path.
 * @throws {Error} If publication fails or an existing response differs.
 */
export async function publishOrVerifyResponse(target: string, response: string): Promise<string> {
  try {
    await writeNewFileAtomically(target, response);
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    const existing = await readFile(target);
    if (!existing.equals(Buffer.from(response))) {
      throw new SessionError('TRANSCRIPT_INCONSISTENT', `captured response differs from ${target}`);
    }
  }
  return target;
}

/**
 * Resolves an artifact destination under its one-based ordinal directory.
 *
 * @param paths Resolved Collab paths.
 * @param taskId Owning task identifier.
 * @param turnId Owning turn identifier.
 * @param ordinal One-based artifact order.
 * @param suggestedFilename Browser-suggested original filename.
 * @returns The absolute collision-free artifact path.
 * @throws {SessionError} If the ordinal or filename cannot form a safe local path.
 */
export function artifactPath(
  paths: CollabPaths,
  taskId: string,
  turnId: string,
  ordinal: number,
  suggestedFilename: string,
): string {
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
    throw new SessionError('ARTIFACT_PATH_INVALID', `artifact ordinal must be positive: ${ordinal}`);
  }
  const filename = basename(suggestedFilename);
  if (filename === '' || filename === '.' || filename === '..') {
    throw new SessionError('ARTIFACT_PATH_INVALID', `artifact filename is invalid: ${suggestedFilename}`);
  }
  return join(turnDirectory(paths, taskId, turnId), 'artifacts', String(ordinal), filename);
}

/**
 * Creates a unique browser download target beside the eventual artifact file.
 *
 * @param paths Resolved Collab paths.
 * @param taskId Owning task identifier.
 * @param turnId Owning turn identifier.
 * @param ordinal One-based artifact order.
 * @returns A fresh absolute temporary path not yet present on disk.
 * @throws {Error} If the artifact directory cannot be created.
 */
export async function artifactTemporaryPath(
  paths: CollabPaths,
  taskId: string,
  turnId: string,
  ordinal: number,
): Promise<string> {
  const directory = dirname(artifactPath(paths, taskId, turnId, ordinal, 'artifact'));
  await mkdir(directory, { recursive: true });
  return join(directory, `.download-${randomUUID()}.tmp`);
}

/**
 * Publishes downloaded bytes without overwrite, or verifies an interrupted prior publication.
 *
 * @param temporaryPath Complete browser-saved temporary download.
 * @param target Database-recorded final artifact path.
 * @returns The final artifact path.
 * @throws {SessionError} If an existing final artifact has different bytes.
 * @throws {Error} If reading, linking, or cleanup fails.
 */
export async function publishOrVerifyArtifact(temporaryPath: string, target: string): Promise<string> {
  await assertReadableRegularFile(temporaryPath, 'downloaded artifact');
  await mkdir(dirname(target), { recursive: true });
  try {
    await link(temporaryPath, target);
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    const [temporary, existing] = await Promise.all([readFile(temporaryPath), readFile(target)]);
    if (!temporary.equals(existing)) {
      throw new SessionError('ARTIFACT_INCONSISTENT', `downloaded artifact differs from ${target}`);
    }
  } finally {
    await unlink(temporaryPath).catch(() => {
      return undefined;
    });
  }
  return target;
}

/**
 * Removes one task-owned temporary download after a failed capture attempt.
 *
 * @param temporaryPath Exact path returned by `artifactTemporaryPath`.
 * @returns Nothing whether the temporary file exists or is already absent.
 * @throws {Error} If an existing temporary file cannot be removed.
 */
export async function discardArtifactTemporary(temporaryPath: string): Promise<void> {
  await unlink(temporaryPath).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  });
}

/**
 * Verifies a completed artifact remains a readable regular file.
 *
 * @param localPath Database-recorded artifact path.
 * @returns The same absolute path.
 * @throws {SessionError} If persisted state and filesystem differ.
 */
export async function requireArtifact(localPath: string): Promise<string> {
  try {
    await assertReadableRegularFile(localPath, 'completed artifact');
  } catch (error) {
    throw new SessionError('ARTIFACT_INCONSISTENT', `${localPath}: ${errorMessage(error)}`);
  }
  return localPath;
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

export class SessionError extends Error {
  readonly code: string;

  /**
   * Creates a stable transcript or artifact publication error.
   *
   * @param code Machine-readable failure code.
   * @param message Concrete filesystem inconsistency.
   * @throws {Error} This constructor does not throw beyond ordinary allocation failures.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
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
 * A hard link makes the fully written and closed temporary inode visible at the final path
 * and fails atomically when that path already exists. This protects publication from process
 * interruption, but does not promise persistence across power loss.
 *
 * @param target Absolute target path.
 * @param data Bytes or text to publish.
 * @returns A promise that resolves after the temporary name is removed.
 * @throws {Error} If writing, closing, publishing, or cleanup fails.
 */
async function writeNewFileAtomically(target: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx');
  try {
    try {
      await file.writeFile(data);
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

/**
 * Classifies a no-overwrite publication collision.
 *
 * @param error Unknown filesystem failure.
 * @returns True only for an `EEXIST` error.
 * @throws {Error} This classifier does not throw for ordinary values.
 */
function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

/**
 * Extracts a stable message without discarding non-Error failures.
 *
 * @param error Unknown thrown value.
 * @returns Human-readable cause.
 * @throws {Error} This formatter does not throw for ordinary values.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
