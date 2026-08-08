import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { CollabPaths } from './session.ts';
import { ensureTaskDirectories, savePlaywrightScript, taskDirectory } from './session.ts';

const PLAYWRIGHT_CLI_PACKAGE = '@playwright/cli@0.1.17';
const CHATGPT_URL = 'https://chatgpt.com/';
const PROJECTS_URL = 'https://chatgpt.com/projects';
const PROTOCOL = 'chatgpt-pro-collab/v1';
const BROWSER_COMMAND_GATE_PATH = fileURLToPath(new URL('./browser-command-gate.ts', import.meta.url));
const COMMAND_PID_NOTIFICATION_FAILED_EXIT_CODE = 70;
const COMMAND_SPAWN_FAILED_EXIT_CODE = 127;
const COMMAND_STOPPED_BEFORE_SPAWN_EXIT_CODE = 128;
const COMMAND_ABORT_GRACE_MS = 100;

export interface BrowserCommandInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly onChildSpawned?: (pid: number) => void;
  readonly onChildExited?: (pid: number) => void;
  readonly onCommandSpawned?: (pid: number) => void;
  readonly onCommandStarted?: () => void;
  readonly onCommandNotSpawned?: () => void;
  readonly beforeCommandRelease?: () => void;
  readonly signal?: AbortSignal;
}

export interface BrowserCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type BrowserCommandRunner = (invocation: BrowserCommandInvocation) => Promise<BrowserCommandOutput>;

export class BrowserCommandAbortedError extends Error {
  /**
   * Identifies a host-requested command termination without conflating it with a browser failure.
   *
   * @throws {Error} This constructor only performs ordinary error allocation.
   */
  constructor() {
    super('browser command aborted by host deadline');
    this.name = 'BrowserCommandAbortedError';
  }
}

export interface BrowserOperationObserver {
  childSpawned(pid: number): void;
  childExited(pid: number): void;
  commandSpawned(pid: number): void;
}

export interface BrowserSessionInfo {
  readonly pid: number;
  readonly url: string;
  readonly contextMarker: string;
  readonly projectId: string;
  readonly modelConfirmed: boolean;
  readonly powerConfirmed: boolean;
  readonly powerNow: number;
  readonly powerMin: number;
  readonly powerMax: number;
  readonly persistent: false;
}

export type BrowserAvailability = 'available' | 'missing' | 'unknown';

export type BrowserSendResult =
  | {
      readonly status: 'submitted';
      readonly conversationId: string;
      readonly conversationUrl: string;
      readonly userTurnIdentity: string;
    }
  | {
      readonly status: 'not-submitted';
      readonly error: string;
    }
  | {
      readonly status: 'unsafe-not-submitted';
      readonly error: string;
    }
  | {
      readonly status: 'unknown-submission';
      readonly error: string;
    };

export type BrowserObservationResult =
  | { readonly status: 'pending' }
  | {
      readonly status: 'completed';
      readonly conversationId: string;
      readonly conversationUrl: string;
      readonly assistantTurnId: string;
    };

export interface BrowserArtifactDescription {
  readonly sourceUrl: string;
  readonly label: string;
}

export interface BrowserCaptureResult {
  readonly response: string;
  readonly responseHtml: string;
  readonly artifacts: readonly BrowserArtifactDescription[];
  readonly conversationId: string;
  readonly conversationUrl: string;
}

export interface BrowserArtifactDownload {
  readonly sourceUrl: string;
  readonly suggestedFilename: string;
  readonly downloadUrl: string;
}

interface ProtocolResult {
  readonly protocol: typeof PROTOCOL;
  readonly kind: string;
}

interface StartProtocolResult extends ProtocolResult {
  readonly kind: 'start';
  readonly url: string;
  readonly contextMarker: string;
  readonly projectId: string;
  readonly modelConfirmed: boolean;
  readonly powerConfirmed: boolean;
  readonly powerNow: number;
  readonly powerMin: number;
  readonly powerMax: number;
}

interface StartFailedProtocolResult extends ProtocolResult {
  readonly kind: 'start-failed';
  readonly errorCode: string;
  readonly message: string;
}

interface UploadReadyProtocolResult extends ProtocolResult {
  readonly kind: 'upload-ready';
}

interface SendReadyProtocolResult extends ProtocolResult {
  readonly kind: 'send-ready';
}

interface DraftClearedProtocolResult extends ProtocolResult {
  readonly kind: 'draft-cleared';
}

interface SendProtocolResult extends ProtocolResult {
  readonly kind: 'send';
  readonly status: BrowserSendResult['status'];
  readonly conversationId?: string;
  readonly conversationUrl?: string;
  readonly userTurnIdentity?: string;
  readonly error?: string;
}

interface ObservationProtocolResult extends ProtocolResult {
  readonly kind: 'observe';
  readonly status: BrowserObservationResult['status'];
  readonly conversationId?: string;
  readonly conversationUrl?: string;
  readonly assistantTurnId?: string;
}

interface CaptureProtocolResult extends ProtocolResult {
  readonly kind: 'capture';
  readonly response?: string;
  readonly responseHtml?: string;
  readonly artifacts?: unknown;
  readonly conversationId?: string;
  readonly conversationUrl?: string;
}

interface ArtifactDownloadProtocolResult extends ProtocolResult {
  readonly kind: 'artifact-download';
  readonly sourceUrl?: string;
  readonly suggestedFilename?: string;
  readonly downloadUrl?: string;
}

interface ArchiveProtocolResult extends ProtocolResult {
  readonly kind: 'archive';
  readonly conversationId: string;
}

interface RecoverConversationProtocolResult extends ProtocolResult {
  readonly kind: 'recover-conversation';
  readonly conversationId: string;
  readonly conversationUrl: string;
}

interface ResolveSubmittedProtocolResult extends ProtocolResult {
  readonly kind: 'resolve-submitted';
  readonly conversationId: string;
  readonly conversationUrl: string;
  readonly userTurnIdentity: string;
}

interface ResolveNotSubmittedProtocolResult extends ProtocolResult {
  readonly kind: 'resolve-not-submitted';
}

interface ObserveArchiveProtocolResult extends ProtocolResult {
  readonly kind: 'observe-archive';
  readonly status: 'archived' | 'not-archived' | 'unknown';
  readonly error?: string;
}

interface AutoVerifySubmissionProtocolResult extends ProtocolResult {
  readonly kind: 'auto-verify-submission';
  readonly status: 'submitted' | 'unresolved';
  readonly conversationId?: string;
  readonly conversationUrl?: string;
  readonly userTurnIdentity?: string;
  readonly error?: string;
}

interface ResolveFailedTurnProtocolResult extends ProtocolResult {
  readonly kind: 'resolve-failed-turn';
  readonly conversationId?: string;
  readonly conversationUrl?: string;
  readonly userTurnIdentity?: string;
  readonly stop?: 'absent' | 'stopped';
}

export interface BrowserResolveSubmittedResult {
  readonly conversationId: string;
  readonly conversationUrl: string;
  readonly userTurnIdentity: string;
}

export type BrowserAutoVerifyResult =
  | {
      readonly status: 'submitted';
      readonly conversationId: string;
      readonly conversationUrl: string;
      readonly userTurnIdentity: string;
    }
  | { readonly status: 'unresolved'; readonly reason: string };

export type BrowserArchiveState =
  | { readonly status: 'archived' }
  | { readonly status: 'not-archived' }
  | { readonly status: 'unknown'; readonly error: string };

export interface BrowserResolveFailedTurnResult {
  readonly conversationId: string;
  readonly conversationUrl: string;
  readonly userTurnIdentity: string;
  readonly stop: 'absent' | 'stopped';
}

export class BrowserError extends Error {
  readonly code: string;
  readonly operation: string;

  /**
   * Creates a stable browser-boundary error without hiding the failed operation.
   *
   * @param code Machine-readable failure code.
   * @param operation Concrete browser or CLI operation.
   * @param message Human-readable cause.
   * @throws {Error} This constructor does not throw beyond ordinary allocation failures.
   */
  constructor(code: string, operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = 'BrowserError';
    this.code = code;
    this.operation = operation;
  }
}

export class PlaywrightBrowser {
  readonly #paths: CollabPaths;
  readonly #cwd: string;
  readonly #runner: BrowserCommandRunner;
  readonly #artifactControlsRefreshed = new Set<string>();

  /**
   * Creates the fixed-version Playwright CLI boundary.
   *
   * @param paths Resolved Collab data paths.
   * @param cwd Repository-independent process working directory used by `npx`.
   * @param runner Injectable command runner for deterministic tests.
   * @throws {Error} This constructor does not perform I/O.
   */
  constructor(paths: CollabPaths, cwd: string, runner: BrowserCommandRunner = runBrowserCommand) {
    this.#paths = paths;
    this.#cwd = cwd;
    this.#runner = runner;
  }

  /**
   * Runs the one-time interactive login, saves shared storage state, and closes setup.
   *
   * @returns The absolute seed state path after Playwright writes it.
   * @throws {BrowserError} If login, state save, or setup cleanup fails.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async setup(): Promise<string> {
    const setupId = `setup-${randomUUID()}`;
    const sessionName = `chatgpt-pro-collab-${setupId}`;
    await ensureTaskDirectories(this.#paths, setupId);
    let primaryFailure: unknown;

    try {
      await this.setupOpen(sessionName);
      await this.setupSaveSeed(sessionName, this.#paths.seedState);
    } catch (error) {
      primaryFailure = error;
    }

    try {
      await this.setupClose(sessionName);
    } catch (closeError) {
      if (primaryFailure !== undefined) {
        throw new BrowserError(
          'BROWSER_CLEANUP_FAILED',
          'setup',
          `${errorMessage(primaryFailure)}; cleanup also failed: ${errorMessage(closeError)}`,
        );
      }
      throw closeError;
    }

    if (primaryFailure !== undefined) {
      throw primaryFailure;
    }
    return this.#paths.seedState;
  }

  /**
   * Opens the interactive setup session when absent and waits for the human login.
   *
   * @param sessionName Recorded setup session name.
   * @returns Nothing after the authenticated ChatGPT page is observed.
   * @throws {BrowserError} If the login page contract cannot be satisfied.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async setupOpen(sessionName: string): Promise<void> {
    const setupId = sessionName.replace(/^chatgpt-pro-collab-/u, '');
    await ensureTaskDirectories(this.#paths, setupId);
    if ((await this.sessionAvailability(sessionName)) === 'missing') {
      await this.#invoke(
        sessionName,
        setupId,
        ['open', CHATGPT_URL, '--browser=chrome', '--headed'],
        'open setup browser',
      );
    }
    await this.#runCodeWithoutResult(
      sessionName,
      setupId,
      'await-login',
      loginWaitScript(),
      'wait for interactive login',
    );
  }

  /**
   * Saves the shared storage state and re-verifies the readable seed file.
   *
   * @param sessionName Recorded setup session name.
   * @param seedStatePath Absolute authentication seed path.
   * @returns Whether the saved seed is a readable regular file.
   * @throws {BrowserError} If the state-save command fails.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async setupSaveSeed(sessionName: string, seedStatePath: string): Promise<{ readonly seedValidated: boolean }> {
    const setupId = sessionName.replace(/^chatgpt-pro-collab-/u, '');
    await this.#invoke(sessionName, setupId, ['state-save', seedStatePath], 'save authentication state');
    return { seedValidated: await isReadableFile(seedStatePath) };
  }

  /**
   * Loads an existing seed into an isolated verification session and verifies the authenticated page.
   *
   * The structural storage-state check is not enough: the seed must actually load in a fresh,
   * independent browser context and the ChatGPT page must show no login controls. The
   * verification always runs in a distinct named session (`<setupSession>-verify`) so the
   * interactive setup session's own authentication can never mask an invalid seed, and that
   * verification session is always closed after success, unauthenticated, and error paths.
   * A leftover verification session from an interrupted prior run is closed first so a setup
   * retry can cleanly re-verify without touching the interactive setup session. Closing the
   * verification session is mandatory: a close failure fails the whole verification so setup
   * can never commit while a verification session may remain.
   *
   * @param sessionName Recorded setup session name; never opened or closed by this method.
   * @param seedStatePath Absolute authentication seed path.
   * @returns Whether the loaded seed produced an authenticated ChatGPT page.
   * @throws {BrowserError} If the browser cannot be opened or the seed cannot be loaded,
   *   or the verification session cannot be closed (combining the original failure when present).
   */
  async verifyAuthenticatedSeed(
    sessionName: string,
    seedStatePath: string,
  ): Promise<{ readonly authenticated: boolean }> {
    const setupId = sessionName.replace(/^chatgpt-pro-collab-/u, '');
    const verificationSession = `${sessionName}-verify`;
    const verificationId = `${setupId}-verify`;
    await ensureTaskDirectories(this.#paths, verificationId);
    let hardFailure: unknown = null;
    let authenticated = false;
    try {
      if ((await this.sessionAvailability(verificationSession)) !== 'missing') {
        await this.#invoke(verificationSession, verificationId, ['close'], 'close leftover seed verification browser');
      }
      await this.#invoke(
        verificationSession,
        verificationId,
        ['open', 'about:blank', '--browser=chrome', '--headed'],
        'open seed verification browser',
      );
      await this.#invoke(
        verificationSession,
        verificationId,
        ['state-load', seedStatePath],
        'load authentication state',
      );
      await this.#invoke(verificationSession, verificationId, ['goto', CHATGPT_URL], 'open chatgpt.com');
      try {
        await this.#runCodeWithoutResult(
          verificationSession,
          verificationId,
          'verify-seed',
          authenticatedPageScript(),
          'verify seed',
        );
        authenticated = true;
      } catch {
        // The seed did not produce an authenticated page: a normal unauthenticated verdict.
      }
    } catch (error) {
      hardFailure = error;
    }
    try {
      await this.#invoke(verificationSession, verificationId, ['close'], 'close seed verification browser');
    } catch (closeError) {
      throw new BrowserError(
        'BROWSER_CLEANUP_FAILED',
        'verify seed',
        hardFailure === null
          ? `seed verification finished (authenticated: ${authenticated}) but its verification session could not be closed: ${errorMessage(closeError)}`
          : `${errorMessage(hardFailure)}; verification session cleanup also failed: ${errorMessage(closeError)}`,
      );
    }
    if (hardFailure !== null) {
      throw hardFailure instanceof Error ? hardFailure : new Error(String(hardFailure));
    }
    return { authenticated };
  }

  /**
   * Closes the recorded setup session and verifies the session is gone.
   *
   * @param sessionName Recorded setup session name.
   * @returns Whether the session is no longer available.
   * @throws {BrowserError} If the close command itself fails.
   */
  async setupClose(sessionName: string): Promise<{ readonly sessionClosed: boolean }> {
    const setupId = sessionName.replace(/^chatgpt-pro-collab-/u, '');
    await this.#invoke(sessionName, setupId, ['close'], 'close setup browser');
    return { sessionClosed: (await this.sessionAvailability(sessionName)) === 'missing' };
  }

  /**
   * Starts one isolated headed session from the shared read-only authentication seed.
   *
   * The task only succeeds inside the unique existing `chatgpt-pro-collab` Project's
   * blank new-conversation composer after `GPT-5.6 Sol` and `Pro` are selected and read
   * back as `aria-checked=true`. Any missing, non-unique, unconfirmable, or drifting
   * page contract closes the opened session and throws a typed BrowserError.
   *
   * @param taskId Unique task identifier and local session directory name.
   * @param sessionName Unique Playwright named session.
   * @param seedStatePath Readable setup state loaded but never saved by the task.
   * @param rebuild When true, only create the session when the named session is absent.
   * @param observer Task-lease child-process observer.
   * @returns PID reported by Playwright plus observed page and context identity.
   * @throws {BrowserError} If the fixed Project, model, or mode context cannot be confirmed.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async startTask(
    taskId: string,
    sessionName: string,
    seedStatePath: string,
    rebuild: boolean = false,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserSessionInfo> {
    await ensureTaskDirectories(this.#paths, taskId);
    const contextMarker = randomUUID();
    let opened = false;
    let reused = false;
    try {
      let pid = -1;
      if (!rebuild || (await this.sessionAvailability(sessionName)) === 'missing') {
        const openOutput = await this.#invoke(
          sessionName,
          taskId,
          ['open', 'about:blank', '--browser=chrome', '--headed'],
          'open task browser',
          observer,
        );
        opened = true;
        pid = parseOpenPid(openOutput.stdout, sessionName);
        await this.#invoke(sessionName, taskId, ['state-load', seedStatePath], 'load authentication state', observer);
      } else {
        reused = true;
      }
      await this.#invoke(sessionName, taskId, ['goto', PROJECTS_URL], 'open ChatGPT projects', observer);
      const scriptPath = await savePlaywrightScript(
        this.#paths,
        taskId,
        'verify-start',
        startVerificationScript(contextMarker),
      );
      const output = await this.#invoke(
        sessionName,
        taskId,
        ['run-code', '--filename', scriptPath],
        'verify fixed project start context',
        observer,
      );
      const result = parseStartProtocolResult(output.stdout);
      if (result.kind === 'start-failed') {
        throw new BrowserError(result.errorCode, 'start task', result.message);
      }
      if (pid < 0) {
        pid = await this.#runner({
          executable: 'npx',
          arguments: ['-y', PLAYWRIGHT_CLI_PACKAGE, '--raw', 'list'],
          cwd: this.#cwd,
          environment: {
            ...process.env,
            PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: 'true',
            PLAYWRIGHT_MCP_OUTPUT_DIR: join(taskDirectory(this.#paths, taskId), 'playwright'),
          },
        }).then((listed) => {
          return parseSessionPid(listed.stdout, sessionName);
        });
      }
      return {
        pid,
        url: result.url,
        contextMarker: result.contextMarker,
        projectId: result.projectId,
        modelConfirmed: result.modelConfirmed,
        powerConfirmed: result.powerConfirmed,
        powerNow: result.powerNow,
        powerMin: result.powerMin,
        powerMax: result.powerMax,
        persistent: false,
      };
    } catch (error) {
      if (opened || (reused && isDefiniteStartFailure(error))) {
        try {
          await this.#invoke(sessionName, taskId, ['close'], 'close failed task browser', observer);
        } catch (closeError) {
          throw new BrowserError(
            'BROWSER_CLEANUP_FAILED',
            'start task',
            `${errorMessage(error)}; cleanup also failed: ${errorMessage(closeError)}`,
          );
        }
      }
      throw error;
    }
  }

  /**
   * Probes whether the recorded named session currently exists without opening a page.
   *
   * @param sessionName Playwright named session recorded in the task row.
   * @returns `available` for an open session, `missing` for deterministic absence,
   *   and `unknown` when the CLI itself failed or its output cannot be parsed.
   * @throws {Error} This probe converts CLI failures into the unknown classification.
   */
  async sessionAvailability(sessionName: string): Promise<BrowserAvailability> {
    let output: BrowserCommandOutput;
    try {
      output = await this.#runner({
        executable: 'npx',
        arguments: ['-y', PLAYWRIGHT_CLI_PACKAGE, '--raw', 'list'],
        cwd: this.#cwd,
        environment: {
          ...process.env,
          PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: 'true',
          PLAYWRIGHT_MCP_OUTPUT_DIR: join(taskDirectory(this.#paths, 'playwright-probe'), 'playwright'),
        },
      });
    } catch {
      return 'unknown';
    }
    return parseSessionAvailability(output.stdout, sessionName);
  }

  /**
   * Navigates a rebuilt session to the recorded canonical conversation and verifies its identity.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param conversationUrl Recorded canonical conversation URL.
   * @param expectedConversationId Database-bound canonical identity.
   * @param observer Task-lease child-process observer.
   * @returns The re-verified conversation identity and URL.
   * @throws {BrowserError} If the conversation cannot be reached or its identity differs.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async recoverConversation(
    taskId: string,
    sessionName: string,
    conversationUrl: string,
    expectedConversationId: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly conversationId: string; readonly conversationUrl: string }> {
    const result = await this.#runCode<RecoverConversationProtocolResult>(
      sessionName,
      taskId,
      'recover-conversation',
      recoverConversationScript(conversationUrl, expectedConversationId),
      'recover bound conversation',
      'recover-conversation',
      observer,
    );
    return { conversationId: result.conversationId, conversationUrl: result.conversationUrl };
  }

  /**
   * Uploads only the ordered host paths and submits one prompt without waiting for a reply.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param expectedConversationId Existing bound conversation, or null for a first turn.
   * @param prompt Exact UTF-8 prompt copied into the turn transcript.
   * @param attachmentPaths Explicit ordered absolute attachment paths.
   * @param observer Task-lease child-process observer.
   * @param beforeSubmissionRelease Persists ambiguity immediately before the guarded submit command is released.
   * @returns Confirmed conversation identity or a precise submission classification.
   * @throws {Error} Only for local artifact failures before a browser submission can start.
   */
  async send(
    taskId: string,
    sessionName: string,
    expectedConversationId: string | null,
    prompt: string,
    attachmentPaths: readonly string[],
    observer?: BrowserOperationObserver,
    beforeSubmissionRelease?: () => void,
  ): Promise<BrowserSendResult> {
    try {
      await this.#runCode<SendReadyProtocolResult>(
        sessionName,
        taskId,
        'verify-send-target',
        sendTargetVerificationScript(expectedConversationId),
        'verify send conversation',
        'send-ready',
        observer,
      );
    } catch (error) {
      return { status: 'not-submitted', error: errorMessage(error) };
    }

    let attachmentPreparationStarted = false;
    try {
      for (const attachmentPath of attachmentPaths) {
        attachmentPreparationStarted = true;
        await this.#prepareUpload(sessionName, taskId, expectedConversationId, observer);
        const uploadOutput = await this.#invoke(
          sessionName,
          taskId,
          ['upload', attachmentPath],
          `upload attachment ${attachmentPath}`,
          observer,
        );
        const uploadError = parseFixedCliToolError(uploadOutput.stdout);
        if (uploadError !== undefined) {
          throw new Error(uploadError);
        }
        if (uploadOutput.stdout.trim() === '') {
          throw new Error('upload command produced no result; attachment readiness unproven');
        }
      }
    } catch (error) {
      if (attachmentPreparationStarted) {
        try {
          await this.#runCode<DraftClearedProtocolResult>(
            sessionName,
            taskId,
            'clear-upload-draft',
            clearUploadDraftScript(
              expectedConversationId,
              attachmentPaths.map((attachmentPath) => {
                return basename(attachmentPath);
              }),
            ),
            'clear unsubmitted attachment draft',
            'draft-cleared',
            observer,
          );
        } catch (cleanupError) {
          return {
            status: 'unsafe-not-submitted',
            error: `${errorMessage(error)}; attachment cleanup failed: ${errorMessage(cleanupError)}`,
          };
        }
      }
      return { status: 'not-submitted', error: errorMessage(error) };
    }

    let commandReleased = false;
    let commandStarted = false;
    let commandNotSpawned = false;
    try {
      const scriptPath = await savePlaywrightScript(
        this.#paths,
        taskId,
        'send',
        sendScript(expectedConversationId, prompt),
      );
      const output = await this.#invoke(
        sessionName,
        taskId,
        ['run-code', '--filename', scriptPath],
        'submit prompt',
        observer,
        () => {
          beforeSubmissionRelease?.();
          commandReleased = true;
        },
        () => {
          commandStarted = true;
        },
        () => {
          commandNotSpawned = true;
        },
      );
      const result = parseProtocolResult<SendProtocolResult>(output.stdout, 'send');
      if (result.status !== 'submitted') {
        if (result.status === 'not-submitted' && attachmentPreparationStarted) {
          try {
            await this.#runCode<DraftClearedProtocolResult>(
              sessionName,
              taskId,
              'clear-upload-draft',
              clearUploadDraftScript(
                expectedConversationId,
                attachmentPaths.map((attachmentPath) => {
                  return basename(attachmentPath);
                }),
              ),
              'clear unsubmitted attachment draft',
              'draft-cleared',
              observer,
            );
          } catch (cleanupError) {
            return {
              status: 'unsafe-not-submitted',
              error: `${result.error ?? 'prompt was not submitted'}; attachment cleanup failed: ${errorMessage(cleanupError)}`,
            };
          }
        }
        return { status: result.status, error: result.error ?? 'page did not report a cause' };
      }
      if (result.conversationId === undefined || result.conversationUrl === undefined) {
        return { status: 'unknown-submission', error: 'submitted result omitted conversation identity' };
      }
      if (result.userTurnIdentity === undefined) {
        return { status: 'unknown-submission', error: 'submitted result omitted user turn identity' };
      }
      return {
        status: 'submitted',
        conversationId: result.conversationId,
        conversationUrl: result.conversationUrl,
        userTurnIdentity: result.userTurnIdentity,
      };
    } catch (error) {
      const definitelyNotSubmitted = commandNotSpawned || (!commandReleased && !commandStarted);
      if (definitelyNotSubmitted && attachmentPreparationStarted) {
        try {
          await this.#runCode<DraftClearedProtocolResult>(
            sessionName,
            taskId,
            'clear-upload-draft',
            clearUploadDraftScript(
              expectedConversationId,
              attachmentPaths.map((attachmentPath) => {
                return basename(attachmentPath);
              }),
            ),
            'clear unsubmitted attachment draft',
            'draft-cleared',
            observer,
          );
        } catch (cleanupError) {
          return {
            status: 'unsafe-not-submitted',
            error: `${errorMessage(error)}; attachment cleanup failed: ${errorMessage(cleanupError)}`,
          };
        }
      }
      return {
        status: definitelyNotSubmitted ? 'not-submitted' : 'unknown-submission',
        error: errorMessage(error),
      };
    }
  }

  /**
   * Polls once for the completed assistant turn after the exact persisted user turn.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param expectedConversationId Database-bound conversation identity.
   * @param expectedUserTurnId Persisted exact identity of the submitted user turn.
   * @param observationWindowMs Remaining finite observation budget.
   * @param observer Task-lease child-process observer.
   * @returns Pending, or the re-observed completed conversation identity.
   * @throws {BrowserError} If the session exits, the user anchor is absent or not unique,
   *   or the page contract cannot be verified.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async observeResponse(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    expectedUserTurnId: string,
    observationWindowMs: number,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserObservationResult> {
    const result = await this.#runCode<ObservationProtocolResult>(
      sessionName,
      taskId,
      'observe-response',
      observationScript(expectedConversationId, expectedUserTurnId, observationWindowMs),
      'observe response completion',
      'observe',
      observer,
    );
    if (result.status === 'pending') {
      return { status: 'pending' };
    }
    if (
      result.conversationId === undefined ||
      result.conversationUrl === undefined ||
      result.assistantTurnId === undefined
    ) {
      throw new BrowserError(
        'BROWSER_PROTOCOL_ERROR',
        'observe response completion',
        'completed result omitted fields',
      );
    }
    return {
      status: 'completed',
      conversationId: result.conversationId,
      conversationUrl: result.conversationUrl,
      assistantTurnId: result.assistantTurnId,
    };
  }

  /**
   * Copies both text representations from the completed target assistant turn inside the page.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param expectedConversationId Database-bound conversation identity.
   * @param expectedAssistantTurnId Assistant DOM identity returned by completion observation, or null for a capturing retry.
   * @param captureTimeoutMs Remaining finite capture budget.
   * @param signal Host cancellation used to terminate the command at the monotonic deadline.
   * @param observer Task-lease child-process observer.
   * @returns Exact `text/plain`, matching `text/html`, and re-observed conversation identity.
   * @throws {BrowserError} If the response changed, a clipboard type is absent, or selectors drift.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async captureResponse(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    expectedAssistantTurnId: string | null,
    captureTimeoutMs: number,
    signal: AbortSignal,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserCaptureResult> {
    this.#artifactControlsRefreshed.delete(taskId);
    const result = await this.#runCode<CaptureProtocolResult>(
      sessionName,
      taskId,
      'capture-response',
      captureScript(expectedConversationId, expectedAssistantTurnId, captureTimeoutMs),
      'copy completed response',
      'capture',
      observer,
      signal,
    );
    if (
      result.response === undefined ||
      result.responseHtml === undefined ||
      result.artifacts === undefined ||
      result.conversationId === undefined ||
      result.conversationUrl === undefined
    ) {
      throw new BrowserError('BROWSER_PROTOCOL_ERROR', 'copy completed response', 'capture result omitted fields');
    }
    return {
      response: result.response,
      responseHtml: result.responseHtml,
      artifacts: decodeBrowserArtifacts(result.artifacts),
      conversationId: result.conversationId,
      conversationUrl: result.conversationUrl,
    };
  }

  /**
   * Downloads exactly one recorded logical target from the completed assistant turn.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param expectedConversationId Database-bound conversation identity.
   * @param expectedSourceUrls Complete recorded artifact set in response order.
   * @param sourceUrl Exact recorded `sandbox:` logical target.
   * @param temporaryPath Fresh task-owned browser save path.
   * @param captureTimeoutMs Remaining finite capture budget.
   * @param signal Host cancellation used to terminate the command at the monotonic deadline.
   * @param observer Task-lease child-process observer.
   * @returns Download event metadata after bytes are saved at `temporaryPath`.
   * @throws {BrowserError} If the target mapping, event, or browser save fails.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async downloadArtifact(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    expectedSourceUrls: readonly string[],
    sourceUrl: string,
    temporaryPath: string,
    captureTimeoutMs: number,
    signal: AbortSignal,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserArtifactDownload> {
    const refreshControls = !this.#artifactControlsRefreshed.has(taskId);
    const result = await this.#runCode<ArtifactDownloadProtocolResult>(
      sessionName,
      taskId,
      'download-artifact',
      downloadArtifactScript(
        expectedConversationId,
        expectedSourceUrls,
        sourceUrl,
        temporaryPath,
        captureTimeoutMs,
        refreshControls,
      ),
      `download artifact ${sourceUrl}`,
      'artifact-download',
      observer,
      signal,
    );
    if (result.sourceUrl !== sourceUrl || result.suggestedFilename === undefined || result.downloadUrl === undefined) {
      throw new BrowserError('BROWSER_PROTOCOL_ERROR', `download artifact ${sourceUrl}`, 'result omitted fields');
    }
    if (!suggestedFilenameMatchesSource(sourceUrl, result.suggestedFilename)) {
      throw new BrowserError(
        'PLAYWRIGHT_CONTRACT_DRIFT',
        `download artifact ${sourceUrl}`,
        `suggested filename does not match the logical target: ${result.suggestedFilename}`,
      );
    }
    this.#artifactControlsRefreshed.add(taskId);
    return {
      sourceUrl,
      suggestedFilename: result.suggestedFilename,
      downloadUrl: result.downloadUrl,
    };
  }

  /**
   * Closes one named local browser session without deleting its transcript directory.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param observer Task-lease child-process observer.
   * @returns Whether Playwright reported an open session before cleanup.
   * @throws {BrowserError} If Playwright cannot complete the close command.
   */
  async closeTask(
    taskId: string,
    sessionName: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly wasOpen: boolean }> {
    const output = await this.#invoke(sessionName, taskId, ['close'], 'close task browser', observer);
    return { wasOpen: !output.stdout.includes(`Browser '${sessionName}' is not open.`) };
  }

  /**
   * Archives exactly the database-bound Web conversation and leaves the task browser active.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param conversationId Canonical conversation identity to archive.
   * @param conversationUrl Canonical conversation URL recorded at submission, plain or project-scoped.
   * @param observer Task-lease child-process observer.
   * @returns The confirmed archived conversation identity.
   * @throws {BrowserError} If selectors drift, the target differs, or archive cannot be observed.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async archive(
    taskId: string,
    sessionName: string,
    conversationId: string,
    conversationUrl: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly conversationId: string }> {
    const result = await this.#runCode<ArchiveProtocolResult>(
      sessionName,
      taskId,
      'archive',
      archiveScript(conversationUrl, conversationId),
      'archive conversation',
      'archive',
      observer,
    );
    return { conversationId: result.conversationId };
  }

  /**
   * Observes whether the target conversation is currently archived without clicking Archive.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param conversationUrl Recorded canonical conversation URL.
   * @param conversationId Database-bound canonical identity.
   * @param observer Task-lease child-process observer.
   * @returns Archived, provably not archived, or unknown with a real cause.
   * @throws {BrowserError} If the page cannot be observed at all.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async observeArchiveState(
    taskId: string,
    sessionName: string,
    conversationUrl: string,
    conversationId: string,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserArchiveState> {
    const result = await this.#runCode<ObserveArchiveProtocolResult>(
      sessionName,
      taskId,
      'observe-archive',
      observeArchiveScript(conversationUrl, conversationId),
      'observe archive state',
      'observe-archive',
      observer,
    );
    if (result.status === 'archived' || result.status === 'not-archived') {
      return { status: result.status };
    }
    return { status: 'unknown', error: result.error ?? 'archive state could not be verified' };
  }

  /**
   * Cleans or rebuilds the target composer into a safe send-ready state.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param expectedConversationId Bound conversation, or null for a first turn.
   * @param attachmentFileNames Basenames that must disappear from the composer.
   * @param observer Task-lease child-process observer.
   * @returns Nothing after the composer is verified safe.
   * @throws {BrowserError} If the composer cannot be cleaned or the identity drifts.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async cleanSendComposer(
    taskId: string,
    sessionName: string,
    expectedConversationId: string | null,
    attachmentFileNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<void> {
    await this.#runCode<DraftClearedProtocolResult>(
      sessionName,
      taskId,
      'clear-upload-draft',
      clearUploadDraftScript(expectedConversationId, attachmentFileNames),
      'clear unsubmitted attachment draft',
      'draft-cleared',
      observer,
    );
  }

  /**
   * Auto-verifies a released submission from the current page when the result was lost.
   *
   * Only a unique user turn after the recorded anchor matching the saved prompt and
   * ordered attachment names proves the submission; anything else is unresolved.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param expectedConversationId Bound conversation, or null before binding.
   * @param expectedProjectIdentity Project identity recorded by the start operation, or null when unknown.
   * @param previousUserTurnIdentity Anchor of the previous completed turn, or null for a first turn.
   * @param prompt Saved prompt text for verbatim user-turn matching.
   * @param attachmentNames Ordered saved attachment basenames.
   * @param observer Task-lease child-process observer.
   * @returns The proven submission or an unresolved reason.
   * @throws {BrowserError} If the page contract itself cannot be evaluated.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async autoVerifySubmission(
    taskId: string,
    sessionName: string,
    expectedConversationId: string | null,
    expectedProjectIdentity: string | null,
    previousUserTurnIdentity: string | null,
    prompt: string,
    attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<BrowserAutoVerifyResult> {
    const result = await this.#runCode<AutoVerifySubmissionProtocolResult>(
      sessionName,
      taskId,
      'auto-verify-submission',
      autoVerifySubmissionScript(
        expectedConversationId,
        expectedProjectIdentity,
        previousUserTurnIdentity,
        prompt,
        attachmentNames,
      ),
      'auto-verify submission outcome',
      'auto-verify-submission',
      observer,
    );
    if (
      result.status === 'submitted' &&
      result.conversationId !== undefined &&
      result.conversationUrl !== undefined &&
      result.userTurnIdentity !== undefined
    ) {
      return {
        status: 'submitted',
        conversationId: result.conversationId,
        conversationUrl: result.conversationUrl,
        userTurnIdentity: result.userTurnIdentity,
      };
    }
    return { status: 'unresolved', reason: result.error ?? 'no unique matching user turn on the current page' };
  }

  /**
   * Verifies a human `submitted` adjudication against the live canonical conversation.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param canonicalUrl Canonical conversation URL supplied by the user.
   * @param expectedConversationId Database-bound canonical identity, or null before binding.
   * @param expectedProjectIdentity Project identity recorded by the start operation, or null when unknown.
   * @param previousUserTurnIdentity Anchor of the previous completed turn, or null for a first turn.
   * @param prompt Saved prompt text the unique user turn must match verbatim.
   * @param attachmentNames Ordered saved attachment basenames the turn must match.
   * @param observer Task-lease child-process observer.
   * @returns The verified conversation identity and the unique matching user turn identity.
   * @throws {BrowserError} If the conversation, Project, anchor, or unique matching turn cannot be verified.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async resolveSubmittedConversation(
    taskId: string,
    sessionName: string,
    canonicalUrl: string,
    expectedConversationId: string | null,
    expectedProjectIdentity: string | null,
    previousUserTurnIdentity: string | null,
    prompt: string,
    attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<BrowserResolveSubmittedResult> {
    const result = await this.#runCode<ResolveSubmittedProtocolResult>(
      sessionName,
      taskId,
      'resolve-submitted',
      resolveSubmittedScript(
        canonicalUrl,
        expectedConversationId,
        expectedProjectIdentity,
        previousUserTurnIdentity,
        prompt,
        attachmentNames,
      ),
      'verify submitted conversation',
      'resolve-submitted',
      observer,
    );
    return {
      conversationId: result.conversationId,
      conversationUrl: result.conversationUrl,
      userTurnIdentity: result.userTurnIdentity,
    };
  }

  /**
   * Verifies a human `not-submitted` adjudication restored a safe composer.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param expectedConversationId Bound conversation, or null before binding.
   * @param expectedProjectIdentity Project identity recorded by the start operation, or null when unknown.
   * @param previousUserTurnIdentity Anchor of the previous completed turn, or null for a first turn.
   * @param prompt Saved prompt text that must not match any post-anchor user turn.
   * @param attachmentNames Ordered saved attachment basenames.
   * @param observer Task-lease child-process observer.
   * @returns Nothing after the safe composer is verified.
   * @throws {BrowserError} If the page is not the safe bound composer or blank Project composer.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async verifySafeComposer(
    taskId: string,
    sessionName: string,
    expectedConversationId: string | null,
    expectedProjectIdentity: string | null,
    previousUserTurnIdentity: string | null,
    prompt: string,
    attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<void> {
    await this.#runCode<ResolveNotSubmittedProtocolResult>(
      sessionName,
      taskId,
      'resolve-not-submitted',
      resolveNotSubmittedScript(
        expectedConversationId,
        expectedProjectIdentity,
        previousUserTurnIdentity,
        prompt,
        attachmentNames,
      ),
      'verify safe composer',
      'resolve-not-submitted',
      observer,
    );
  }

  /**
   * Verifies the canonical conversation, unique target user turn, absence of later
   * user turns, and safe empty composer, then stops the target response at most once.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param expectedConversationId Database-bound canonical identity.
   * @param expectedUserTurnId Persisted exact identity of the failed-response user turn.
   * @param observer Task-lease child-process observer.
   * @returns The verified conversation, exact user turn, and Stop outcome.
   * @throws {BrowserError} If the conversation, user turn, later-turn, composer, or
   *   Stop postcondition cannot be verified.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async resolveFailedTurn(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    expectedUserTurnId: string,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserResolveFailedTurnResult> {
    const result = await this.#runCode<ResolveFailedTurnProtocolResult>(
      sessionName,
      taskId,
      'resolve-failed-turn',
      resolveFailedTurnScript(expectedConversationId, expectedUserTurnId),
      'verify failed response turn',
      'resolve-failed-turn',
      observer,
    );
    if (
      result.conversationId === undefined ||
      result.conversationUrl === undefined ||
      result.userTurnIdentity === undefined ||
      result.stop === undefined
    ) {
      throw new BrowserError(
        'BROWSER_PROTOCOL_ERROR',
        'verify failed response turn',
        'resolve-failed-turn result omitted fields',
      );
    }
    if (result.conversationId !== expectedConversationId || result.userTurnIdentity !== expectedUserTurnId) {
      throw new BrowserError(
        'BROWSER_PROTOCOL_ERROR',
        'verify failed response turn',
        'resolved identity differs from the target turn',
      );
    }
    return {
      conversationId: result.conversationId,
      conversationUrl: result.conversationUrl,
      userTurnIdentity: result.userTurnIdentity,
      stop: result.stop,
    };
  }

  /**
   * Executes one fixed-prefix Playwright CLI command in the task's output directory.
   *
   * @param sessionName Playwright named session.
   * @param taskId Local task or setup directory identifier.
   * @param command Command and arguments after the fixed CLI prefix.
   * @param operation Concrete operation for failures.
   * @param observer Task-lease child-process observer.
   * @param beforeCommandRelease Called after the gate is durably observed and immediately before command release.
   * @param onCommandStarted Called after a command PID or equivalent conservative start evidence is observed.
   * @param onCommandNotSpawned Called only when the gate proves the guarded command did not spawn.
   * @param signal Host cancellation that safely terminates the gate and guarded command.
   * @returns Captured stdout and stderr.
   * @throws {BrowserError} If `npx` exits unsuccessfully or cannot start.
   */
  async #invoke(
    sessionName: string,
    taskId: string,
    command: readonly string[],
    operation: string,
    observer?: BrowserOperationObserver,
    beforeCommandRelease?: () => void,
    onCommandStarted?: () => void,
    onCommandNotSpawned?: () => void,
    signal?: AbortSignal,
  ): Promise<BrowserCommandOutput> {
    const outputDirectory = join(taskDirectory(this.#paths, taskId), 'playwright');
    try {
      return await this.#runner({
        executable: 'npx',
        arguments: ['-y', PLAYWRIGHT_CLI_PACKAGE, `-s=${sessionName}`, '--raw', ...command],
        cwd: this.#cwd,
        environment: {
          ...process.env,
          PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: 'true',
          PLAYWRIGHT_MCP_OUTPUT_DIR: outputDirectory,
        },
        ...(observer === undefined
          ? {}
          : {
              onChildSpawned: (pid: number) => {
                observer.childSpawned(pid);
              },
              onChildExited: (pid: number) => {
                observer.childExited(pid);
              },
              onCommandSpawned: (pid: number) => {
                observer.commandSpawned(pid);
              },
            }),
        ...(onCommandStarted === undefined
          ? {}
          : {
              onCommandStarted: () => {
                onCommandStarted();
              },
            }),
        ...(onCommandNotSpawned === undefined
          ? {}
          : {
              onCommandNotSpawned: () => {
                onCommandNotSpawned();
              },
            }),
        ...(beforeCommandRelease === undefined
          ? {}
          : {
              beforeCommandRelease: () => {
                beforeCommandRelease();
              },
            }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new BrowserError('BROWSER_COMMAND_FAILED', operation, errorMessage(error));
    }
  }

  /**
   * Publishes and runs one page-local script, then validates its protocol envelope.
   *
   * @param sessionName Playwright named session.
   * @param taskId Local task or setup directory identifier.
   * @param action Audit-friendly script filename label.
   * @param source Page function source.
   * @param operation Concrete operation for failures.
   * @param expectedKind Required result kind.
   * @param observer Task-lease child-process observer.
   * @param signal Host cancellation for this page command.
   * @returns The decoded page result.
   * @throws {BrowserError} If the command or protocol result fails.
   * @throws {Error} If the script file cannot be written.
   */
  async #runCode<T extends ProtocolResult>(
    sessionName: string,
    taskId: string,
    action: string,
    source: string,
    operation: string,
    expectedKind: T['kind'],
    observer?: BrowserOperationObserver,
    signal?: AbortSignal,
  ): Promise<T> {
    const scriptPath = await savePlaywrightScript(this.#paths, taskId, action, source);
    const output = await this.#invoke(
      sessionName,
      taskId,
      ['run-code', '--filename', scriptPath],
      operation,
      observer,
      undefined,
      undefined,
      undefined,
      signal,
    );
    return parseProtocolResult<T>(output.stdout, expectedKind);
  }

  /**
   * Publishes and runs one page-local script whose completion is the only result.
   *
   * @param sessionName Playwright named session.
   * @param taskId Local task or setup directory identifier.
   * @param action Audit-friendly script filename label.
   * @param source Page function source.
   * @param operation Concrete operation for failures.
   * @returns Nothing after the page function completes.
   * @throws {BrowserError} If the command fails.
   * @throws {Error} If the script file cannot be written.
   */
  async #runCodeWithoutResult(
    sessionName: string,
    taskId: string,
    action: string,
    source: string,
    operation: string,
  ): Promise<void> {
    const scriptPath = await savePlaywrightScript(this.#paths, taskId, action, source);
    await this.#invoke(sessionName, taskId, ['run-code', '--filename', scriptPath], operation);
  }

  /**
   * Runs the upload-preparation page function, accepting the pinned CLI's modal-handoff
   * empty result as a provisional state that only the immediately following upload command
   * may prove.
   *
   * The pinned CLI races the page function against modal states: clicking `Add photos & files`
   * can emit a fileChooser modal before the function resolves, making the tool return without
   * its result and leaving `--raw` stdout empty. That empty result is neither success nor
   * failure; the upload command that consumes the chooser is the only proof of readiness.
   * Non-empty output that is not the valid envelope remains a page-contract drift.
   *
   * @param sessionName Playwright named session.
   * @param taskId Local task or setup directory identifier.
   * @param expectedConversationId Existing bound conversation, or null for a first turn.
   * @param observer Task-lease child-process observer.
   * @returns Nothing; readiness is proven only by the following upload command.
   * @throws {BrowserError} If the command or a non-empty non-envelope result fails.
   * @throws {Error} If the script file cannot be written.
   */
  async #prepareUpload(
    sessionName: string,
    taskId: string,
    expectedConversationId: string | null,
    observer?: BrowserOperationObserver,
  ): Promise<void> {
    const scriptPath = await savePlaywrightScript(
      this.#paths,
      taskId,
      'prepare-upload',
      uploadPreparationScript(expectedConversationId),
    );
    const output = await this.#invoke(
      sessionName,
      taskId,
      ['run-code', '--filename', scriptPath],
      'open attachment file chooser',
      observer,
    );
    if (output.stdout.trim() === '') {
      return;
    }
    parseProtocolResult<UploadReadyProtocolResult>(output.stdout, 'upload-ready');
  }
}

/**
 * Runs one command behind a persisted-child gate without shell interpolation or output truncation.
 *
 * @param invocation Fully resolved executable, argument array, directory, and environment.
 * @returns Complete stdout and stderr after a zero exit.
 * @throws {Error} If the process cannot start or exits nonzero.
 */
export function runBrowserCommand(invocation: BrowserCommandInvocation): Promise<BrowserCommandOutput> {
  return new Promise((resolve, reject) => {
    if (invocation.signal?.aborted === true) {
      reject(new BrowserCommandAbortedError());
      return;
    }
    const child = spawn(process.execPath, [BROWSER_COMMAND_GATE_PATH, invocation.executable, ...invocation.arguments], {
      cwd: invocation.cwd,
      env: invocation.environment,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const childPid = child.pid;
    let childObserved = false;
    let settled = false;
    let commandSpawnObserved = false;
    let commandPid: number | undefined;
    let commandObserverError: unknown;
    let commandEventBuffer = '';
    let aborting = false;
    let forcedAbort: NodeJS.Timeout | undefined;
    const commandEvents = child.stdio[3];

    if (!(commandEvents instanceof Readable)) {
      child.kill('SIGTERM');
      reject(new Error('browser command gate did not expose its command event pipe'));
      return;
    }

    const cleanupAbort = (): void => {
      invocation.signal?.removeEventListener('abort', abortCommand);
      if (forcedAbort !== undefined) {
        clearTimeout(forcedAbort);
        forcedAbort = undefined;
      }
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupAbort();
      reject(error);
    };
    const detachObservedChild = (): void => {
      if (!childObserved || childPid === undefined) {
        return;
      }
      childObserved = false;
      invocation.onChildExited?.(childPid);
    };
    const abortCommand = (): void => {
      if (settled || aborting) {
        return;
      }
      aborting = true;
      child.kill('SIGTERM');
      forcedAbort = setTimeout(() => {
        try {
          if (commandPid !== undefined) {
            killIfAlive(commandPid, 'SIGKILL');
          }
        } catch (error) {
          commandObserverError ??= error;
        }
        child.kill('SIGKILL');
      }, COMMAND_ABORT_GRACE_MS);
    };
    invocation.signal?.addEventListener('abort', abortCommand, { once: true });
    if (abortRequested(invocation.signal)) {
      abortCommand();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.stdin.on('error', (error) => {
      commandObserverError ??= error;
    });
    commandEvents.on('data', (chunk: Buffer) => {
      commandEventBuffer += chunk.toString('utf8');
      const lineEnd = commandEventBuffer.indexOf('\n');
      if (lineEnd < 0 || commandSpawnObserved) {
        return;
      }
      const reportedCommandPid = Number(commandEventBuffer.slice(0, lineEnd));
      if (!Number.isSafeInteger(reportedCommandPid) || reportedCommandPid <= 0) {
        commandObserverError = new Error('browser command gate reported an invalid command PID');
        child.kill('SIGTERM');
        return;
      }
      commandPid = reportedCommandPid;
      commandSpawnObserved = true;
      try {
        invocation.onCommandStarted?.();
        invocation.onCommandSpawned?.(reportedCommandPid);
      } catch (error) {
        commandObserverError = error;
        child.kill('SIGTERM');
      }
    });
    child.on('error', (error) => {
      try {
        detachObservedChild();
      } catch (detachError) {
        rejectOnce(detachError);
        return;
      }
      rejectOnce(aborting ? new BrowserCommandAbortedError() : error);
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      try {
        detachObservedChild();
      } catch (error) {
        rejectOnce(error);
        return;
      }
      const output = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === COMMAND_PID_NOTIFICATION_FAILED_EXIT_CODE && !commandSpawnObserved) {
        commandSpawnObserved = true;
        try {
          invocation.onCommandStarted?.();
        } catch (error) {
          commandObserverError = error;
        }
        commandObserverError ??= new Error('browser command gate could not report the command PID');
      }
      if (
        (code === COMMAND_SPAWN_FAILED_EXIT_CODE || code === COMMAND_STOPPED_BEFORE_SPAWN_EXIT_CODE) &&
        !commandSpawnObserved
      ) {
        try {
          invocation.onCommandNotSpawned?.();
        } catch (error) {
          commandObserverError = error;
        }
      }
      if (commandObserverError !== undefined) {
        rejectOnce(commandObserverError);
        return;
      }
      if (aborting) {
        rejectOnce(new BrowserCommandAbortedError());
        return;
      }
      if (code === 0) {
        if (!commandSpawnObserved) {
          rejectOnce(new Error('browser command gate exited without a command PID'));
          return;
        }
        settled = true;
        cleanupAbort();
        resolve(output);
        return;
      }
      rejectOnce(
        new Error(
          `npx exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`}: ${
            output.stderr || output.stdout
          }`,
        ),
      );
    });

    if (childPid !== undefined && invocation.onChildSpawned !== undefined) {
      try {
        invocation.onChildSpawned(childPid);
        childObserved = true;
        invocation.beforeCommandRelease?.();
        child.stdin.end('go\n');
      } catch (error) {
        child.kill('SIGTERM');
        rejectOnce(error);
      }
    } else if (childPid !== undefined) {
      try {
        invocation.beforeCommandRelease?.();
        child.stdin.end('go\n');
      } catch (error) {
        child.kill('SIGTERM');
        rejectOnce(error);
      }
    }
  });
}

/**
 * Sends a best-effort signal to a guarded command during forced deadline cleanup.
 *
 * @param pid Positive process identifier reported by the command gate.
 * @param signal Termination signal selected by the host watchdog.
 * @returns Nothing after the signal succeeds or the process is already absent.
 * @throws {Error} Permission and invalid-signal failures are re-thrown.
 */
function killIfAlive(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
      throw error;
    }
  }
}

/**
 * Reads cancellation state without relying on TypeScript's stale control-flow narrowing.
 *
 * @param signal Optional host cancellation signal.
 * @returns Whether cancellation has been requested at the time of this call.
 * @throws {Error} Reading AbortSignal state does not throw.
 */
function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Extracts the daemon PID that the fixed CLI reports as the opened browser lifecycle process.
 *
 * @param stdout Complete `open` stdout.
 * @param sessionName Expected named session.
 * @returns Positive PID printed by the CLI.
 * @throws {BrowserError} If the fixed-version output contract drifts.
 */
function parseOpenPid(stdout: string, sessionName: string): number {
  const escapedSession = sessionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = ['Browser `', escapedSession, '` opened with pid (\\d+)\\.'].join('');
  const match = new RegExp(pattern).exec(stdout);
  const pid = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new BrowserError('PLAYWRIGHT_CONTRACT_DRIFT', 'parse opened browser', 'PID was not present');
  }
  return pid;
}

/**
 * Parses the fixed CLI global `list` output into a deterministic availability classification.
 *
 * @param stdout Complete `list` stdout.
 * @param sessionName Recorded named session to match exactly.
 * @returns `available` for an open session, `missing` for deterministic absence.
 * @throws {BrowserError} If the output cannot be parsed as a session listing.
 */
function parseSessionAvailability(stdout: string, sessionName: string): BrowserAvailability {
  if (stdout.includes('(no browsers)')) {
    return 'missing';
  }
  const lines = stdout.trim().split(/\r?\n/u);
  const matchIndex = lines.findIndex((line) => {
    return line.includes(sessionName);
  });
  if (matchIndex < 0) {
    return 'missing';
  }
  const block = lines.slice(Math.max(0, matchIndex - 1), matchIndex + 3).join('\n');
  if (/\bopen\b/iu.test(block) && !/\bclosed\b|\bnot open\b/iu.test(block)) {
    return 'available';
  }
  return 'missing';
}

/**
 * Extracts the daemon PID from the fixed CLI `list` output when it is reported.
 *
 * @param stdout Complete `list` stdout.
 * @param sessionName Recorded named session to match exactly.
 * @returns The reported PID, or -1 when the output does not expose one.
 * @throws {BrowserError} If a PID-like value is present but invalid.
 */
function parseSessionPid(stdout: string, sessionName: string): number {
  const lines = stdout.trim().split(/\r?\n/u);
  const matchIndex = lines.findIndex((line) => {
    return line.includes(sessionName);
  });
  if (matchIndex < 0) {
    return -1;
  }
  const block = lines.slice(Math.max(0, matchIndex - 1), matchIndex + 3).join('\n');
  const match = /pid\s*[:=]\s*(\d+)/iu.exec(block);
  if (match === null) {
    return -1;
  }
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new BrowserError('PLAYWRIGHT_CONTRACT_DRIFT', 'parse session list', 'session PID is invalid');
  }
  return pid;
}

/**
 * Finds the page function's quoted JSON string at the end of CLI wrapper output.
 *
 * @param stdout Complete `run-code` stdout.
 * @param expectedKind Expected protocol result kind.
 * @returns The validated protocol result.
 * @throws {BrowserError} If no matching JSON envelope is present.
 */
function parseProtocolResult<T extends ProtocolResult>(stdout: string, expectedKind: T['kind']): T {
  const lines = stdout.trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try {
      const first = JSON.parse(line);
      const candidate = typeof first === 'string' ? JSON.parse(first) : first;
      if (
        typeof candidate === 'object' &&
        candidate !== null &&
        candidate.protocol === PROTOCOL &&
        candidate.kind === expectedKind
      ) {
        return candidate as T;
      }
    } catch {
      // CLI wrapper lines are not JSON; only the page result envelope is relevant.
    }
  }
  throw new BrowserError('PLAYWRIGHT_CONTRACT_DRIFT', `parse ${expectedKind} result`, protocolFailureDetail(stdout));
}

/**
 * Parses the start page envelope, preserving typed failure codes and fixed-target readbacks.
 *
 * @param stdout Complete `run-code` output for the start verification script.
 * @returns The success envelope or the typed failure envelope.
 * @throws {BrowserError} If no start envelope is present or the success envelope omits readbacks.
 */
function parseStartProtocolResult(stdout: string): StartProtocolResult | StartFailedProtocolResult {
  const lines = stdout.trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try {
      const first = JSON.parse(line);
      const candidate = typeof first === 'string' ? JSON.parse(first) : first;
      if (
        typeof candidate === 'object' &&
        candidate !== null &&
        candidate.protocol === PROTOCOL &&
        (candidate.kind === 'start' || candidate.kind === 'start-failed')
      ) {
        if (candidate.kind === 'start') {
          if (
            typeof candidate.projectId !== 'string' ||
            candidate.modelConfirmed !== true ||
            candidate.powerConfirmed !== true ||
            typeof candidate.powerNow !== 'number' ||
            typeof candidate.powerMin !== 'number' ||
            typeof candidate.powerMax !== 'number'
          ) {
            throw new BrowserError(
              'PLAYWRIGHT_CONTRACT_DRIFT',
              'parse start result',
              'start envelope omitted the fixed-target readbacks',
            );
          }
        }
        return candidate as StartProtocolResult | StartFailedProtocolResult;
      }
    } catch (error) {
      if (error instanceof BrowserError) {
        throw error;
      }
    }
  }
  throw new BrowserError('PLAYWRIGHT_CONTRACT_DRIFT', 'parse start result', protocolFailureDetail(stdout));
}

/**
 * Validates the page-discovered ordered unique artifact descriptors.
 *
 * @param value Unknown protocol field returned by the page function.
 * @returns Ordered artifact source URLs and first-occurrence labels.
 * @throws {BrowserError} If the browser protocol field is malformed or duplicated.
 */
function decodeBrowserArtifacts(value: unknown): readonly BrowserArtifactDescription[] {
  if (!Array.isArray(value)) {
    throw new BrowserError('BROWSER_PROTOCOL_ERROR', 'copy completed response', 'artifacts must be an array');
  }
  const artifacts = value.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('sourceUrl' in item) ||
      typeof item.sourceUrl !== 'string' ||
      !item.sourceUrl.startsWith('sandbox:') ||
      !('label' in item) ||
      typeof item.label !== 'string'
    ) {
      throw new BrowserError('BROWSER_PROTOCOL_ERROR', 'copy completed response', 'artifact descriptor is invalid');
    }
    return { sourceUrl: item.sourceUrl, label: item.label };
  });
  const uniqueSources = new Set(
    artifacts.map((artifact) => {
      return artifact.sourceUrl;
    }),
  );
  if (uniqueSources.size !== artifacts.length) {
    throw new BrowserError('BROWSER_PROTOCOL_ERROR', 'copy completed response', 'artifact sources are duplicated');
  }
  return artifacts;
}

/**
 * Accepts the logical basename or the browser's numeric collision suffix before the extension.
 *
 * @param sourceUrl Recorded `sandbox:` logical target.
 * @param suggestedFilename Browser download metadata to bind to that target.
 * @returns Whether the suggested name can belong to the recorded logical target.
 * @throws {URIError} If the browser returned a malformed encoded source basename.
 */
function suggestedFilenameMatchesSource(sourceUrl: string, suggestedFilename: string): boolean {
  const expectedFilename = decodeURIComponent(sourceUrl.slice(sourceUrl.lastIndexOf('/') + 1));
  if (suggestedFilename === expectedFilename) {
    return true;
  }
  const extensionIndex = suggestedFilename.lastIndexOf('.');
  const stem = extensionIndex < 0 ? suggestedFilename : suggestedFilename.slice(0, extensionIndex);
  const extension = extensionIndex < 0 ? '' : suggestedFilename.slice(extensionIndex);
  return `${stem.replace(/\(\d+\)$/u, '')}${extension}` === expectedFilename;
}

/**
 * Detects an explicit fixed-CLI tool error in raw `--raw` stdout.
 *
 * The pinned CLI reports tool failures as plain stdout text while still exiting zero:
 * handler errors arrive as a `### Error` block, and `--raw` strips section headings
 * for errors emitted as sections, leaving a bare `Error:` line. Either form must fail
 * the pre-submit path while preserving the bounded concrete message.
 *
 * @param stdout Complete raw `--raw` stdout.
 * @returns The bounded concrete error text, or undefined when no explicit tool error is present.
 */
function parseFixedCliToolError(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('### Error')) {
    const detail = trimmed.slice('### Error'.length).trim();
    return (detail === '' ? trimmed : detail).slice(0, 2000);
  }
  if (trimmed.startsWith('Error:')) {
    return trimmed.slice(0, 2000);
  }
  return undefined;
}

/**
 * Preserves the fixed CLI's page-script error without returning unrelated snapshots.
 *
 * @param stdout Complete `run-code` output whose envelope was absent.
 * @returns Bounded error detail for the browser boundary.
 * @throws {Error} This pure formatter does not throw.
 */
function protocolFailureDetail(stdout: string): string {
  const marker = stdout.lastIndexOf('### Error');
  if (marker < 0) {
    const trimmed = stdout.trim();
    if (trimmed === '') {
      return 'protocol envelope was not present';
    }
    return `protocol envelope was not present; ${trimmed.slice(0, 2000)}`;
  }
  return `protocol envelope was not present; ${stdout.slice(marker).trim().slice(0, 2000)}`;
}

/**
 * Builds the indefinite setup login gate from directly observable page state.
 *
 * @param observationWindowMs Remaining finite observation budget.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function loginWaitScript(): string {
  return `async (page) => {
    await page.waitForFunction(() => {
      const composer = document.querySelector('#prompt-textarea');
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const authControls = [...document.querySelectorAll('a, button')].filter((element) => {
        const label = (element.textContent || '').trim();
        const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') || '' : '';
        return visible(element) && (label === 'Log in' || label === 'Sign up' || href.includes('/auth/login'));
      });
      return visible(composer) && authControls.length === 0;
    }, undefined, { timeout: 0, polling: 500 });
  }`;
}

/**
 * Builds the authenticated-page postcondition used to prove a loaded seed is currently valid.
 *
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function authenticatedPageScript(): string {
  return `async (page) => {
    await page.waitForFunction(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const onChatGpt = location.hostname === 'chatgpt.com' && /^https?:$/.test(location.protocol);
      const composers = [...document.querySelectorAll('#prompt-textarea')].filter(visible);
      const composerOk = composers.length === 1;
      const authControls = [...document.querySelectorAll('a, button')].filter((element) => {
        const label = (element.textContent || '').trim();
        const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') || '' : '';
        return visible(element) && (label === 'Log in' || label === 'Sign up' || href.includes('/auth/login'));
      });
      return onChatGpt && composerOk && authControls.length === 0;
    }, undefined, { timeout: 60000, polling: 500 });
  }`;
}

/**
 * Builds the fixed Project and model/mode start-context verification.
 *
 * The page function locates the unique `chatgpt-pro-collab` Project row on the projects
 * page, enters its blank new-conversation composer, and confirms `GPT-5.6 Sol` plus `Pro`
 * through `menuitemradio` selection with `aria-checked=true` readback. Every failure
 * returns a typed `start-failed` envelope so the service can distinguish Project absence,
 * non-uniqueness, fixed-target unavailability, unconfirmable selection, and drift.
 *
 * @param contextMarker Host-generated identity unique to this task.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function startVerificationScript(contextMarker: string): string {
  return `async (page) => {
    const contextMarker = ${JSON.stringify(contextMarker)};
    const targetProject = 'chatgpt-pro-collab';
    const targetModel = 'GPT-5.6 Sol';
    const fail = (errorCode, message) => {
      return { protocol: '${PROTOCOL}', kind: 'start-failed', errorCode, message };
    };
    const evaluate = async (callback, argument) => {
      let lastError;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          return await page.evaluate(callback, argument);
        } catch (error) {
          lastError = error;
          await page.waitForTimeout(400);
        }
      }
      throw lastError;
    };

    try {
      await page.waitForFunction(() => {
        const authControls = [...document.querySelectorAll('a, button')].filter((element) => {
          const label = (element.textContent || '').trim();
          const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') || '' : '';
          return (label === 'Log in' || label === 'Sign up' || href.includes('/auth/login')) &&
            element instanceof HTMLElement && element.getClientRects().length > 0;
        });
        return authControls.length === 0;
      }, undefined, { timeout: 60000, polling: 250 });
    } catch {
      return fail('PAGE_CONTRACT_DRIFT', 'authenticated ChatGPT Web page was not observed; run setup again if the session expired');
    }

    try {
      await page.waitForFunction((target) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        return [...document.querySelectorAll('[role="row"]')].some((row) => {
          if (!visible(row)) return false;
          return [...row.querySelectorAll('*')].some((element) => {
            return visible(element) && element.textContent.trim() === target;
          });
        });
      }, targetProject, { timeout: 30000, polling: 250 });
    } catch {
      return fail('PROJECT_NOT_FOUND', 'no Project exactly named chatgpt-pro-collab was found; check the signed-in account and create or organize the chatgpt-pro-collab Project manually');
    }
    let rowInfo = { status: 'drift', reason: 'target Project row disappeared after it was observed' };
    for (let attempt = 0; attempt < 4 && rowInfo.status === 'drift'; attempt += 1) {
      if (attempt > 0) {
        await page.waitForTimeout(400);
      }
      rowInfo = await evaluate((target) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        const rows = [...document.querySelectorAll('[role="row"]')].filter(visible);
        const matched = rows.filter((row) => {
          return [...row.querySelectorAll('*')].some((element) => {
            return visible(element) && element.textContent.trim() === target;
          });
        });
        if (matched.length > 1) return { status: 'not-unique', count: matched.length };
        if (matched.length === 0) return { status: 'drift', reason: 'target Project row disappeared after it was observed' };
        const names = [...matched[0].querySelectorAll('*')].filter((element) => {
          return visible(element) && element.textContent.trim() === target;
        });
        if (names.length === 0) return { status: 'drift', reason: 'target Project name is not clickable inside its row' };
        return { status: 'ok' };
      }, targetProject);
    }
    if (rowInfo.status === 'not-unique') {
      return fail('PROJECT_NOT_UNIQUE', 'more than one Project exactly named chatgpt-pro-collab was found; rename or organize the Projects manually');
    }
    if (rowInfo.status === 'drift') {
      return fail('PAGE_CONTRACT_DRIFT', rowInfo.reason);
    }
    try {
      await page.evaluate((target) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        const rows = [...document.querySelectorAll('[role="row"]')].filter(visible);
        const matched = rows.filter((row) => {
          return [...row.querySelectorAll('*')].some((element) => {
            return visible(element) && element.textContent.trim() === target;
          });
        });
        const names = matched.length === 1
          ? [...matched[0].querySelectorAll('*')].filter((element) => {
              return visible(element) && element.textContent.trim() === target;
            })
          : [];
        if (names.length > 0) names[0].click();
      }, targetProject);
    } catch {
      // The click may have started navigation before its context was destroyed;
      // the project identity wait below is the arbiter.
    }

    try {
      await page.waitForFunction((target) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        const urlOk = /^\\/g\\/g-p-[^/]+\\/project$/.test(location.pathname);
        const main = document.querySelector('main') ?? document.querySelector('[role="main"]');
        const titleOk = main !== null && [...main.querySelectorAll('h1')].some((element) => {
          return visible(element) && element.textContent.trim() === target;
        });
        const composers = [...document.querySelectorAll('#prompt-textarea')].filter(visible);
        const composerOk = composers.length === 1 && (composers[0].textContent ?? '').trim() === '';
        const turnsOk = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')].filter(visible).length === 0;
        return urlOk && titleOk && composerOk && turnsOk;
      }, targetProject, { timeout: 60000, polling: 250 });
    } catch {
      return fail('PAGE_CONTRACT_DRIFT', 'project new-conversation identity was not observed after entering the Project');
    }

    const selectorState = () => evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const forms = [...document.querySelectorAll('form')].filter((form) => {
        return form.querySelector('#prompt-textarea') !== null;
      });
      if (forms.length !== 1) return { status: 'drift', reason: 'composer form is not unique' };
      const candidates = [...forms[0].querySelectorAll('button')].filter((button) => {
        if (!visible(button)) return false;
        const testId = button.getAttribute('data-testid');
        if (testId === 'send-button' || testId === 'composer-plus-btn') return false;
        return button.getAttribute('aria-haspopup') === 'menu';
      });
      if (candidates.length !== 1) {
        return { status: 'drift', reason: 'composer model/mode selector control is not unique' };
      }
      return { status: 'ok', expanded: candidates[0].getAttribute('aria-expanded') === 'true' };
    });
    const selectorControl = page.locator(
      'form button[aria-haspopup="menu"]:not([data-testid="send-button"]):not([data-testid="composer-plus-btn"])',
    );
    const menuHasTargets = () => evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const nameOf = (element) => element.getAttribute('aria-label') ?? (element.textContent ?? '').trim();
      const sliders = [...document.querySelectorAll('[role="slider"]')].filter(visible);
      const modelItems = [...document.querySelectorAll('[role="menuitem"], [role="option"]')].filter((element) => {
        return visible(element) && /^Model/u.test(nameOf(element));
      });
      return sliders.length > 0 || modelItems.length > 0;
    });
    const ensureMenuOpen = async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (await menuHasTargets()) return { status: 'ok' };
        const state = await selectorState();
        if (state.status === 'drift') {
          await page.waitForTimeout(400);
          continue;
        }
        if (state.expanded) {
          await page.waitForTimeout(400);
          continue;
        }
        if (await selectorControl.count() !== 1) {
          await page.waitForTimeout(400);
          continue;
        }
        try {
          await selectorControl.first().click();
        } catch {
          await page.waitForTimeout(400);
          continue;
        }
        await page.waitForTimeout(500);
      }
      return { status: 'drift', reason: 'composer model/Power selector control is not unique or did not open' };
    };

    const readPower = () => evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const sliders = [...document.querySelectorAll('[role="slider"]')].filter(visible);
      if (sliders.length === 0) {
        return { status: 'unavailable' };
      }
      if (sliders.length !== 1) {
        return { status: 'drift', reason: 'Power slider is not unique' };
      }
      const now = sliders[0].getAttribute('aria-valuenow');
      const min = sliders[0].getAttribute('aria-valuemin');
      const max = sliders[0].getAttribute('aria-valuemax');
      if (now === null || min === null || max === null) {
        return { status: 'drift', reason: 'Power slider omitted its numeric state' };
      }
      return { status: 'ok', now: Number(now), min: Number(min), max: Number(max) };
    });

    const powerAtFifthLevel = (power) => {
      return power.now === power.max && power.max === 4 && power.min === 0;
    };

    const confirmPower = async () => {
      const opened = await ensureMenuOpen();
      if (opened.status === 'drift') return opened;
      let power = await readPower();
      if (power.status === 'drift') return power;
      if (power.status === 'unavailable') return power;
      if (!powerAtFifthLevel(power)) {
        const slider = page.locator('[role="slider"]');
        if (await slider.count() !== 1) {
          return { status: 'drift', reason: 'Power slider is not unique' };
        }
        await slider.press('Home');
        await page.waitForTimeout(200);
        const afterHome = await readPower();
        if (afterHome.status === 'drift') return afterHome;
        if (afterHome.status === 'unavailable') return afterHome;
        const steps = afterHome.max - afterHome.now;
        for (let step = 0; step < steps; step += 1) {
          await slider.press('ArrowRight');
          await page.waitForTimeout(120);
        }
        power = await readPower();
        if (power.status === 'drift') return power;
        if (power.status === 'unavailable') return power;
      }
      if (!powerAtFifthLevel(power)) {
        return { status: 'unconfirmed', now: power.now, min: power.min, max: power.max };
      }
      return { status: 'confirmed', now: power.now, min: power.min, max: power.max };
    };

    const openModelSubmenu = () => evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const nameOf = (element) => element.getAttribute('aria-label') ?? (element.textContent ?? '').trim();
      const openers = [...document.querySelectorAll('[role="menuitem"][aria-haspopup]')].filter((element) => {
        return visible(element) && /^Model/u.test(nameOf(element));
      });
      if (openers.length !== 1) {
        return false;
      }
      openers[0].click();
      return true;
    });

    const readCurrentModel = () => evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const nameOf = (element) => element.getAttribute('aria-label') ?? (element.textContent ?? '').trim();
      const modelItems = [...document.querySelectorAll('[role="menuitem"], [role="option"]')].filter((element) => {
        return visible(element) && /^Model/u.test(nameOf(element));
      });
      const checkedRadios = [...document.querySelectorAll('[role="menuitemradio"]')].filter((element) => {
        return visible(element) && element.getAttribute('aria-checked') === 'true';
      });
      const itemModel = modelItems.length === 1 ? nameOf(modelItems[0]).replace(/^Model/u, '').trim() : null;
      if (modelItems.length > 1) {
        return { status: 'drift', reason: 'current model readback is not unique' };
      }
      if (itemModel !== null) {
        if (checkedRadios.length === 1 && nameOf(checkedRadios[0]) !== itemModel) {
          return { status: 'drift', reason: 'current model readback paths disagree' };
        }
        return { status: 'ok', model: itemModel };
      }
      if (checkedRadios.length > 1) {
        return { status: 'drift', reason: 'checked model radio is not unique' };
      }
      if (checkedRadios.length === 1) {
        return { status: 'ok', model: nameOf(checkedRadios[0]) };
      }
      return { status: 'none' };
    });

    const confirmModel = async () => {
      const opened = await ensureMenuOpen();
      if (opened.status === 'drift') return opened;
      const current = await readCurrentModel();
      if (current.status === 'drift') return current;
      if (current.status === 'ok' && current.model === targetModel) {
        return { status: 'confirmed' };
      }
      if (!(await openModelSubmenu())) {
        return { status: 'drift', reason: 'model submenu opener is not unique' };
      }
      await page.waitForTimeout(400);
      let option = page.getByRole('menuitemradio', { name: targetModel, exact: true });
      if (await option.count() !== 1) {
        option = page.getByRole('menuitem', { name: targetModel, exact: true });
      }
      if (await option.count() !== 1) {
        return { status: 'unavailable' };
      }
      await option.first().click();
      await page.waitForTimeout(400);
      const reopened = await ensureMenuOpen();
      if (reopened.status === 'drift') return reopened;
      const after = await readCurrentModel();
      if (after.status === 'drift') return after;
      if (after.status !== 'ok' || after.model !== targetModel) {
        return { status: 'unconfirmed' };
      }
      return { status: 'confirmed' };
    };

    const powerResult = await confirmPower();
    if (powerResult.status === 'drift') return fail('PAGE_CONTRACT_DRIFT', powerResult.reason);
    if (powerResult.status === 'unavailable') {
      return fail('FIXED_TARGET_UNAVAILABLE', 'fixed Power slider is not available or not unique as a slider');
    }
    if (powerResult.status === 'unconfirmed') {
      return fail(
        'SELECTION_UNCONFIRMED',
        'fixed Power could not be set to the fifth level (aria-valuenow == aria-valuemax == 4 in the zero-based 0..4 range)',
      );
    }

    const modelResult = await confirmModel();
    if (modelResult.status === 'drift') return fail('PAGE_CONTRACT_DRIFT', modelResult.reason);
    if (modelResult.status === 'unavailable') {
      return fail('FIXED_TARGET_UNAVAILABLE', 'fixed model GPT-5.6 Sol is not available in the model submenu');
    }
    if (modelResult.status === 'unconfirmed') {
      return fail('SELECTION_UNCONFIRMED', 'fixed model GPT-5.6 Sol could not be read back as the current model');
    }

    const jointReadback = async () => {
      const opened = await ensureMenuOpen();
      if (opened.status === 'drift') return opened;
      const modelState = await readCurrentModel();
      if (modelState.status === 'drift') return modelState;
      if (modelState.status !== 'ok' || modelState.model !== targetModel) {
        return { status: 'unconfirmed', target: 'model GPT-5.6 Sol' };
      }
      const powerState = await readPower();
      if (powerState.status === 'drift') return powerState;
      if (powerState.status !== 'ok' || !powerAtFifthLevel(powerState)) {
        return { status: 'unconfirmed', target: 'Power 5/5' };
      }
      return { status: 'confirmed', now: powerState.now, min: powerState.min, max: powerState.max };
    };
    const joint = await jointReadback();
    if (joint.status === 'drift') return fail('PAGE_CONTRACT_DRIFT', joint.reason);
    if (joint.status === 'unconfirmed') {
      return fail(
        'SELECTION_UNCONFIRMED',
        'fixed ' + joint.target + ' was not jointly read back after all selections',
      );
    }

    try {
      await page.waitForFunction((target) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        const urlOk = /^\\/g\\/g-p-[^/]+\\/project$/.test(location.pathname);
        const main = document.querySelector('main') ?? document.querySelector('[role="main"]');
        const titleOk = main !== null && [...main.querySelectorAll('h1')].some((element) => {
          return visible(element) && element.textContent.trim() === target;
        });
        const composers = [...document.querySelectorAll('#prompt-textarea')].filter(visible);
        const composerOk = composers.length === 1 && (composers[0].textContent ?? '').trim() === '';
        return urlOk && titleOk && composerOk;
      }, targetProject, { timeout: 60000, polling: 250 });
    } catch {
      return fail('PAGE_CONTRACT_DRIFT', 'project context drifted during model and Power confirmation');
    }

    try {
      const state = await selectorState();
      if (state.status === 'ok' && state.expanded) {
        await selectorControl.first().click();
        await page.waitForTimeout(300);
      }
    } catch {
      // Menu close is best-effort cleanup; the confirmed selection persists.
    }

    await page.evaluate((marker) => {
      sessionStorage.setItem('chatgpt-pro-collab-context-id', marker);
    }, contextMarker);
    const observedContextMarker = await page.evaluate(() => {
      return sessionStorage.getItem('chatgpt-pro-collab-context-id');
    });
    if (observedContextMarker !== contextMarker) {
      return fail('PAGE_CONTRACT_DRIFT', 'task context marker could not be read back');
    }
    const finalUrl = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    const projectMatch = /^\\/g\\/g-p-([^/]+)\\/project$/.exec(finalUrl.pathname);
    if (finalUrl.hostname !== 'chatgpt.com' || projectMatch === null) {
      return fail('PAGE_CONTRACT_DRIFT', 'final project context drifted before the start result');
    }
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'start',
      url: page.url(),
      contextMarker: observedContextMarker,
      projectId: projectMatch[1],
      modelConfirmed: true,
      powerConfirmed: true,
      powerNow: joint.now,
      powerMin: joint.min,
      powerMax: joint.max,
    });
  }`;
}

const SEND_TARGET_OK = `
    const sendTargetOk = (pathname) => {
      const normalized = pathname.replace(/\\/$/, '');
      if (expectedConversationId === null) {
        return /^\\/g\\/g-p-[^/]+\\/project$/.test(normalized);
      }
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
      return match !== null && !match[1].startsWith('WEB:') && match[1] === expectedConversationId;
    };`;

const USER_TURN_EVIDENCE = `
    const readUserTurnEvidence = (element, expectedPrompt, names) => {
      const visible = (candidate) => {
        if (!(candidate instanceof HTMLElement)) return false;
        const style = getComputedStyle(candidate);
        return style.visibility !== 'hidden' && style.display !== 'none' && candidate.getClientRects().length > 0;
      };
      const leaves = [...element.querySelectorAll('*')].filter((leaf) => visible(leaf) && leaf.children.length === 0);
      const isAccessibleHeading = (leaf) => {
        const tagName = typeof leaf.tagName === 'string' ? leaf.tagName.toUpperCase() : '';
        const role = typeof leaf.getAttribute === 'function' ? (leaf.getAttribute('role') || '') : '';
        return /^H[1-6]$/.test(tagName) || role === 'heading';
      };
      const leafInside = (leaf, container) => {
        let ancestor = leaf.parentElement;
        while (ancestor !== null && ancestor !== element) {
          if (ancestor === container) return true;
          ancestor = ancestor.parentElement;
        }
        return false;
      };
      const chipContainers = new Set();
      for (const leaf of leaves) {
        const text = (leaf.textContent || '').trim();
        if (!names.includes(text)) continue;
        let container = leaf.parentElement;
        while (container !== null && container !== element) {
          const inside = leaves.filter((candidate) => leafInside(candidate, container));
          if (inside.length > 1) break;
          container = container.parentElement;
        }
        chipContainers.add(container === null || container === element ? leaf : container);
      }
      const attachmentTexts = [];
      const promptParts = [];
      for (const leaf of leaves) {
        const inChip = [...chipContainers].some((container) => leafInside(leaf, container));
        const text = (leaf.textContent || '').trim();
        if (inChip) {
          if (names.includes(text)) attachmentTexts.push(text);
          continue;
        }
        if (isAccessibleHeading(leaf) && (text === 'You said:' || text === 'You said')) continue;
        promptParts.push(leaf.textContent || '');
      }
      if (attachmentTexts.length !== names.length) return false;
      for (let index = 0; index < names.length; index += 1) {
        if (attachmentTexts[index] !== names[index]) return false;
      }
      return promptParts.join('') === expectedPrompt;
    };`;

/**
 * Builds the fixed Project blank-composer identity wait for a first send.
 *
 * @param timeoutMs Bounded wait for the fixed identity to settle.
 * @returns A Playwright page function source fragment.
 * @throws {Error} This pure source builder does not throw.
 */
function projectComposerIdentityWait(timeoutMs: number): string {
  return `
    await page.waitForFunction((target) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const urlOk = /^\\/g\\/g-p-[^/]+\\/project$/.test(location.pathname);
      const main = document.querySelector('main') ?? document.querySelector('[role="main"]');
      const titleOk = main !== null && [...main.querySelectorAll('h1')].some((element) => {
        return visible(element) && element.textContent.trim() === target;
      });
      const composers = [...document.querySelectorAll('#prompt-textarea')].filter(visible);
      const composerOk = composers.length === 1 && (composers[0].textContent ?? '').trim() === '';
      const turnsOk = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')].filter(visible).length === 0;
      return urlOk && titleOk && composerOk && turnsOk;
    }, 'chatgpt-pro-collab', { timeout: ${JSON.stringify(timeoutMs)}, polling: 250 });`;
}

/**
 * Builds the pre-upload conversation and composer identity gate.
 *
 * @param expectedConversationId Existing bound conversation, or null for a first turn.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function sendTargetVerificationScript(expectedConversationId: string | null): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};${SEND_TARGET_OK}
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (url.hostname !== 'chatgpt.com' || !sendTargetOk(url.pathname)) {
      throw new Error('conversation identity does not match the send target');
    }
    if (expectedConversationId === null) {${projectComposerIdentityWait(60000)}
    }
    const composer = page.locator('#prompt-textarea');
    const archivedMessage = page.getByText(
      'This conversation is archived. To continue, please unarchive it first.',
      { exact: true },
    );
    await page.waitForFunction(() => {
      const visible = (element) => {
        return (
          element instanceof HTMLElement &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== 'hidden' &&
          getComputedStyle(element).display !== 'none'
        );
      };
      const composerElement = document.querySelector('#prompt-textarea');
      const archivedElement = [...document.querySelectorAll('div')].find((element) => {
        return element.textContent?.trim() ===
          'This conversation is archived. To continue, please unarchive it first.';
      });
      return visible(composerElement) || visible(archivedElement);
    }, undefined, { timeout: 60000, polling: 100 });
    if (await archivedMessage.count() === 1 && await archivedMessage.isVisible()) {
      const unarchive = page.getByRole('button', { name: 'Unarchive', exact: true });
      if (await unarchive.count() !== 1 || !(await unarchive.isVisible())) {
        throw new Error('page contract drift: Unarchive action is not unique and visible');
      }
      await unarchive.click();
    }
    await composer.waitFor({ state: 'visible', timeout: 60000 });
    if (await composer.count() !== 1 || !(await composer.isVisible())) {
      throw new Error('page contract drift: composer is not unique and visible');
    }
    const readyUrl = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (readyUrl.hostname !== 'chatgpt.com' || !sendTargetOk(readyUrl.pathname)) {
      throw new Error('conversation identity changed while making the send target writable');
    }
    return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'send-ready' });
  }`;
}

/**
 * Builds a reload-based cleanup for any attachment chooser or draft changed before submission.
 *
 * When the expected conversation is not yet bound, cleanup only reports `draft-cleared` after
 * re-proving the fixed `chatgpt-pro-collab` Project blank-composer identity, so a drifted page
 * on another Project's empty composer fails instead of passing cleanup.
 *
 * @param expectedConversationId Existing bound conversation, or null for a new task.
 * @param attachmentFileNames Basenames that must disappear from the composer after reload.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function clearUploadDraftScript(expectedConversationId: string | null, attachmentFileNames: readonly string[]): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};${SEND_TARGET_OK}
    const attachmentFileNames = ${JSON.stringify(attachmentFileNames)};
    await page.reload({ waitUntil: 'domcontentloaded' });
    const composer = page.locator('#prompt-textarea');
    await composer.waitFor({ state: 'visible', timeout: 60000 });
    if (await composer.count() !== 1) throw new Error('page contract drift: composer is not unique after reload');
    const composerForm = page.locator('form').filter({ has: composer });
    if (await composerForm.count() !== 1) throw new Error('page contract drift: composer form is not unique');
    const populatedFileInputCount = await composerForm.locator('input[type="file"]').evaluateAll((elements) => {
      return elements.filter((element) => element instanceof HTMLInputElement && element.value !== '').length;
    });
    const visibleAttachmentFileNames = [];
    for (const fileName of attachmentFileNames) {
      const visible = await composerForm.getByText(fileName, { exact: true }).evaluateAll((elements) => {
        return elements.some((element) => element instanceof HTMLElement && element.getClientRects().length > 0);
      });
      if (visible) visibleAttachmentFileNames.push(fileName);
    }
    if (populatedFileInputCount !== 0 || visibleAttachmentFileNames.length !== 0) {
      throw new Error('attachment draft remained after reload');
    }
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (url.hostname !== 'chatgpt.com' || !sendTargetOk(url.pathname)) {
      throw new Error('conversation identity changed while clearing attachment draft');
    }
    if (expectedConversationId === null) {${projectComposerIdentityWait(60000)}
    }
    return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'draft-cleared' });
  }`;
}

/**
 * Builds the exact file-chooser action required before each CLI upload command.
 *
 * @param expectedConversationId Existing bound conversation, or null for a new task.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function uploadPreparationScript(expectedConversationId: string | null): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};${SEND_TARGET_OK}
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (url.hostname !== 'chatgpt.com' || !sendTargetOk(url.pathname)) {
      throw new Error('conversation identity changed before attachment preparation');
    }
    const plus = page.locator('[data-testid="composer-plus-btn"]');
    if (await plus.count() !== 1) throw new Error('page contract drift: composer plus button is not unique');
    let lastFailure = 'page contract drift: upload action was not visible';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
      await plus.click();
      await page.waitForTimeout(500);
      const upload = page.getByText('Add photos & files', { exact: true });
      try {
        await upload.waitFor({ state: 'visible', timeout: 10000 });
      } catch {
        lastFailure = 'page contract drift: upload action was not visible';
        continue;
      }
      if (await upload.count() !== 1) {
        lastFailure = 'page contract drift: upload action is not unique';
        continue;
      }
      await upload.click();
      return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'upload-ready' });
    }
    throw new Error(lastFailure);
  }`;
}

/**
 * Builds the single-message submission script with an explicit ambiguity boundary.
 *
 * @param expectedConversationId Existing bound conversation, or null for a new task.
 * @param prompt Exact prompt text to fill into the composer.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function sendScript(expectedConversationId: string | null, prompt: string): string {
  return `async (page) => {
    let clicked = false;
    try {
      const expectedConversationId = ${JSON.stringify(expectedConversationId)};${SEND_TARGET_OK}
      const conversationIdOf = (pathname) => {
        const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
        return match === null || match[1].startsWith('WEB:') ? null : match[1];
      };
      const initialUrl = await page.evaluate(() => {
        return { hostname: location.hostname, pathname: location.pathname };
      });
      if (initialUrl.hostname !== 'chatgpt.com' || !sendTargetOk(initialUrl.pathname)) {
        throw new Error('conversation identity changed before prompt submission');
      }
      if (expectedConversationId === null) {
        try {${projectComposerIdentityWait(5000)}
        } catch {
          throw new Error('fixed chatgpt-pro-collab Project blank composer was not re-verified before submission');
        }
      }
      const composer = page.locator('#prompt-textarea');
      const send = page.locator('[data-testid="send-button"]');
      const turns = page.locator('[data-testid^="conversation-turn-"][data-turn]');
      if (await composer.count() !== 1) throw new Error('page contract drift: composer is not unique');
      if (await send.count() !== 1) throw new Error('page contract drift: send button is not unique');
      const userIds = await turns.evaluateAll((elements) => {
        return elements
          .filter((element) => element.getAttribute('data-turn') === 'user')
          .map((element) => element.getAttribute('data-testid'));
      });
      await composer.fill(${JSON.stringify(prompt)});
      clicked = true;
      await send.click();
      await page.waitForFunction((knownIds) => {
        const ids = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn="user"]')].map(
          (element) => element.getAttribute('data-testid'),
        );
        return ids.some((id) => id !== null && !knownIds.includes(id));
      }, userIds, { timeout: 120000, polling: 100 });
      const userTurnIdentity = await page.evaluate(() => {
        const elements = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn="user"]')];
        const last = elements.at(-1);
        return last === undefined ? null : last.getAttribute('data-testid');
      });
      if (userTurnIdentity === null) {
        throw new Error('page contract drift: submitted user turn identity was not observed');
      }
      await page.waitForFunction(() => {
        const match = /\\/c\\/([^/?#]+)\\/?$/.exec(location.pathname);
        return match !== null && !match[1].startsWith('WEB:');
      }, undefined, { timeout: 60000, polling: 100 });
      const url = await page.evaluate(() => {
        return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
      });
      const conversationId = conversationIdOf(url.pathname);
      if (url.hostname !== 'chatgpt.com' || conversationId === null) {
        throw new Error('page contract drift: canonical conversation URL was not observed');
      }
      if (expectedConversationId !== null && conversationId !== expectedConversationId) {
        throw new Error('submitted conversation identity differs from the bound task');
      }
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'send',
        status: 'submitted',
        conversationId,
        conversationUrl: url.origin + url.pathname,
        userTurnIdentity,
      });
    } catch (error) {
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'send',
        status: clicked ? 'unknown-submission' : 'not-submitted',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }`;
}

/**
 * Builds one bounded completion observation for the assistant after the exact user turn.
 *
 * @param expectedConversationId Database-bound canonical identity.
 * @param expectedUserTurnId Persisted exact identity of the submitted user turn.
 * @param observationWindowMs Remaining finite observation budget.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function observationScript(
  expectedConversationId: string,
  expectedUserTurnId: string,
  observationWindowMs: number,
): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const expectedUserTurnId = ${JSON.stringify(expectedUserTurnId)};
    const observationWindowMs = ${JSON.stringify(observationWindowMs)};
    const observationDeadline = Date.now() + observationWindowMs;
    const conversationIdOf = (pathname) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
      return match === null || match[1].startsWith('WEB:') ? null : match[1];
    };
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    if (url.hostname !== 'chatgpt.com' || conversationIdOf(url.pathname) !== expectedConversationId) {
      throw new Error('conversation identity does not match the pending turn');
    }
    const turnSelector = '[data-testid^="conversation-turn-"][data-turn]';
    const copySelector = '[data-testid="copy-turn-action-button"]';
    const anchorState = await page.locator(turnSelector).evaluateAll((elements, anchorTurnId) => {
      return elements.filter((element) => {
        return element.getAttribute('data-turn') === 'user' &&
          element.getAttribute('data-testid') === anchorTurnId;
      }).length;
    }, expectedUserTurnId);
    if (anchorState !== 1) {
      throw new Error('page contract drift: persisted user turn anchor is absent or not unique');
    }
    let assistantIndex = -1;
    let assistantTurnId = null;
    let stableCompletedPolls = 0;
    let polls = 0;
    while (stableCompletedPolls < 6 && polls < 10 && Date.now() < observationDeadline) {
      polls += 1;
      const candidate = await page.locator(turnSelector).evaluateAll((elements, anchorTurnId) => {
        const anchorMatches = elements.flatMap((element, index) => {
          return element.getAttribute('data-turn') === 'user' &&
            element.getAttribute('data-testid') === anchorTurnId
            ? [index]
            : [];
        });
        if (anchorMatches.length !== 1) {
          throw new Error('page contract drift: persisted user turn anchor became absent or not unique');
        }
        const assistant = elements[anchorMatches[0] + 1];
        const turnId = assistant?.getAttribute('data-testid') ?? null;
        if (assistant === undefined || assistant.getAttribute('data-turn') !== 'assistant' || turnId === null) {
          return null;
        }
        const copy = assistant.querySelectorAll('[data-testid="copy-turn-action-button"]');
        return copy.length === 1 && copy[0] instanceof HTMLElement && copy[0].getClientRects().length > 0
          ? { index: anchorMatches[0] + 1, turnId }
          : null;
      }, expectedUserTurnId);
      const stop = page.getByRole('button', { name: 'Stop answering', exact: true });
      const stopVisible = await stop.count() > 0 && await stop.first().isVisible();
      if (candidate !== null && !stopVisible) {
        if (candidate.index !== assistantIndex || candidate.turnId !== assistantTurnId) stableCompletedPolls = 0;
        assistantIndex = candidate.index;
        assistantTurnId = candidate.turnId;
        stableCompletedPolls += 1;
      } else {
        assistantIndex = -1;
        assistantTurnId = null;
        stableCompletedPolls = 0;
      }
      if (stableCompletedPolls < 6 && Date.now() < observationDeadline) {
        await page.waitForTimeout(Math.min(500, Math.max(1, observationDeadline - Date.now())));
      }
    }
    if (stableCompletedPolls < 6 || assistantTurnId === null) {
      return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'observe', status: 'pending' });
    }
    const completedUrl = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    if (completedUrl.hostname !== 'chatgpt.com' || conversationIdOf(completedUrl.pathname) !== expectedConversationId) {
      throw new Error('conversation identity changed while observing response completion');
    }
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'observe',
      status: 'completed',
      conversationId: conversationIdOf(completedUrl.pathname),
      conversationUrl: completedUrl.origin + completedUrl.pathname,
      assistantTurnId,
    });
  }`;
}

/**
 * Builds page-local Copy response interception for the already completed target assistant turn.
 *
 * @param expectedConversationId Database-bound canonical identity.
 * @param expectedAssistantTurnId Assistant DOM identity returned by completion observation, or null for a capturing retry.
 * @param captureTimeoutMs Remaining finite capture budget.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function captureScript(
  expectedConversationId: string,
  expectedAssistantTurnId: string | null,
  captureTimeoutMs: number,
): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const expectedAssistantTurnId = ${JSON.stringify(expectedAssistantTurnId)};
    const captureTimeoutMs = ${JSON.stringify(captureTimeoutMs)};
    const captureDeadline = Date.now() + captureTimeoutMs;
    const conversationIdOf = (pathname) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
      return match === null || match[1].startsWith('WEB:') ? null : match[1];
    };
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (url.hostname !== 'chatgpt.com' || conversationIdOf(url.pathname) !== expectedConversationId) {
      throw new Error('conversation identity does not match the capturing turn');
    }
    const turnSelector = '[data-testid^="conversation-turn-"][data-turn]';
    const copySelector = '[data-testid="copy-turn-action-button"]';
    const assistantIndices = await page.locator(turnSelector).evaluateAll((elements, targetTurnId) => {
      if (targetTurnId !== null) {
        return elements.flatMap((element, index) => {
          return element.getAttribute('data-turn') === 'assistant' &&
            element.getAttribute('data-testid') === targetTurnId
            ? [index]
            : [];
        });
      }
      let latestUser = -1;
      for (let index = 0; index < elements.length; index += 1) {
        if (elements[index].getAttribute('data-turn') === 'user') latestUser = index;
      }
      if (latestUser < 0 || latestUser + 1 >= elements.length) return [];
      return elements[latestUser + 1].getAttribute('data-turn') === 'assistant' ? [latestUser + 1] : [];
    }, expectedAssistantTurnId);
    if (assistantIndices.length !== 1) {
      throw new Error('page contract drift: target assistant turn is absent or not unique');
    }
    const assistantIndex = assistantIndices[0];
    const assistant = page.locator(turnSelector).nth(assistantIndex);
    const copy = assistant.locator(copySelector);
    if (await copy.count() !== 1 || !(await copy.isVisible())) {
      throw new Error('page contract drift: assistant Copy response is not unique and visible');
    }
    const stop = page.getByRole('button', { name: 'Stop answering', exact: true });
    if (await stop.count() > 0 && await stop.first().isVisible()) {
      throw new Error('completion state changed before Copy response capture');
    }
    await page.evaluate(() => {
      const clipboard = navigator.clipboard;
      if (!clipboard) throw new Error('page clipboard API is unavailable');
      const ownWrite = Object.getOwnPropertyDescriptor(clipboard, 'write');
      const ownWriteText = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
      globalThis.__chatgptProCollabClipboard = { clipboard, ownWrite, ownWriteText, captured: undefined };
      Object.defineProperty(clipboard, 'writeText', {
        configurable: true,
        value: async (text) => {
          globalThis.__chatgptProCollabClipboard.captured = { plain: String(text), html: undefined };
        },
      });
      Object.defineProperty(clipboard, 'write', {
        configurable: true,
        value: async (items) => {
          for (const item of items) {
            if (item.types.includes('text/plain')) {
              const plain = await (await item.getType('text/plain')).text();
              const html = item.types.includes('text/html')
                ? await (await item.getType('text/html')).text()
                : undefined;
              globalThis.__chatgptProCollabClipboard.captured = { plain, html };
              return;
            }
          }
        },
      });
    });
    let response;
    try {
      await copy.click({ force: true, timeout: Math.max(1, captureDeadline - Date.now()) });
      await page.waitForFunction(() => {
        return globalThis.__chatgptProCollabClipboard?.captured !== undefined;
      }, undefined, { timeout: Math.max(1, captureDeadline - Date.now()), polling: 25 });
      response = await page.evaluate(() => globalThis.__chatgptProCollabClipboard.captured);
    } finally {
      await page.evaluate(() => {
        const state = globalThis.__chatgptProCollabClipboard;
        if (!state) return;
        if (state.ownWrite === undefined) delete state.clipboard.write;
        else Object.defineProperty(state.clipboard, 'write', state.ownWrite);
        if (state.ownWriteText === undefined) delete state.clipboard.writeText;
        else Object.defineProperty(state.clipboard, 'writeText', state.ownWriteText);
        delete globalThis.__chatgptProCollabClipboard;
      });
    }
    if (typeof response?.plain !== 'string' || typeof response?.html !== 'string') {
      throw new Error('page contract drift: Copy response omitted text/plain or text/html');
    }
    const artifacts = await assistant.evaluate((element, html) => {
      const document = new DOMParser().parseFromString(html, 'text/html');
      const occurrences = [...document.querySelectorAll('a')].flatMap((anchor) => {
        const sourceUrl = anchor.getAttribute('href');
        return sourceUrl?.startsWith('sandbox:')
          ? [{ sourceUrl, label: (anchor.textContent || '').trim() }]
          : [];
      });
      const behaviorButtons = element.querySelectorAll('button.behavior-btn');
      if (behaviorButtons.length !== occurrences.length) {
        throw new Error('page contract drift: sandbox links do not match behavior buttons');
      }
      const seen = new Set();
      return occurrences.filter((artifact) => {
        if (seen.has(artifact.sourceUrl)) return false;
        seen.add(artifact.sourceUrl);
        return true;
      });
    }, response.html);
    const capturedUrl = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    if (capturedUrl.hostname !== 'chatgpt.com' || conversationIdOf(capturedUrl.pathname) !== expectedConversationId) {
      throw new Error('conversation identity changed before response capture completed');
    }
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'capture',
      response: response.plain,
      responseHtml: response.html,
      artifacts,
      conversationId: conversationIdOf(capturedUrl.pathname),
      conversationUrl: capturedUrl.origin + capturedUrl.pathname,
    });
  }`;
}

/**
 * Builds a strict source-URL-to-control mapping and saves one browser download event.
 *
 * @param expectedConversationId Database-bound canonical identity.
 * @param expectedSourceUrls Complete recorded artifact set in response order.
 * @param targetSourceUrl Exact recorded `sandbox:` logical target.
 * @param temporaryPath Fresh task-owned browser save path.
 * @param captureTimeoutMs Remaining finite capture budget.
 * @param refreshControls Whether this wait process must refresh controls before its first download.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function downloadArtifactScript(
  expectedConversationId: string,
  expectedSourceUrls: readonly string[],
  targetSourceUrl: string,
  temporaryPath: string,
  captureTimeoutMs: number,
  refreshControls: boolean,
): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const expectedSourceUrls = ${JSON.stringify(expectedSourceUrls)};
    const targetSourceUrl = ${JSON.stringify(targetSourceUrl)};
    const temporaryPath = ${JSON.stringify(temporaryPath)};
    const captureDeadline = Date.now() + ${JSON.stringify(captureTimeoutMs)};
    const refreshControls = ${JSON.stringify(refreshControls)};
    const remaining = () => Math.max(1, captureDeadline - Date.now());
    const conversationIdOf = (pathname) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
      return match === null || match[1].startsWith('WEB:') ? null : match[1];
    };
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (url.hostname !== 'chatgpt.com' || conversationIdOf(url.pathname) !== expectedConversationId) {
      throw new Error('conversation identity does not match artifact capture');
    }
    if (refreshControls) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const reloadedUrl = await page.evaluate(() => {
        return { hostname: location.hostname, pathname: location.pathname };
      });
      if (reloadedUrl.hostname !== 'chatgpt.com' || conversationIdOf(reloadedUrl.pathname) !== expectedConversationId) {
        throw new Error('conversation identity changed while refreshing artifact controls');
      }
    }
    const turnSelector = '[data-testid^="conversation-turn-"][data-turn]';
    await page.locator(turnSelector).last().waitFor({ state: 'visible', timeout: remaining() });
    const assistantIndex = await page.locator(turnSelector).evaluateAll((elements) => {
      let latestUser = -1;
      for (let index = 0; index < elements.length; index += 1) {
        if (elements[index].getAttribute('data-turn') === 'user') latestUser = index;
      }
      if (latestUser < 0 || latestUser + 1 >= elements.length) return -1;
      return elements[latestUser + 1].getAttribute('data-turn') === 'assistant' ? latestUser + 1 : -1;
    });
    if (assistantIndex < 0) throw new Error('page contract drift: target assistant turn is absent');
    const assistant = page.locator(turnSelector).nth(assistantIndex);
    const copy = assistant.locator('[data-testid="copy-turn-action-button"]');
    if (await copy.count() !== 1 || !(await copy.isVisible())) {
      throw new Error('page contract drift: assistant Copy response is not unique and visible');
    }
    const stop = page.getByRole('button', { name: 'Stop answering', exact: true });
    if (await stop.count() > 0 && await stop.first().isVisible()) {
      throw new Error('completion state changed before artifact capture');
    }
    await page.evaluate(() => {
      const clipboard = navigator.clipboard;
      if (!clipboard) throw new Error('page clipboard API is unavailable');
      const ownWrite = Object.getOwnPropertyDescriptor(clipboard, 'write');
      const ownWriteText = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
      globalThis.__chatgptProCollabClipboard = { clipboard, ownWrite, ownWriteText, captured: undefined };
      Object.defineProperty(clipboard, 'writeText', {
        configurable: true,
        value: async () => { globalThis.__chatgptProCollabClipboard.captured = undefined; },
      });
      Object.defineProperty(clipboard, 'write', {
        configurable: true,
        value: async (items) => {
          for (const item of items) {
            if (item.types.includes('text/plain')) {
              const plain = await (await item.getType('text/plain')).text();
              const html = item.types.includes('text/html')
                ? await (await item.getType('text/html')).text()
                : undefined;
              globalThis.__chatgptProCollabClipboard.captured = { plain, html };
              return;
            }
          }
        },
      });
    });
    let response;
    try {
      await copy.click({ force: true, timeout: remaining() });
      await page.waitForFunction(() => {
        return globalThis.__chatgptProCollabClipboard?.captured !== undefined;
      }, undefined, { timeout: remaining(), polling: 25 });
      response = await page.evaluate(() => globalThis.__chatgptProCollabClipboard.captured);
    } finally {
      await page.evaluate(() => {
        const state = globalThis.__chatgptProCollabClipboard;
        if (!state) return;
        if (state.ownWrite === undefined) delete state.clipboard.write;
        else Object.defineProperty(state.clipboard, 'write', state.ownWrite);
        if (state.ownWriteText === undefined) delete state.clipboard.writeText;
        else Object.defineProperty(state.clipboard, 'writeText', state.ownWriteText);
        delete globalThis.__chatgptProCollabClipboard;
      });
    }
    if (typeof response?.plain !== 'string' || typeof response?.html !== 'string') {
      throw new Error('page contract drift: Copy response omitted text/plain or text/html');
    }
    const sandboxOccurrenceCount = await page.evaluate((html) => {
      const document = new DOMParser().parseFromString(html, 'text/html');
      return [...document.querySelectorAll('a')].filter((anchor) => {
        return anchor.getAttribute('href')?.startsWith('sandbox:');
      }).length;
    }, response.html);
    if (sandboxOccurrenceCount <= 0) throw new Error('artifact set changed before download');
    await assistant
      .locator('button.behavior-btn')
      .nth(sandboxOccurrenceCount - 1)
      .waitFor({ state: 'attached', timeout: remaining() });
    const discovered = await assistant.evaluate((element, html) => {
      const document = new DOMParser().parseFromString(html, 'text/html');
      const occurrences = [];
      for (const anchor of document.querySelectorAll('a')) {
        const sourceUrl = anchor.getAttribute('href');
        if (!sourceUrl?.startsWith('sandbox:')) continue;
        const encodedName = sourceUrl.slice(sourceUrl.lastIndexOf('/') + 1);
        const basename = decodeURIComponent(encodedName);
        occurrences.push({
          sourceUrl,
          label: (anchor.textContent || '').trim(),
          basename,
          occurrenceIndex: occurrences.length,
        });
      }
      const behaviorButtons = element.querySelectorAll('button.behavior-btn');
      if (behaviorButtons.length !== occurrences.length) {
        throw new Error('page contract drift: sandbox links do not match behavior buttons');
      }
      const seen = new Set();
      const uniqueTargets = occurrences.filter((artifact) => {
        if (seen.has(artifact.sourceUrl)) return false;
        seen.add(artifact.sourceUrl);
        return true;
      });
      return { occurrences, uniqueTargets };
    }, response.html);
    if (
      discovered.uniqueTargets.length !== expectedSourceUrls.length ||
      discovered.uniqueTargets.some((artifact, index) => artifact.sourceUrl !== expectedSourceUrls[index])
    ) {
      throw new Error('artifact set changed before download');
    }
    const targetIndex = discovered.uniqueTargets.findIndex((artifact) => artifact.sourceUrl === targetSourceUrl);
    if (targetIndex < 0) throw new Error('artifact set changed before download');

    const more = assistant.getByText(/^\\d+ more$/);
    if (await more.count() > 1) throw new Error('page contract drift: artifact expander is not unique');
    if (await more.count() === 1 && await more.isVisible()) await more.click();
    const downloadButtons = assistant.getByRole('button', { name: 'Download file', exact: true });
    const rowLines = [];
    for (let index = 0; index < await downloadButtons.count(); index += 1) {
      const lines = await downloadButtons.nth(index).evaluate((button) => {
        const assistantElement = button.closest('[data-testid^="conversation-turn-"][data-turn="assistant"]');
        if (assistantElement === null) {
          throw new Error('page contract drift: artifact row is outside the target assistant');
        }
        let row = button.parentElement;
        while (row !== null && row !== assistantElement) {
          const controls = [...row.querySelectorAll('button')];
          const names = controls.map((candidate) => {
            return (
              candidate.getAttribute('aria-label') ||
              candidate.getAttribute('title') ||
              candidate.textContent ||
              ''
            ).trim();
          });
          const fileControls = controls.filter((candidate) => {
            const name = candidate.getAttribute('aria-label');
            return name !== null && name !== '' && name !== 'Download file';
          });
          if (controls.length === 2 && fileControls.length === 1 && names.includes('Download file')) {
            return (row.innerText || '').split(/\\n/u).map((line) => line.trim()).filter(Boolean);
          }
          row = row.parentElement;
        }
        throw new Error('page contract drift: artifact row controls are unrelated');
      });
      rowLines.push(lines);
    }
    const rowBySourceUrl = new Map();
    let occurrenceCursor = 0;
    for (let rowIndex = 0; rowIndex < rowLines.length; rowIndex += 1) {
      const candidates = discovered.occurrences.slice(occurrenceCursor).filter((artifact) => {
        return rowLines[rowIndex].includes(artifact.basename);
      });
      const candidateNames = new Set(candidates.map((artifact) => artifact.basename));
      if (candidates.length === 0 || candidateNames.size !== 1) {
        throw new Error('page contract drift: artifact rows are not an unambiguous target subsequence');
      }
      const matchedIndex = discovered.occurrences.findIndex((artifact, index) => {
        return (
          index >= occurrenceCursor &&
          artifact.basename === candidates[0].basename &&
          !rowBySourceUrl.has(artifact.sourceUrl)
        );
      });
      if (matchedIndex < 0) {
        throw new Error('page contract drift: artifact row has no unmatched target with its basename');
      }
      const matchedArtifact = discovered.occurrences[matchedIndex];
      rowBySourceUrl.set(matchedArtifact.sourceUrl, rowIndex);
      occurrenceCursor = matchedIndex + 1;
    }

    const rowIndex = rowBySourceUrl.get(targetSourceUrl);
    const targetDownloadMarker = 'data-chatgpt-pro-collab-target-download';
    await downloadButtons.evaluateAll((buttons, marker) => {
      for (const button of buttons) button.removeAttribute(marker);
    }, targetDownloadMarker);
    if (rowIndex !== undefined) {
      await downloadButtons.nth(rowIndex).evaluate((button, marker) => {
        button.setAttribute(marker, 'true');
      }, targetDownloadMarker);
    }
    const control = rowIndex === undefined
      ? assistant.locator('button.behavior-btn').nth(discovered.uniqueTargets[targetIndex].occurrenceIndex)
      : assistant.locator('[' + targetDownloadMarker + '="true"]');
    if (await control.count() !== 1 || !(await control.isVisible())) {
      throw new Error('page contract drift: mapped artifact download control is not unique and visible');
    }
    let capturedDownload;
    const downloadPromise = page.waitForEvent('download', { timeout: remaining() }).then((download) => {
      capturedDownload = download;
      return download;
    });
    if (rowIndex !== undefined) {
      await control.click({ force: true, timeout: remaining() });
    } else {
      while (capturedDownload === undefined) {
        await control.click({ force: true, timeout: remaining() });
        await Promise.race([downloadPromise, page.waitForTimeout(Math.min(1000, remaining()))]);
      }
    }
    const download = await downloadPromise;
    await download.saveAs(temporaryPath);
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'artifact-download',
      sourceUrl: targetSourceUrl,
      suggestedFilename: download.suggestedFilename(),
      downloadUrl: download.url(),
    });
  }`;
}

/**
 * Builds the canonical conversation recovery verification for a rebuilt task session.
 *
 * @param canonicalUrl Recorded canonical conversation URL.
 * @param expectedConversationId Database-bound canonical identity.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function recoverConversationScript(canonicalUrl: string, expectedConversationId: string): string {
  return `async (page) => {
    const conversationId = ${JSON.stringify(expectedConversationId)};
    const canonicalUrl = ${JSON.stringify(canonicalUrl)};
    const conversationIdOf = (pathname) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
      return match === null || match[1].startsWith('WEB:') ? null : match[1];
    };
    await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((id) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(location.pathname);
      return (
        location.hostname === 'chatgpt.com' &&
        match !== null && !match[1].startsWith('WEB:') && match[1] === id &&
        document.querySelector('[data-testid^="conversation-turn-"][data-turn]') !== null
      );
    }, conversationId, { timeout: 60000, polling: 100 });
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    if (url.hostname !== 'chatgpt.com' || conversationIdOf(url.pathname) !== conversationId) {
      throw new Error('conversation identity does not match the recorded canonical URL');
    }
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'recover-conversation',
      conversationId,
      conversationUrl: url.origin + url.pathname,
    });
  }`;
}

/**
 * Builds the read-only archive-state observation for the target conversation.
 *
 * @param canonicalUrl Recorded canonical conversation URL.
 * @param expectedConversationId Database-bound canonical identity.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function observeArchiveScript(canonicalUrl: string, expectedConversationId: string): string {
  return `async (page) => {
    const conversationId = ${JSON.stringify(expectedConversationId)};
    const canonicalUrl = ${JSON.stringify(canonicalUrl)};
    const conversationIdOf = (pathname) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
      return match === null || match[1].startsWith('WEB:') ? null : match[1];
    };
    try {
      await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((id) => {
        const match = /\\/c\\/([^/?#]+)\\/?$/.exec(location.pathname);
        return location.hostname === 'chatgpt.com' &&
          match !== null && !match[1].startsWith('WEB:') && match[1] === id;
      }, conversationId, { timeout: 60000, polling: 100 });
    } catch {
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'observe-archive',
        status: 'unknown',
        error: 'the target conversation page could not be re-observed',
      });
    }
    const sidebarLink = await page.locator('a[href="/c/' + conversationId + '"]').count();
    if (sidebarLink === 1) {
      return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'observe-archive', status: 'not-archived' });
    }
    if (sidebarLink === 0) {
      return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'observe-archive', status: 'archived' });
    }
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'observe-archive',
      status: 'unknown',
      error: 'the sidebar archive link is not unique',
    });
  }`;
}

/**
 * Builds the automatic submission verification from the current page state.
 *
 * @param expectedConversationId Bound conversation, or null before binding.
 * @param expectedProjectIdentity Project identity recorded by the start operation, or null when unknown.
 * @param previousUserTurnIdentity Anchor of the previous completed turn, or null for a first turn.
 * @param prompt Saved prompt text for verbatim user-turn matching.
 * @param attachmentNames Ordered saved attachment basenames.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function autoVerifySubmissionScript(
  expectedConversationId: string | null,
  expectedProjectIdentity: string | null,
  previousUserTurnIdentity: string | null,
  prompt: string,
  attachmentNames: readonly string[],
): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const expectedProjectIdentity = ${JSON.stringify(expectedProjectIdentity)};
    const previousUserTurnIdentity = ${JSON.stringify(previousUserTurnIdentity)};
    const prompt = ${JSON.stringify(prompt)};
    const attachmentNames = ${JSON.stringify(attachmentNames)};
    const conversationIdOf = (pathname) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
      return match === null || match[1].startsWith('WEB:') ? null : match[1];
    };
    const projectIdOf = (pathname) => {
      const match = /\\/g\\/g-p-([^/]+?)(?:-chatgpt-pro-collab)?\\/c\\//.exec(pathname);
      return match === null || match[1] === undefined ? null : match[1];
    };
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    if (url.hostname !== 'chatgpt.com') {
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'auto-verify-submission',
        status: 'unresolved',
        error: 'the current page is not on chatgpt.com',
      });
    }
    const conversationId = conversationIdOf(url.pathname);
    if (conversationId === null) {
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'auto-verify-submission',
        status: 'unresolved',
        error: 'the current page is not a canonical conversation',
      });
    }
    if (expectedConversationId !== null && conversationId !== expectedConversationId) {
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'auto-verify-submission',
        status: 'unresolved',
        error: 'the current conversation differs from the bound task',
      });
    }
    const projectId = projectIdOf(url.pathname);
    if (projectId === null) {
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'auto-verify-submission',
        status: 'unresolved',
        error: 'the current page is not project-scoped and cannot prove membership',
      });
    }
    if (expectedProjectIdentity !== null && projectId !== expectedProjectIdentity) {
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'auto-verify-submission',
        status: 'unresolved',
        error: 'the current conversation is not inside the fixed chatgpt-pro-collab Project',
      });
    }
    if (previousUserTurnIdentity !== null) {
      await page.waitForFunction((anchorId) => {
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        return [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')].filter(isVisible).some(
          (element) => element.getAttribute('data-testid') === anchorId,
        );
      }, previousUserTurnIdentity, { timeout: 60000, polling: 100 });
    } else {
      await page.waitForFunction(() => {
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        return [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')].filter(isVisible).length > 0;
      }, undefined, { timeout: 60000, polling: 100 });
    }
    const turnState = await page.evaluate(({ previous, expectedPrompt, names }) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };${USER_TURN_EVIDENCE}
      const elements = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')].filter(visible);
      let anchorIndex = -1;
      if (previous !== null) {
        const matches = elements.flatMap((element, index) => {
          return element.getAttribute('data-testid') === previous ? [index] : [];
        });
        if (matches.length !== 1) {
          return { status: 'drift', reason: 'previous user turn anchor is absent or not unique' };
        }
        anchorIndex = matches[0];
      } else {
        const firstUserIndex = elements.findIndex((element) => element.getAttribute('data-turn') === 'user');
        if (firstUserIndex < 0) {
          return { status: 'none', count: 0 };
        }
        anchorIndex = firstUserIndex - 1;
      }
      const candidates = [];
      for (let index = anchorIndex + 1; index < elements.length; index += 1) {
        if (elements[index].getAttribute('data-turn') !== 'user') continue;
        if (previous === null && index !== anchorIndex + 1) continue;
        if (!readUserTurnEvidence(elements[index], expectedPrompt, names)) continue;
        candidates.push({ identity: elements[index].getAttribute('data-testid') });
      }
      if (candidates.length !== 1) {
        return { status: candidates.length === 0 ? 'none' : 'multiple', count: candidates.length };
      }
      return { status: 'unique', identity: candidates[0].identity };
    }, { previous: previousUserTurnIdentity, expectedPrompt: prompt, names: attachmentNames });
    if (turnState.status === 'drift') {
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'auto-verify-submission',
        status: 'unresolved',
        error: turnState.reason,
      });
    }
    if (turnState.status !== 'unique' || turnState.identity === null) {
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'auto-verify-submission',
        status: 'unresolved',
        error: 'zero or multiple matching user turns after the recorded anchor',
      });
    }
    const finalUrl = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    if (
      finalUrl.hostname !== 'chatgpt.com' ||
      conversationIdOf(finalUrl.pathname) !== conversationId ||
      projectIdOf(finalUrl.pathname) !== projectId
    ) {
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'auto-verify-submission',
        status: 'unresolved',
        error: 'conversation identity changed while verifying the submission',
      });
    }
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'auto-verify-submission',
      status: 'submitted',
      conversationId: conversationIdOf(finalUrl.pathname),
      conversationUrl: finalUrl.origin + finalUrl.pathname,
      userTurnIdentity: turnState.identity,
    });
  }`;
}

/**
 * Builds the human `submitted` adjudication verification against the live conversation.
 *
 * @param canonicalUrl Canonical conversation URL supplied by the user.
 * @param expectedConversationId Database-bound identity, or null before binding.
 * @param expectedProjectIdentity Project identity recorded by the start operation, or null when unknown.
 * @param previousUserTurnIdentity Anchor identity, or null for a first turn.
 * @param prompt Saved prompt text for verbatim user-turn matching.
 * @param attachmentNames Ordered saved attachment basenames.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function resolveSubmittedScript(
  canonicalUrl: string,
  expectedConversationId: string | null,
  expectedProjectIdentity: string | null,
  previousUserTurnIdentity: string | null,
  prompt: string,
  attachmentNames: readonly string[],
): string {
  return `async (page) => {
    const canonicalUrl = ${JSON.stringify(canonicalUrl)};
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const expectedProjectIdentity = ${JSON.stringify(expectedProjectIdentity)};
    const previousUserTurnIdentity = ${JSON.stringify(previousUserTurnIdentity)};
    const prompt = ${JSON.stringify(prompt)};
    const attachmentNames = ${JSON.stringify(attachmentNames)};
    const conversationIdOf = (pathname) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
      return match === null || match[1].startsWith('WEB:') ? null : match[1];
    };
    const projectIdOf = (pathname) => {
      const match = /\\/g\\/g-p-([^/]+?)(?:-chatgpt-pro-collab)?\\/c\\//.exec(pathname);
      return match === null || match[1] === undefined ? null : match[1];
    };
    await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(({ id, projectId }) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(location.pathname);
      const projectMatch = /\\/g\\/g-p-([^/]+?)(?:-chatgpt-pro-collab)?\\/c\\//.exec(location.pathname);
      const conversationOk =
        location.hostname === 'chatgpt.com' &&
        match !== null && !match[1].startsWith('WEB:') && (id === null || match[1] === id);
      if (!conversationOk) return false;
      if (projectId === null) return projectMatch !== null;
      return projectMatch !== null && projectMatch[1] === projectId;
    }, { id: expectedConversationId, projectId: expectedProjectIdentity }, { timeout: 60000, polling: 100 });
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    if (url.hostname !== 'chatgpt.com') {
      throw new Error('submitted adjudication URL is not on chatgpt.com');
    }
    const conversationId = conversationIdOf(url.pathname);
    if (conversationId === null) {
      throw new Error('submitted adjudication URL does not identify a canonical conversation');
    }
    if (expectedConversationId !== null && conversationId !== expectedConversationId) {
      throw new Error('submitted adjudication conversation differs from the bound task');
    }
    const projectId = projectIdOf(url.pathname);
    if (projectId === null) {
      throw new Error('submitted adjudication URL is not project-scoped and cannot prove Project membership');
    }
    if (expectedProjectIdentity !== null && projectId !== expectedProjectIdentity) {
      throw new Error('submitted adjudication conversation is not inside the fixed chatgpt-pro-collab Project');
    }
    if (expectedProjectIdentity === null) {
      await page.waitForFunction((target) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        const main = document.querySelector('main') ?? document.querySelector('[role="main"]');
        return main !== null && [...main.querySelectorAll('*')].some((element) => {
          return visible(element) && element.children.length === 0 && element.textContent.trim() === target;
        });
      }, 'chatgpt-pro-collab', { timeout: 60000, polling: 250 });
    }
    if (previousUserTurnIdentity !== null) {
      await page.waitForFunction((anchorId) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        return [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')].filter(visible).some(
          (element) => element.getAttribute('data-testid') === anchorId,
        );
      }, previousUserTurnIdentity, { timeout: 60000, polling: 100 });
    } else {
      await page.waitForFunction(() => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        return [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')].filter(visible).length > 0;
      }, undefined, { timeout: 60000, polling: 100 });
    }
    const turnState = await page.evaluate(({ previous, expectedPrompt, names }) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };${USER_TURN_EVIDENCE}
      const elements = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')].filter(visible);
      let anchorIndex = -1;
      if (previous !== null) {
        const matches = elements.flatMap((element, index) => {
          return element.getAttribute('data-testid') === previous ? [index] : [];
        });
        if (matches.length !== 1) {
          return { status: 'drift', reason: 'previous user turn anchor is absent or not unique' };
        }
        anchorIndex = matches[0];
      } else {
        const firstUserIndex = elements.findIndex((element) => element.getAttribute('data-turn') === 'user');
        if (firstUserIndex < 0) {
          return { status: 'none', count: 0 };
        }
        anchorIndex = firstUserIndex - 1;
      }
      const candidates = [];
      for (let index = anchorIndex + 1; index < elements.length; index += 1) {
        if (elements[index].getAttribute('data-turn') !== 'user') continue;
        if (previous === null && index !== anchorIndex + 1) continue;
        if (!readUserTurnEvidence(elements[index], expectedPrompt, names)) continue;
        candidates.push({ index, identity: elements[index].getAttribute('data-testid') });
      }
      if (candidates.length !== 1) {
        return { status: candidates.length === 0 ? 'none' : 'multiple', count: candidates.length };
      }
      return { status: 'unique', identity: candidates[0].identity };
    }, { previous: previousUserTurnIdentity, expectedPrompt: prompt, names: attachmentNames });
    if (turnState.status === 'drift') throw new Error(turnState.reason);
    if (turnState.status !== 'unique' || turnState.identity === null) {
      throw new Error(
        'submitted adjudication requires exactly one matching user turn after the recorded anchor',
      );
    }
    const finalUrl = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    if (finalUrl.hostname !== 'chatgpt.com' || conversationIdOf(finalUrl.pathname) !== conversationId) {
      throw new Error('conversation identity changed while resolving the submission');
    }
    if (expectedProjectIdentity !== null && projectIdOf(finalUrl.pathname) !== expectedProjectIdentity) {
      throw new Error('conversation Project membership changed while resolving the submission');
    }
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'resolve-submitted',
      conversationId,
      conversationUrl: finalUrl.origin + finalUrl.pathname,
      userTurnIdentity: turnState.identity,
    });
  }`;
}

/**
 * Builds the human `not-submitted` adjudication verification of a safe composer.
 *
 * @param expectedConversationId Bound conversation, or null before binding.
 * @param expectedProjectIdentity Project identity recorded by the start operation, or null when unknown.
 * @param previousUserTurnIdentity Anchor identity, or null for a first turn.
 * @param prompt Saved prompt text that must not match any post-anchor user turn.
 * @param attachmentNames Ordered saved attachment basenames.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function resolveNotSubmittedScript(
  expectedConversationId: string | null,
  expectedProjectIdentity: string | null,
  previousUserTurnIdentity: string | null,
  prompt: string,
  attachmentNames: readonly string[],
): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const expectedProjectIdentity = ${JSON.stringify(expectedProjectIdentity)};
    const previousUserTurnIdentity = ${JSON.stringify(previousUserTurnIdentity)};
    const prompt = ${JSON.stringify(prompt)};
    const attachmentNames = ${JSON.stringify(attachmentNames)};
    const verifyComposerResidueFree = async () => {
      const composer = page.locator('#prompt-textarea');
      await composer.waitFor({ state: 'visible', timeout: 60000 });
      if (await composer.count() !== 1) throw new Error('page contract drift: composer is not unique');
      const composerForm = page.locator('form').filter({ has: composer });
      if (await composerForm.count() !== 1) throw new Error('page contract drift: composer form is not unique');
      const composerText = await composer.evaluateAll((elements) => {
        return elements.filter((element) => element instanceof HTMLElement).map((element) => {
          return (element.textContent || '').trim();
        });
      });
      if (composerText.length !== 1 || composerText[0] !== '') {
        throw new Error('composer still contains draft text after not-submitted adjudication');
      }
      const populatedFileInputCount = await composerForm.locator('input[type="file"]').evaluateAll((elements) => {
        return elements.filter((element) => element instanceof HTMLInputElement && element.value !== '').length;
      });
      if (populatedFileInputCount !== 0) {
        throw new Error('composer still has a populated file input after not-submitted adjudication');
      }
      const visibleAttachmentControlCount = await composerForm.locator('*').evaluateAll((elements) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        const isAttachmentControl = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const ariaLabel = typeof element.getAttribute === 'function' ? element.getAttribute('aria-label') || '' : '';
          const testId = typeof element.getAttribute === 'function' ? element.getAttribute('data-testid') || '' : '';
          const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
          return (
            (tagName === 'BUTTON' && /remove|delete/i.test(ariaLabel)) ||
            /file|attachment|composer-file/i.test(testId)
          );
        };
        return elements.filter((element) => visible(element) && isAttachmentControl(element)).length;
      });
      if (visibleAttachmentControlCount !== 0) {
        throw new Error('composer still shows staged attachment chips after not-submitted adjudication');
      }
    };
    if (expectedConversationId === null) {
      await page.waitForFunction((identity) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        const projectPathOk = (expectedIdentity) => {
          if (expectedIdentity !== null) {
            return location.pathname === '/g/g-p-' + expectedIdentity + '/project';
          }
          return /^\\/g\\/g-p-[^/]+\\/project$/.test(location.pathname);
        };
        const urlOk = projectPathOk(identity);
        const main = document.querySelector('main') ?? document.querySelector('[role="main"]');
        const titleOk = main !== null && [...main.querySelectorAll('h1')].some((element) => {
          return element instanceof HTMLElement && element.getClientRects().length > 0 &&
            element.textContent.trim() === 'chatgpt-pro-collab';
        });
        const composers = [...document.querySelectorAll('#prompt-textarea')].filter(visible);
        const composerOk = composers.length === 1 && (composers[0].textContent || '').trim() === '';
        const turnsOk = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')]
          .filter(visible).length === 0;
        return urlOk && titleOk && composerOk && turnsOk;
      }, expectedProjectIdentity, { timeout: 60000, polling: 250 });
      await verifyComposerResidueFree();
      const stop = page.getByRole('button', { name: 'Stop answering', exact: true });
      if (await stop.count() > 0 && await stop.first().isVisible()) {
        throw new Error('not-submitted adjudication found an in-flight submission state');
      }
    } else {
      const conversationIdOf = (pathname) => {
        const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
        return match === null || match[1].startsWith('WEB:') ? null : match[1];
      };
      await page.waitForFunction((id) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };
        const match = /\\/c\\/([^/?#]+)\\/?$/.exec(location.pathname);
        return location.hostname === 'chatgpt.com' &&
          match !== null && !match[1].startsWith('WEB:') && match[1] === id &&
          [...document.querySelectorAll('#prompt-textarea')].filter(visible).length === 1;
      }, expectedConversationId, { timeout: 60000, polling: 250 });
      const state = await page.evaluate(({ previous, expectedPrompt, names }) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
        };${USER_TURN_EVIDENCE}
        const elements = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')]
          .filter(visible);
        let anchorIndex = -1;
        if (previous !== null) {
          const matches = elements.flatMap((element, index) => {
            return element.getAttribute('data-testid') === previous ? [index] : [];
          });
          if (matches.length !== 1) {
            return { status: 'drift', reason: 'previous user turn anchor is absent or not unique' };
          }
          anchorIndex = matches[0];
        } else {
          const firstUserIndex = elements.findIndex((element) => element.getAttribute('data-turn') === 'user');
          if (firstUserIndex < 0) {
            return { status: 'safe' };
          }
          anchorIndex = firstUserIndex - 1;
        }
        for (let index = anchorIndex + 1; index < elements.length; index += 1) {
          if (elements[index].getAttribute('data-turn') !== 'user') continue;
          if (previous === null && index !== anchorIndex + 1) continue;
          if (!readUserTurnEvidence(elements[index], expectedPrompt, names)) continue;
          return { status: 'matching' };
        }
        return { status: 'safe' };
      }, { previous: previousUserTurnIdentity, expectedPrompt: prompt, names: attachmentNames });
      if (state.status === 'drift') throw new Error(state.reason);
      if (state.status === 'matching') {
        throw new Error('not-submitted adjudication found a matching submitted user turn after the anchor');
      }
      await verifyComposerResidueFree();
      const stop = page.getByRole('button', { name: 'Stop answering', exact: true });
      if (await stop.count() > 0 && await stop.first().isVisible()) {
        throw new Error('not-submitted adjudication found an in-flight submission state');
      }
    }
    return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'resolve-not-submitted' });
  }`;
}

/**
 * Builds the failed-response adjudication verification for a pending bound turn.
 *
 * The page function proves the canonical conversation, the unique persisted target
 * user turn, the absence of any later user turn, and a safe empty composer. When the
 * exact `Stop answering` control is still visible it is clicked exactly once and the
 * function only succeeds after the control disappears; otherwise it is reported as
 * absent. Every failure keeps the pending turn untouched.
 *
 * @param expectedConversationId Database-bound canonical identity.
 * @param expectedUserTurnId Persisted exact identity of the target user turn.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function resolveFailedTurnScript(expectedConversationId: string, expectedUserTurnId: string): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const expectedUserTurnId = ${JSON.stringify(expectedUserTurnId)};
    const conversationIdOf = (pathname) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
      return match === null || match[1].startsWith('WEB:') ? null : match[1];
    };
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
    };
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    if (url.hostname !== 'chatgpt.com' || conversationIdOf(url.pathname) !== expectedConversationId) {
      throw new Error('conversation identity does not match the failed-response turn');
    }
    await page.waitForFunction((targetId) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      return [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn="user"]')]
        .filter(visible)
        .filter((element) => element.getAttribute('data-testid') === targetId).length >= 1;
    }, expectedUserTurnId, { timeout: 60000, polling: 100 });
    const turnState = await page.evaluate((targetId) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const elements = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')].filter(visible);
      const targetIndices = elements.flatMap((element, index) => {
        return element.getAttribute('data-turn') === 'user' && element.getAttribute('data-testid') === targetId
          ? [index]
          : [];
      });
      if (targetIndices.length !== 1) {
        return { status: 'drift', reason: 'target user turn is absent or not unique' };
      }
      const targetIndex = targetIndices[0];
      for (let index = targetIndex + 1; index < elements.length; index += 1) {
        if (elements[index].getAttribute('data-turn') === 'user') {
          return { status: 'drift', reason: 'a later user turn exists after the target' };
        }
      }
      return { status: 'ok', identity: elements[targetIndex].getAttribute('data-testid') };
    }, expectedUserTurnId);
    if (turnState.status === 'drift') throw new Error(turnState.reason);
    if (turnState.status !== 'ok' || turnState.identity !== expectedUserTurnId) {
      throw new Error('target user turn identity drifted while resolving the failed response');
    }
    const composer = page.locator('#prompt-textarea');
    await composer.waitFor({ state: 'visible', timeout: 60000 });
    if (await composer.count() !== 1 || !(await composer.isVisible())) {
      throw new Error('page contract drift: composer is not unique and visible');
    }
    const composerText = await composer.evaluateAll((elements) => {
      return elements
        .filter((element) => element instanceof HTMLElement)
        .map((element) => (element.textContent || '').trim());
    });
    if (composerText.length !== 1 || composerText[0] !== '') {
      throw new Error('composer still contains draft text before failed-response resolution');
    }
    const composerForm = page.locator('form').filter({ has: composer });
    if (await composerForm.count() !== 1) {
      throw new Error('page contract drift: composer form is not unique');
    }
    const populatedFileInputCount = await composerForm.locator('input[type="file"]').evaluateAll((elements) => {
      return elements.filter((element) => element instanceof HTMLInputElement && element.value !== '').length;
    });
    if (populatedFileInputCount !== 0) {
      throw new Error('composer still has a populated file input before failed-response resolution');
    }
    const visibleAttachmentControlCount = await composerForm.locator('*').evaluateAll((elements) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const isAttachmentControl = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const ariaLabel = typeof element.getAttribute === 'function' ? element.getAttribute('aria-label') || '' : '';
        const testId = typeof element.getAttribute === 'function' ? element.getAttribute('data-testid') || '' : '';
        const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
        return (
          (tagName === 'BUTTON' && /remove|delete/i.test(ariaLabel)) ||
          /file|attachment|composer-file/i.test(testId)
        );
      };
      return elements.filter((element) => visible(element) && isAttachmentControl(element)).length;
    });
    if (visibleAttachmentControlCount !== 0) {
      throw new Error('composer still shows staged attachment chips before failed-response resolution');
    }
    const stop = page.getByRole('button', { name: 'Stop answering', exact: true });
    let stopOutcome = 'absent';
    if (await stop.count() > 0 && await stop.first().isVisible()) {
      if (await stop.count() !== 1) {
        throw new Error('page contract drift: Stop answering is not unique');
      }
      await stop.first().click();
      let disappeared = false;
      for (let poll = 0; poll < 60; poll += 1) {
        await page.waitForTimeout(250);
        const stillVisible = await stop.count() > 0 && await stop.first().isVisible();
        if (!stillVisible) {
          disappeared = true;
          break;
        }
      }
      if (!disappeared) {
        throw new Error('Stop answering did not disappear after one click');
      }
      stopOutcome = 'stopped';
    }
    const finalUrl = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    if (finalUrl.hostname !== 'chatgpt.com' || conversationIdOf(finalUrl.pathname) !== expectedConversationId) {
      throw new Error('conversation identity changed while resolving the failed response');
    }
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'resolve-failed-turn',
      conversationId: conversationIdOf(finalUrl.pathname),
      conversationUrl: finalUrl.origin + finalUrl.pathname,
      userTurnIdentity: expectedUserTurnId,
      stop: stopOutcome,
    });
  }`;
}

/**
 * Builds the exact target archive flow and observes its sidebar result after refresh.
 *
 * The conversation identity uses the shared last-`/c/<id>` contract so both plain and
 * project-scoped canonical URLs are accepted; the sidebar link, leave-wait, and restore
 * navigation all use the recorded canonical URL.
 *
 * @param canonicalUrl Recorded canonical conversation URL, plain or project-scoped.
 * @param expectedConversationId Database-bound canonical identity.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function archiveScript(canonicalUrl: string, expectedConversationId: string): string {
  return `async (page) => {
    const conversationId = ${JSON.stringify(expectedConversationId)};
    const canonicalUrl = ${JSON.stringify(canonicalUrl)};
    const canonicalPath = canonicalUrl.replace(/^https?:\\/\\/[^/]+/u, '');
    const sidebarPath = '/c/' + conversationId;
    const conversationIdOf = (pathname) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(pathname);
      return match === null || match[1].startsWith('WEB:') ? null : match[1];
    };
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (url.hostname !== 'chatgpt.com' || conversationIdOf(url.pathname) !== conversationId) {
      throw new Error('conversation identity does not match archive target');
    }
    const targetLink = page.locator('a[href="' + sidebarPath + '"]');
    await targetLink.first().waitFor({ state: 'attached', timeout: 60000 });
    if (await targetLink.count() !== 1) throw new Error('page contract drift: archive target link is not unique');
    const options = page.locator('[data-testid="conversation-options-button"]');
    if (await options.count() !== 1) throw new Error('page contract drift: conversation options is not unique');
    let archive = page.getByRole('menuitem', { name: 'Archive', exact: true });
    if (await archive.count() === 0 || !(await archive.first().isVisible())) {
      await options.click();
      archive = page.getByRole('menuitem', { name: 'Archive', exact: true });
    }
    if (await archive.count() !== 1 || !(await archive.isVisible())) {
      throw new Error('page contract drift: Archive menu item is not unique and visible');
    }
    await archive.click();
    await page.waitForURL((nextUrl) => nextUrl.pathname.replace(/\\/$/, '') !== canonicalPath, { timeout: 60000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const sidebar = page.locator('nav').first();
    await sidebar.waitFor({ state: 'visible', timeout: 60000 });
    let absentPolls = 0;
    let verificationPolls = 0;
    while (absentPolls < 6 && verificationPolls < 120) {
      verificationPolls += 1;
      if (await targetLink.count() === 0) absentPolls += 1;
      else absentPolls = 0;
      if (absentPolls < 6) await page.waitForTimeout(500);
    }
    if (absentPolls < 6) throw new Error('archive was not visible after sidebar refresh');
    await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((id) => {
      const match = /\\/c\\/([^/?#]+)\\/?$/.exec(location.pathname);
      const identity = match === null || match[1].startsWith('WEB:') ? null : match[1];
      return (
        location.hostname === 'chatgpt.com' &&
        identity === id &&
        document.querySelector('[data-testid^="conversation-turn-"][data-turn]') !== null
      );
    }, conversationId, { timeout: 60000, polling: 100 });
    const finalRestoredUrl = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (finalRestoredUrl.hostname !== 'chatgpt.com' || conversationIdOf(finalRestoredUrl.pathname) !== conversationId) {
      throw new Error('conversation identity changed while restoring the archived task page');
    }
    return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'archive', conversationId });
  }`;
}

/**
 * Checks a completed transcript path without following non-file directory entries.
 *
 * @param path Absolute path that must be a readable regular file.
 * @returns True only for an existing regular file.
 * @throws {Error} This probe does not throw for ordinary absence.
 */
/**
 * Classifies a start failure whose outcome is definite rather than effect-unknown.
 *
 * @param error Unknown thrown value.
 * @returns `true` only for definite page-verdict failures that must close the task session.
 */
function isDefiniteStartFailure(error: unknown): boolean {
  return (
    error instanceof BrowserError &&
    [
      'PROJECT_NOT_FOUND',
      'PROJECT_NOT_UNIQUE',
      'FIXED_TARGET_UNAVAILABLE',
      'SELECTION_UNCONFIRMED',
      'PAGE_CONTRACT_DRIFT',
    ].includes(error.code)
  );
}

function isReadableFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/**
 * Extracts a stable message without discarding non-Error process failures.
 *
 * @param error Unknown thrown value.
 * @returns A human-readable failure message.
 * @throws {Error} This formatter does not throw for ordinary JavaScript values.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
