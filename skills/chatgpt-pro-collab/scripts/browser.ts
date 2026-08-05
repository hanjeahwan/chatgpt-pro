import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { CollabPaths } from './session.ts';
import { ensureTaskDirectories, savePlaywrightScript, taskDirectory } from './session.ts';

const PLAYWRIGHT_CLI_PACKAGE = '@playwright/cli@0.1.17';
const CHATGPT_URL = 'https://chatgpt.com/';
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
  readonly persistent: false;
}

export type BrowserSendResult =
  | {
      readonly status: 'submitted';
      readonly conversationId: string;
      readonly conversationUrl: string;
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
      await this.#invoke(
        sessionName,
        setupId,
        ['open', CHATGPT_URL, '--browser=chrome', '--headed'],
        'open setup browser',
      );
      await this.#runCodeWithoutResult(
        sessionName,
        setupId,
        'await-login',
        loginWaitScript(),
        'wait for interactive login',
      );
      await this.#invoke(sessionName, setupId, ['state-save', this.#paths.seedState], 'save authentication state');
    } catch (error) {
      primaryFailure = error;
    }

    try {
      await this.#invoke(sessionName, setupId, ['close'], 'close setup browser');
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
   * Starts one isolated headed session from the shared read-only authentication seed.
   *
   * @param taskId Unique task identifier and local session directory name.
   * @param sessionName Unique Playwright named session.
   * @param seedStatePath Readable setup state loaded but never saved by the task.
   * @returns PID reported by Playwright plus observed page and context identity.
   * @throws {BrowserError} If the browser cannot start or the authenticated page is not observed.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async startTask(taskId: string, sessionName: string, seedStatePath: string): Promise<BrowserSessionInfo> {
    await ensureTaskDirectories(this.#paths, taskId);
    const contextMarker = randomUUID();
    let opened = false;
    try {
      const openOutput = await this.#invoke(
        sessionName,
        taskId,
        ['open', 'about:blank', '--browser=chrome', '--headed'],
        'open task browser',
      );
      opened = true;
      const pid = parseOpenPid(openOutput.stdout, sessionName);
      await this.#invoke(sessionName, taskId, ['state-load', seedStatePath], 'load authentication state');
      await this.#invoke(sessionName, taskId, ['goto', CHATGPT_URL], 'open ChatGPT');
      const result = await this.#runCode<StartProtocolResult>(
        sessionName,
        taskId,
        'verify-start',
        startVerificationScript(contextMarker),
        'verify authenticated task page',
        'start',
      );
      return { pid, url: result.url, contextMarker: result.contextMarker, persistent: false };
    } catch (error) {
      if (opened) {
        try {
          await this.#invoke(sessionName, taskId, ['close'], 'close failed task browser');
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
        await this.#runCode<UploadReadyProtocolResult>(
          sessionName,
          taskId,
          'prepare-upload',
          uploadPreparationScript(expectedConversationId),
          'open attachment file chooser',
          'upload-ready',
          observer,
        );
        await this.#invoke(
          sessionName,
          taskId,
          ['upload', attachmentPath],
          `upload attachment ${attachmentPath}`,
          observer,
        );
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
      return {
        status: 'submitted',
        conversationId: result.conversationId,
        conversationUrl: result.conversationUrl,
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
   * Polls once for the completed assistant turn after the latest user turn.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param expectedConversationId Database-bound conversation identity.
   * @param observationWindowMs Remaining finite observation budget.
   * @param observer Task-lease child-process observer.
   * @returns Pending, or the re-observed completed conversation identity.
   * @throws {BrowserError} If the session exits or the page contract cannot be verified.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async observeResponse(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    observationWindowMs: number,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserObservationResult> {
    const result = await this.#runCode<ObservationProtocolResult>(
      sessionName,
      taskId,
      'observe-response',
      observationScript(expectedConversationId, observationWindowMs),
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
   * @param observer Task-lease child-process observer.
   * @returns The confirmed archived conversation identity.
   * @throws {BrowserError} If selectors drift, the target differs, or archive cannot be observed.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async archive(
    taskId: string,
    sessionName: string,
    conversationId: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly conversationId: string }> {
    const result = await this.#runCode<ArchiveProtocolResult>(
      sessionName,
      taskId,
      'archive',
      archiveScript(conversationId),
      'archive conversation',
      'archive',
      observer,
    );
    return { conversationId: result.conversationId };
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
 * Preserves the fixed CLI's page-script error without returning unrelated snapshots.
 *
 * @param stdout Complete `run-code` output whose envelope was absent.
 * @returns Bounded error detail for the browser boundary.
 * @throws {Error} This pure formatter does not throw.
 */
function protocolFailureDetail(stdout: string): string {
  const marker = stdout.lastIndexOf('### Error');
  if (marker < 0) {
    return 'protocol envelope was not present';
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
 * Builds the authenticated task check and installs an in-memory context marker.
 *
 * @param contextMarker Host-generated identity unique to this task.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function startVerificationScript(contextMarker: string): string {
  return `async (page) => {
    const contextMarker = ${JSON.stringify(contextMarker)};
    await page.waitForFunction(() => {
      const composer = document.querySelector('#prompt-textarea');
      if (!(composer instanceof HTMLElement) || composer.getClientRects().length === 0) return false;
      const authControls = [...document.querySelectorAll('a, button')].filter((element) => {
        const label = (element.textContent || '').trim();
        const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') || '' : '';
        return (label === 'Log in' || label === 'Sign up' || href.includes('/auth/login')) &&
          element instanceof HTMLElement && element.getClientRects().length > 0;
      });
      return authControls.length === 0;
    }, undefined, { timeout: 60000, polling: 250 });
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, href: location.href };
    });
    if (url.hostname !== 'chatgpt.com' || url.pathname !== '/') {
      throw new Error('page contract drift: new conversation root was not observed');
    }
    await page.evaluate((marker) => {
      sessionStorage.setItem('chatgpt-pro-collab-context-id', marker);
    }, contextMarker);
    const observedContextMarker = await page.evaluate(() => {
      return sessionStorage.getItem('chatgpt-pro-collab-context-id');
    });
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'start',
      url: page.url(),
      contextMarker: observedContextMarker,
    });
  }`;
}

/**
 * Builds the pre-upload conversation and composer identity gate.
 *
 * @param expectedConversationId Existing bound conversation, or null for a new task.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function sendTargetVerificationScript(expectedConversationId: string | null): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    const targetPath = expectedConversationId === null ? '/' : '/c/' + expectedConversationId;
    if (url.hostname !== 'chatgpt.com' || url.pathname.replace(/\\/$/, '') !== targetPath.replace(/\\/$/, '')) {
      throw new Error('conversation identity does not match the send target');
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
    if (
      readyUrl.hostname !== 'chatgpt.com' ||
      readyUrl.pathname.replace(/\\/$/, '') !== targetPath.replace(/\\/$/, '')
    ) {
      throw new Error('conversation identity changed while making the send target writable');
    }
    return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'send-ready' });
  }`;
}

/**
 * Builds a reload-based cleanup for any attachment chooser or draft changed before submission.
 *
 * @param expectedConversationId Existing bound conversation, or null for a new task.
 * @param attachmentFileNames Basenames that must disappear from the composer after reload.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function clearUploadDraftScript(expectedConversationId: string | null, attachmentFileNames: readonly string[]): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
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
    const targetPath = expectedConversationId === null ? '/' : '/c/' + expectedConversationId;
    if (url.hostname !== 'chatgpt.com' || url.pathname.replace(/\\/$/, '') !== targetPath.replace(/\\/$/, '')) {
      throw new Error('conversation identity changed while clearing attachment draft');
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
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    const targetPath = expectedConversationId === null ? '/' : '/c/' + expectedConversationId;
    if (url.hostname !== 'chatgpt.com' || url.pathname.replace(/\\/$/, '') !== targetPath.replace(/\\/$/, '')) {
      throw new Error('conversation identity changed before attachment preparation');
    }
    const plus = page.locator('[data-testid="composer-plus-btn"]');
    if (await plus.count() !== 1) throw new Error('page contract drift: composer plus button is not unique');
    await plus.click();
    const upload = page.getByText('Add photos & files', { exact: true });
    await upload.waitFor({ state: 'visible', timeout: 10000 });
    if (await upload.count() !== 1) throw new Error('page contract drift: upload action is not unique');
    await upload.click();
    return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'upload-ready' });
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
      const expectedConversationId = ${JSON.stringify(expectedConversationId)};
      const initialUrl = await page.evaluate(() => {
        return { hostname: location.hostname, pathname: location.pathname };
      });
      const targetPath = expectedConversationId === null ? '/' : '/c/' + expectedConversationId;
      if (
        initialUrl.hostname !== 'chatgpt.com' ||
        initialUrl.pathname.replace(/\\/$/, '') !== targetPath.replace(/\\/$/, '')
      ) {
        throw new Error('conversation identity changed before prompt submission');
      }
      const composer = page.locator('#prompt-textarea');
      const send = page.locator('[data-testid="send-button"]');
      const turns = page.locator('[data-testid^="conversation-turn-"][data-turn]');
      if (await composer.count() !== 1) throw new Error('page contract drift: composer is not unique');
      if (await send.count() !== 1) throw new Error('page contract drift: send button is not unique');
      const userCount = await turns.evaluateAll((elements) => {
        return elements.filter((element) => element.getAttribute('data-turn') === 'user').length;
      });
      await composer.fill(${JSON.stringify(prompt)});
      clicked = true;
      await send.click();
      await page.waitForFunction((previousCount) => {
        const elements = [...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn]')];
        return elements.filter((element) => element.getAttribute('data-turn') === 'user').length > previousCount;
      }, userCount, { timeout: 60000, polling: 100 });
      await page.waitForFunction(() => {
        const match = /^\\/c\\/([^/?#]+)\\/?$/.exec(location.pathname);
        return match !== null && !match[1].startsWith('WEB:');
      }, undefined, { timeout: 60000, polling: 100 });
      const url = await page.evaluate(() => {
        return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
      });
      const match = /^\\/c\\/([^/?#]+)\\/?$/.exec(url.pathname);
      if (url.hostname !== 'chatgpt.com' || match === null || match[1].startsWith('WEB:')) {
        throw new Error('page contract drift: canonical conversation URL was not observed');
      }
      if (expectedConversationId !== null && match[1] !== expectedConversationId) {
        throw new Error('submitted conversation identity differs from the bound task');
      }
      return JSON.stringify({
        protocol: '${PROTOCOL}',
        kind: 'send',
        status: 'submitted',
        conversationId: match[1],
        conversationUrl: url.origin + '/c/' + match[1],
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
 * Builds one bounded completion observation for the assistant after the latest user turn.
 *
 * @param expectedConversationId Database-bound canonical identity.
 * @param observationWindowMs Remaining finite observation budget.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function observationScript(expectedConversationId: string, observationWindowMs: number): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const observationWindowMs = ${JSON.stringify(observationWindowMs)};
    const observationDeadline = Date.now() + observationWindowMs;
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname, origin: location.origin };
    });
    const match = /^\\/c\\/([^/?#]+)\\/?$/.exec(url.pathname);
    if (url.hostname !== 'chatgpt.com' || match === null || match[1] !== expectedConversationId) {
      throw new Error('conversation identity does not match the pending turn');
    }
    const turnSelector = '[data-testid^="conversation-turn-"][data-turn]';
    const copySelector = '[data-testid="copy-turn-action-button"]';
    let assistantIndex = -1;
    let assistantTurnId = null;
    let stableCompletedPolls = 0;
    let polls = 0;
    while (stableCompletedPolls < 6 && polls < 10 && Date.now() < observationDeadline) {
      polls += 1;
      const candidate = await page.locator(turnSelector).evaluateAll((elements) => {
        let latestUser = -1;
        for (let index = 0; index < elements.length; index += 1) {
          if (elements[index].getAttribute('data-turn') === 'user') latestUser = index;
        }
        if (latestUser < 0 || latestUser + 1 >= elements.length) return null;
        const assistant = elements[latestUser + 1];
        const turnId = assistant.getAttribute('data-testid');
        if (assistant.getAttribute('data-turn') !== 'assistant' || turnId === null) return null;
        const copy = assistant.querySelectorAll('[data-testid="copy-turn-action-button"]');
        return copy.length === 1 && copy[0] instanceof HTMLElement && copy[0].getClientRects().length > 0
          ? { index: latestUser + 1, turnId }
          : null;
      });
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
    const completedMatch = /^\\/c\\/([^/?#]+)\\/?$/.exec(completedUrl.pathname);
    if (
      completedUrl.hostname !== 'chatgpt.com' ||
      completedMatch === null ||
      completedMatch[1] !== expectedConversationId
    ) {
      throw new Error('conversation identity changed while observing response completion');
    }
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'observe',
      status: 'completed',
      conversationId: completedMatch[1],
      conversationUrl: completedUrl.origin + '/c/' + completedMatch[1],
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
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    const match = /^\\/c\\/([^/?#]+)\\/?$/.exec(url.pathname);
    if (url.hostname !== 'chatgpt.com' || match === null || match[1] !== expectedConversationId) {
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
    const capturedMatch = /^\\/c\\/([^/?#]+)\\/?$/.exec(capturedUrl.pathname);
    if (
      capturedUrl.hostname !== 'chatgpt.com' ||
      capturedMatch === null ||
      capturedMatch[1] !== expectedConversationId
    ) {
      throw new Error('conversation identity changed before response capture completed');
    }
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'capture',
      response: response.plain,
      responseHtml: response.html,
      artifacts,
      conversationId: capturedMatch[1],
      conversationUrl: capturedUrl.origin + '/c/' + capturedMatch[1],
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
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    const match = /^\\/c\\/([^/?#]+)\\/?$/.exec(url.pathname);
    if (url.hostname !== 'chatgpt.com' || match === null || match[1] !== expectedConversationId) {
      throw new Error('conversation identity does not match artifact capture');
    }
    if (refreshControls) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const reloadedUrl = await page.evaluate(() => {
        return { hostname: location.hostname, pathname: location.pathname };
      });
      const reloadedMatch = /^\\/c\\/([^/?#]+)\\/?$/.exec(reloadedUrl.pathname);
      if (
        reloadedUrl.hostname !== 'chatgpt.com' ||
        reloadedMatch === null ||
        reloadedMatch[1] !== expectedConversationId
      ) {
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
        return index >= occurrenceCursor && artifact.basename === candidates[0].basename;
      });
      const matchedArtifact = discovered.occurrences[matchedIndex];
      if (!rowBySourceUrl.has(matchedArtifact.sourceUrl)) {
        rowBySourceUrl.set(matchedArtifact.sourceUrl, rowIndex);
      }
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
 * Builds the exact target archive flow and observes its sidebar result after refresh.
 *
 * @param expectedConversationId Database-bound canonical identity.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function archiveScript(expectedConversationId: string): string {
  return `async (page) => {
    const conversationId = ${JSON.stringify(expectedConversationId)};
    const targetPath = '/c/' + conversationId;
    const url = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (url.hostname !== 'chatgpt.com' || url.pathname.replace(/\\/$/, '') !== targetPath) {
      throw new Error('conversation identity does not match archive target');
    }
    const targetLink = page.locator('a[href="' + targetPath + '"]');
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
    await page.waitForURL((nextUrl) => nextUrl.pathname.replace(/\\/$/, '') !== targetPath, { timeout: 60000 });
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
    await page.goto('https://chatgpt.com' + targetPath, { waitUntil: 'domcontentloaded' });
    const restoredUrl = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (restoredUrl.hostname !== 'chatgpt.com' || restoredUrl.pathname.replace(/\\/$/, '') !== targetPath) {
      throw new Error('archived conversation could not be restored as the task page');
    }
    await page.waitForFunction((path) => {
      return (
        location.hostname === 'chatgpt.com' &&
        location.pathname.replace(/\\/$/, '') === path &&
        document.querySelector('[data-testid^="conversation-turn-"][data-turn]') !== null
      );
    }, targetPath, { timeout: 60000, polling: 100 });
    const finalRestoredUrl = await page.evaluate(() => {
      return { hostname: location.hostname, pathname: location.pathname };
    });
    if (
      finalRestoredUrl.hostname !== 'chatgpt.com' ||
      finalRestoredUrl.pathname.replace(/\\/$/, '') !== targetPath
    ) {
      throw new Error('conversation identity changed while restoring the archived task page');
    }
    return JSON.stringify({ protocol: '${PROTOCOL}', kind: 'archive', conversationId });
  }`;
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
