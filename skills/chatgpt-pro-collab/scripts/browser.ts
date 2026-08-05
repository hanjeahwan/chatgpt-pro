import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
   * The task only succeeds inside the unique existing `chatgpt-pro-collab` Project's
   * blank new-conversation composer after `GPT-5.6 Sol` and `Pro` are selected and read
   * back as `aria-checked=true`. Any missing, non-unique, unconfirmable, or drifting
   * page contract closes the opened session and throws a typed BrowserError.
   *
   * @param taskId Unique task identifier and local session directory name.
   * @param sessionName Unique Playwright named session.
   * @param seedStatePath Readable setup state loaded but never saved by the task.
   * @returns PID reported by Playwright plus observed page and context identity.
   * @throws {BrowserError} If the fixed Project, model, or mode context cannot be confirmed.
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
      await this.#invoke(sessionName, taskId, ['goto', PROJECTS_URL], 'open ChatGPT projects');
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
      );
      const result = parseStartProtocolResult(output.stdout);
      if (result.kind === 'start-failed') {
        throw new BrowserError(result.errorCode, 'start task', result.message);
      }
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
 * Parses the start page envelope, preserving typed failure codes.
 *
 * @param stdout Complete `run-code` output for the start verification script.
 * @returns The success envelope or the typed failure envelope.
 * @throws {BrowserError} If no start envelope is present.
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
        return candidate as StartProtocolResult | StartFailedProtocolResult;
      }
    } catch {
      // CLI wrapper lines are not JSON; only the page result envelope is relevant.
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
    const targetMode = 'Pro';
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
    const selectorControl = page.locator('form button[aria-haspopup="menu"]');
    const menuHasRadios = () => evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      return [...document.querySelectorAll('[role="menuitemradio"]')].filter(visible).length > 0;
    });
    const ensureMenuOpen = async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (await menuHasRadios()) return { status: 'ok' };
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
      return { status: 'drift', reason: 'composer model/mode selector control is not unique or did not open' };
    };

    const readRadio = (target) => evaluate((name) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      const radios = [...document.querySelectorAll('[role="menuitemradio"]')].filter((element) => {
        return visible(element) &&
          (element.getAttribute('aria-label') ?? (element.textContent ?? '').trim()) === name;
      });
      return { count: radios.length, checked: radios.length === 1 && radios[0].getAttribute('aria-checked') === 'true' };
    }, target);

    const waitForRadio = (target) => page.waitForFunction((name) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      return [...document.querySelectorAll('[role="menuitemradio"]')].some((element) => {
        return visible(element) &&
          (element.getAttribute('aria-label') ?? (element.textContent ?? '').trim()) === name;
      });
    }, target, { timeout: 10000, polling: 100 });

    const modelOpener = page.locator('[role="menuitem"][aria-haspopup]');
    const readOpener = () => evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      };
      return [...document.querySelectorAll('[role="menuitem"][aria-haspopup]')].filter(visible).length;
    });

    const ensureModeVisible = async () => {
      const opened = await ensureMenuOpen();
      if (opened.status === 'drift') return opened;
      try {
        await waitForRadio(targetMode);
      } catch {
        return { status: 'unavailable' };
      }
      return { status: 'ok' };
    };
    const ensureModelVisible = async () => {
      const opened = await ensureMenuOpen();
      if (opened.status === 'drift') return opened;
      const current = await readRadio(targetModel);
      if (current.count === 0) {
        if (await readOpener() !== 1) {
          return { status: 'drift', reason: 'model submenu opener is not unique' };
        }
        if (await modelOpener.count() !== 1) {
          return { status: 'drift', reason: 'model submenu opener is not unique' };
        }
        await modelOpener.first().click();
        await page.waitForTimeout(400);
      }
      try {
        await waitForRadio(targetModel);
      } catch {
        return { status: 'unavailable' };
      }
      return { status: 'ok' };
    };

    const confirmRadio = async (target, ensureVisible) => {
      const visibleState = await ensureVisible();
      if (visibleState.status === 'drift') return visibleState;
      if (visibleState.status === 'unavailable') return { status: 'unavailable' };
      const before = await readRadio(target);
      if (before.count !== 1) return { status: 'unavailable', count: before.count };
      if (before.checked) return { status: 'confirmed' };
      const control = page.getByRole('menuitemradio', { name: target, exact: true });
      if (await control.count() !== 1) return { status: 'unavailable' };
      await control.first().click();
      await page.waitForTimeout(400);
      const reopened = await ensureVisible();
      if (reopened.status === 'drift') return reopened;
      if (reopened.status === 'unavailable') return { status: 'unconfirmed' };
      const after = await readRadio(target);
      if (after.count !== 1 || !after.checked) return { status: 'unconfirmed' };
      return { status: 'confirmed' };
    };

    const modeVisible = await ensureModeVisible();
    if (modeVisible.status === 'drift') return fail('PAGE_CONTRACT_DRIFT', modeVisible.reason);
    if (modeVisible.status === 'unavailable') {
      return fail('FIXED_TARGET_UNAVAILABLE', 'fixed mode Pro is not available or not unique as a menuitemradio');
    }
    const modeResult = await confirmRadio(targetMode, ensureModeVisible);
    if (modeResult.status === 'drift') return fail('PAGE_CONTRACT_DRIFT', modeResult.reason);
    if (modeResult.status === 'unavailable') {
      return fail('FIXED_TARGET_UNAVAILABLE', 'fixed mode Pro is not available or not unique as a menuitemradio');
    }
    if (modeResult.status === 'unconfirmed') {
      return fail('SELECTION_UNCONFIRMED', 'fixed mode Pro could not be read back as aria-checked=true');
    }

    const modelVisible = await ensureModelVisible();
    if (modelVisible.status === 'drift') return fail('PAGE_CONTRACT_DRIFT', modelVisible.reason);
    if (modelVisible.status === 'unavailable') {
      return fail('FIXED_TARGET_UNAVAILABLE', 'fixed model GPT-5.6 Sol was not observed in the model submenu');
    }
    const modelResult = await confirmRadio(targetModel, ensureModelVisible);
    if (modelResult.status === 'drift') return fail('PAGE_CONTRACT_DRIFT', modelResult.reason);
    if (modelResult.status === 'unavailable') {
      return fail('FIXED_TARGET_UNAVAILABLE', 'fixed model GPT-5.6 Sol is not available or not unique as a menuitemradio');
    }
    if (modelResult.status === 'unconfirmed') {
      return fail('SELECTION_UNCONFIRMED', 'fixed model GPT-5.6 Sol could not be read back as aria-checked=true');
    }

    const jointReadback = async () => {
      const modeVisible = await ensureModeVisible();
      if (modeVisible.status === 'drift') return modeVisible;
      if (modeVisible.status === 'unavailable') {
        return { status: 'unconfirmed', target: targetMode };
      }
      const modelVisible = await ensureModelVisible();
      if (modelVisible.status === 'drift') return modelVisible;
      if (modelVisible.status === 'unavailable') {
        return { status: 'unconfirmed', target: targetModel };
      }
      const modeState = await readRadio(targetMode);
      if (modeState.count !== 1 || !modeState.checked) {
        return { status: 'unconfirmed', target: targetMode };
      }
      const modelState = await readRadio(targetModel);
      if (modelState.count !== 1 || !modelState.checked) {
        return { status: 'unconfirmed', target: targetModel };
      }
      return { status: 'confirmed' };
    };
    const joint = await jointReadback();
    if (joint.status === 'drift') return fail('PAGE_CONTRACT_DRIFT', joint.reason);
    if (joint.status === 'unconfirmed') {
      const target = joint.target === targetMode ? 'mode Pro' : 'model GPT-5.6 Sol';
      return fail(
        'SELECTION_UNCONFIRMED',
        'fixed ' + target + ' was not jointly read back as a unique aria-checked=true menuitemradio after all selections',
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
      return fail('PAGE_CONTRACT_DRIFT', 'project context drifted during model and mode confirmation');
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
    return JSON.stringify({
      protocol: '${PROTOCOL}',
      kind: 'start',
      url: page.url(),
      contextMarker: observedContextMarker,
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
 * Extracts a stable message without discarding non-Error process failures.
 *
 * @param error Unknown thrown value.
 * @returns A human-readable failure message.
 * @throws {Error} This formatter does not throw for ordinary JavaScript values.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
