import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

import type { CollabPaths } from './session.ts';
import { ensureTaskDirectories, savePlaywrightScript, taskDirectory } from './session.ts';

const PLAYWRIGHT_CLI_PACKAGE = '@playwright/cli@0.1.17';
const CHATGPT_URL = 'https://chatgpt.com/';
const PROTOCOL = 'chatgpt-pro-collab/v1';

export interface BrowserCommandInvocation {
  readonly executable: 'npx';
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly onChildSpawned?: (pid: number) => void;
  readonly onChildExited?: (pid: number) => void;
}

export interface BrowserCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type BrowserCommandRunner = (invocation: BrowserCommandInvocation) => Promise<BrowserCommandOutput>;

export interface BrowserOperationObserver {
  childSpawned(pid: number): void;
  childExited(pid: number): void;
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

export interface BrowserWaitResult {
  readonly response: string;
  readonly conversationId: string;
  readonly conversationUrl: string;
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

interface WaitProtocolResult extends ProtocolResult {
  readonly kind: 'wait';
  readonly response: string;
  readonly conversationId: string;
  readonly conversationUrl: string;
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

    let commandStarted = false;
    try {
      const scriptPath = await savePlaywrightScript(
        this.#paths,
        taskId,
        'send',
        sendScript(expectedConversationId, prompt),
      );
      commandStarted = true;
      const output = await this.#invoke(
        sessionName,
        taskId,
        ['run-code', '--filename', scriptPath],
        'submit prompt',
        observer,
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
      if (!commandStarted && attachmentPreparationStarted) {
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
        status: commandStarted ? 'unknown-submission' : 'not-submitted',
        error: errorMessage(error),
      };
    }
  }

  /**
   * Waits indefinitely for the assistant turn after the latest user turn and captures Copy response.
   *
   * @param taskId Owning task identifier.
   * @param sessionName Owning Playwright named session.
   * @param expectedConversationId Database-bound conversation identity.
   * @param observer Task-lease child-process observer.
   * @returns Exact page-local copied text and the re-observed conversation identity.
   * @throws {BrowserError} If the session exits or the page contract cannot be verified.
   * @throws {Error} If a local Playwright artifact cannot be written.
   */
  async waitForResponse(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserWaitResult> {
    const result = await this.#runCode<WaitProtocolResult>(
      sessionName,
      taskId,
      'wait-response',
      waitScript(expectedConversationId),
      'wait for and copy response',
      'wait',
      observer,
    );
    return {
      response: result.response,
      conversationId: result.conversationId,
      conversationUrl: result.conversationUrl,
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
   * @returns Captured stdout and stderr.
   * @throws {BrowserError} If `npx` exits unsuccessfully or cannot start.
   */
  async #invoke(
    sessionName: string,
    taskId: string,
    command: readonly string[],
    operation: string,
    observer?: BrowserOperationObserver,
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
            }),
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
  ): Promise<T> {
    const scriptPath = await savePlaywrightScript(this.#paths, taskId, action, source);
    const output = await this.#invoke(sessionName, taskId, ['run-code', '--filename', scriptPath], operation, observer);
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
 * Runs `npx` without shell interpolation and without a response-size truncation limit.
 *
 * @param invocation Fully resolved executable, argument array, directory, and environment.
 * @returns Complete stdout and stderr after a zero exit.
 * @throws {Error} If the process cannot start or exits nonzero.
 */
export function runBrowserCommand(invocation: BrowserCommandInvocation): Promise<BrowserCommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.arguments, {
      cwd: invocation.cwd,
      env: invocation.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const childPid = child.pid;
    let childObserved = false;
    let settled = false;

    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    const detachObservedChild = (): void => {
      if (!childObserved || childPid === undefined) {
        return;
      }
      childObserved = false;
      invocation.onChildExited?.(childPid);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', (error) => {
      try {
        detachObservedChild();
      } catch (detachError) {
        rejectOnce(detachError);
        return;
      }
      rejectOnce(error);
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
      if (code === 0) {
        settled = true;
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
      } catch (error) {
        child.kill('SIGTERM');
        rejectOnce(error);
      }
    }
  });
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
    if (await composer.count() !== 1 || !(await composer.isVisible())) {
      throw new Error('page contract drift: composer is not unique and visible');
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
      await send.click();
      clicked = true;
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
 * Builds the completion gate and page-local clipboard interception for one pending turn.
 *
 * @param expectedConversationId Database-bound canonical identity.
 * @returns A Playwright page function source.
 * @throws {Error} This pure source builder does not throw.
 */
function waitScript(expectedConversationId: string): string {
  return `async (page) => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
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
    let stableCompletedPolls = 0;
    while (stableCompletedPolls < 6) {
      const candidateIndex = await page.locator(turnSelector).evaluateAll((elements) => {
        let latestUser = -1;
        for (let index = 0; index < elements.length; index += 1) {
          if (elements[index].getAttribute('data-turn') === 'user') latestUser = index;
        }
        if (latestUser < 0 || latestUser + 1 >= elements.length) return -1;
        const assistant = elements[latestUser + 1];
        if (assistant.getAttribute('data-turn') !== 'assistant') return -1;
        const copy = assistant.querySelectorAll('[data-testid="copy-turn-action-button"]');
        return copy.length === 1 && copy[0] instanceof HTMLElement && copy[0].getClientRects().length > 0
          ? latestUser + 1
          : -1;
      });
      const stop = page.getByRole('button', { name: 'Stop answering', exact: true });
      const stopVisible = await stop.count() > 0 && await stop.first().isVisible();
      if (candidateIndex >= 0 && !stopVisible) {
        if (candidateIndex !== assistantIndex) stableCompletedPolls = 0;
        assistantIndex = candidateIndex;
        stableCompletedPolls += 1;
      } else {
        assistantIndex = -1;
        stableCompletedPolls = 0;
      }
      if (stableCompletedPolls < 6) await page.waitForTimeout(500);
    }
    const assistant = page.locator(turnSelector).nth(assistantIndex);
    const copy = assistant.locator(copySelector);
    if (await copy.count() !== 1) throw new Error('page contract drift: assistant Copy response is not unique');
    const finalStop = page.getByRole('button', { name: 'Stop answering', exact: true });
    if (await finalStop.count() > 0 && await finalStop.first().isVisible()) {
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
        value: async (text) => { globalThis.__chatgptProCollabClipboard.captured = String(text); },
      });
      Object.defineProperty(clipboard, 'write', {
        configurable: true,
        value: async (items) => {
          for (const item of items) {
            if (item.types.includes('text/plain')) {
              globalThis.__chatgptProCollabClipboard.captured = await (await item.getType('text/plain')).text();
              return;
            }
          }
        },
      });
    });
    let response;
    try {
      await copy.click({ force: true });
      await page.waitForFunction(() => {
        return globalThis.__chatgptProCollabClipboard?.captured !== undefined;
      }, undefined, { timeout: 0, polling: 25 });
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
      kind: 'wait',
      response,
      conversationId: capturedMatch[1],
      conversationUrl: capturedUrl.origin + '/c/' + capturedMatch[1],
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
    await page.reload();
    const targetLink = page.locator('a[href="' + targetPath + '"]');
    if (await targetLink.count() !== 0) throw new Error('archive was not visible after sidebar refresh');
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
