import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PlaywrightBrowser,
  type BrowserOperationObserver,
  type BrowserSendResult,
  type BrowserSessionInfo,
  type BrowserWaitResult,
} from './browser.ts';
import {
  collabPaths,
  ensureCollabDirectories,
  ensureTaskDirectories,
  prepareInputs,
  publishOrVerifyResponse,
  requireResponse,
  requireSeedState,
  responsePath,
  savePromptCopy,
  type CollabPaths,
} from './session.ts';
import { StateError, StateStore } from './state.ts';

export interface CollabBrowser {
  setup(): Promise<string>;
  startTask(taskId: string, sessionName: string, seedStatePath: string): Promise<BrowserSessionInfo>;
  send(
    taskId: string,
    sessionName: string,
    expectedConversationId: string | null,
    prompt: string,
    attachmentPaths: readonly string[],
    observer?: BrowserOperationObserver,
    beforeSubmissionRelease?: () => void,
  ): Promise<BrowserSendResult>;
  waitForResponse(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserWaitResult>;
  closeTask(
    taskId: string,
    sessionName: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly wasOpen: boolean }>;
  archive(
    taskId: string,
    sessionName: string,
    conversationId: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly conversationId: string }>;
}

export interface StartResult {
  readonly taskId: string;
  readonly browserPid: number;
  readonly contextMarker: string;
  readonly sessionDirectory: string;
}

export interface SendResult {
  readonly taskId: string;
  readonly turnId: string;
}

export interface WaitResult {
  readonly taskId: string;
  readonly turnId: string;
  readonly responsePath: string;
}

export class CollabError extends Error {
  readonly code: string;

  /**
   * Creates a stable orchestration or CLI contract error.
   *
   * @param code Machine-readable failure code.
   * @param message Human-readable concrete cause.
   * @throws {Error} This constructor does not throw beyond ordinary allocation failures.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CollabError';
    this.code = code;
  }
}

export class CollabService {
  readonly #paths: CollabPaths;
  readonly #browser: CollabBrowser;
  readonly #storeFactory: () => StateStore;
  readonly #idGenerator: () => string;

  /**
   * Creates the command service with injectable browser, database, and ID boundaries.
   *
   * @param paths Resolved production or test data paths.
   * @param browser Browser side-effect boundary.
   * @param storeFactory Creates one process-local SQLite connection per command.
   * @param idGenerator Collision-resistant task and turn identifier source.
   * @throws {Error} This constructor does not perform I/O.
   */
  constructor(
    paths: CollabPaths,
    browser: CollabBrowser,
    storeFactory: () => StateStore = () => {
      return new StateStore(paths.database);
    },
    idGenerator: () => string = randomUUID,
  ) {
    this.#paths = paths;
    this.#browser = browser;
    this.#storeFactory = storeFactory;
    this.#idGenerator = idGenerator;
  }

  /**
   * Completes the interactive setup flow and verifies its resulting seed.
   *
   * @returns The shared authentication seed path.
   * @throws {Error} If the browser flow, seed write, or cleanup fails.
   */
  async setup(): Promise<{ readonly seedPath: string }> {
    await ensureCollabDirectories(this.#paths);
    await this.#browser.setup();
    return { seedPath: await requireSeedState(this.#paths) };
  }

  /**
   * Allocates and starts one independent active task.
   *
   * @returns Task identity plus observed browser evidence.
   * @throws {Error} If setup is missing, state cannot be reserved, or the browser cannot start.
   */
  async start(): Promise<StartResult> {
    await ensureCollabDirectories(this.#paths);
    return this.#withStore(async (store) => {
      const seedStatePath = await requireSeedState(this.#paths);
      const taskId = this.#idGenerator();
      const sessionName = `chatgpt-pro-collab-${taskId}`;
      await ensureTaskDirectories(this.#paths, taskId);
      store.createTask(taskId, sessionName);
      try {
        const browser = await this.#browser.startTask(taskId, sessionName, seedStatePath);
        return {
          taskId,
          browserPid: browser.pid,
          contextMarker: browser.contextMarker,
          sessionDirectory: resolve(this.#paths.sessionsDirectory, taskId),
        };
      } catch (error) {
        store.failTask(taskId);
        throw error;
      }
    });
  }

  /**
   * Saves an immutable prompt copy, uploads explicit attachments, and submits one turn.
   *
   * @param taskId Active task identifier.
   * @param promptPath Explicit host prompt file.
   * @param attachmentPaths Explicit opaque attachment files in upload order.
   * @returns Task and turn identities after confirmed submission.
   * @throws {CollabError} If submission fails or is ambiguous.
   * @throws {Error} If input, transcript, database, or browser operations fail.
   */
  async send(taskId: string, promptPath: string, attachmentPaths: readonly string[]): Promise<SendResult> {
    const input = await prepareInputs(promptPath, attachmentPaths);
    const turnId = this.#idGenerator();

    return this.#withStore(async (store) => {
      return this.#withTaskOperation(store, taskId, 'send', async (observer) => {
        const task = store.requireActiveTask(taskId);
        store.beginTurn(taskId, turnId, input.promptPath, input.attachmentPaths);
        try {
          await savePromptCopy(this.#paths, taskId, turnId, input.prompt);
        } catch (error) {
          store.failSendingTurn(taskId, turnId, `save prompt copy: ${errorMessage(error)}`);
          throw error;
        }
        const browserResult = await this.#browser.send(
          taskId,
          task.playwrightSession,
          task.conversationId,
          input.promptText,
          input.attachmentPaths,
          observer,
          () => {
            store.markSubmissionAttempting(taskId, turnId);
          },
        );
        if (browserResult.status === 'unsafe-not-submitted') {
          failUnsubmittedTurn(store, taskId, turnId, browserResult.error);
          store.failTask(taskId);
          throw new CollabError('SUBMISSION_FAILED', browserResult.error);
        }
        if (browserResult.status === 'not-submitted') {
          failUnsubmittedTurn(store, taskId, turnId, browserResult.error);
          throw new CollabError('SUBMISSION_FAILED', browserResult.error);
        }
        if (browserResult.status === 'unknown-submission') {
          store.markUnknownSubmission(taskId, turnId, browserResult.error);
          throw new CollabError('SUBMISSION_UNKNOWN', browserResult.error);
        }

        try {
          store.markTurnPending(taskId, turnId, browserResult.conversationId, browserResult.conversationUrl);
        } catch (error) {
          try {
            store.markUnknownSubmission(taskId, turnId, `bind conversation: ${errorMessage(error)}`);
          } catch {
            // Preserve the binding failure when SQLite itself prevents ambiguity recording.
          }
          throw error;
        }
        return { taskId, turnId };
      });
    });
  }

  /**
   * Captures and persists a pending response, or returns the completed path idempotently.
   *
   * @param taskId Active task identifier.
   * @param turnId Submitted turn identifier.
   * @returns The immutable response path.
   * @throws {CollabError} If the turn is not pending or state lacks conversation identity.
   * @throws {Error} If browser capture, transcript write, or database completion fails.
   */
  async wait(taskId: string, turnId: string): Promise<WaitResult> {
    return this.#withStore(async (store) => {
      const completed = await completedWaitResult(store, taskId, turnId);
      if (completed !== null) {
        return completed;
      }

      while (true) {
        const result = await this.#withTaskOperation(store, taskId, 'wait', async (observer) => {
          const afterLease = await completedWaitResult(store, taskId, turnId);
          if (afterLease !== null) {
            return afterLease;
          }
          const task = store.requireTask(taskId);
          const turn = store.requireTurn(taskId, turnId);
          if (task.status !== 'active') {
            throw new CollabError('TASK_NOT_ACTIVE', `task is ${task.status}: ${taskId}`);
          }
          if (turn.status !== 'pending') {
            throw new CollabError('TURN_NOT_PENDING', `turn is ${turn.status}: ${turnId}`);
          }
          if (task.conversationId === null || task.conversationUrl === null) {
            throw new CollabError('TRANSCRIPT_INCONSISTENT', `pending task has no conversation: ${taskId}`);
          }

          const captured = await this.#browser.waitForResponse(
            taskId,
            task.playwrightSession,
            task.conversationId,
            observer,
          );
          if (captured.status === 'pending') {
            return null;
          }
          if (captured.conversationId !== task.conversationId || captured.conversationUrl !== task.conversationUrl) {
            throw new CollabError('CONVERSATION_MISMATCH', `wait observed a different conversation: ${taskId}`);
          }
          const targetResponsePath = responsePath(this.#paths, taskId, turnId);
          store.beginCapture(taskId, turnId, targetResponsePath, []);
          await publishOrVerifyResponse(targetResponsePath, captured.response);
          store.completeTurn(taskId, turnId, targetResponsePath);
          return { taskId, turnId, responsePath: targetResponsePath };
        });
        if (result !== null) {
          return result;
        }
        await yieldTaskOperation();
      }
    });
  }

  /**
   * Terminates one task browser and records idempotent local closure.
   *
   * @param taskId Task identifier.
   * @returns Whether this call observed an open browser and whether the task was already closed.
   * @throws {Error} If the task is unknown or browser cleanup fails.
   */
  async close(
    taskId: string,
  ): Promise<{ readonly taskId: string; readonly wasOpen: boolean; readonly alreadyClosed: boolean }> {
    return this.#withStore(async (store) => {
      while (true) {
        try {
          return await this.#withTaskOperation(store, taskId, 'close', async (observer) => {
            const task = store.requireTask(taskId);
            if (task.status === 'closed') {
              return { taskId, wasOpen: false, alreadyClosed: true };
            }
            const result = await this.#browser.closeTask(taskId, task.playwrightSession, observer);
            store.closeTask(taskId);
            return { taskId, wasOpen: result.wasOpen, alreadyClosed: false };
          });
        } catch (error) {
          if (!(error instanceof StateError) || error.code !== 'TASK_OPERATION_IN_PROGRESS') {
            throw error;
          }
          const operation = store.getTaskOperation(taskId);
          if (operation !== null && operation !== 'wait') {
            throw error;
          }
          await yieldTaskOperation();
        }
      }
    });
  }

  /**
   * Archives the active task's bound Web conversation without changing local lifecycle state.
   *
   * @param taskId Active task identifier.
   * @returns The confirmed archived conversation identity.
   * @throws {CollabError} If no conversation has been established.
   * @throws {Error} If the task is inactive or Web archive cannot be observed.
   */
  async archive(taskId: string): Promise<{ readonly taskId: string; readonly conversationId: string }> {
    return this.#withStore(async (store) => {
      return this.#withTaskOperation(store, taskId, 'archive', async (observer) => {
        const task = store.requireActiveTask(taskId);
        if (task.conversationId === null) {
          throw new CollabError('CONVERSATION_NOT_ESTABLISHED', `task has no submitted conversation: ${taskId}`);
        }
        const conversationId = task.conversationId;
        const result = await this.#browser.archive(taskId, task.playwrightSession, conversationId, observer);
        return { taskId, conversationId: result.conversationId };
      });
    });
  }

  /**
   * Serializes browser side effects for one task across independent CLI processes.
   *
   * @param store Current process-local state connection.
   * @param taskId Task whose named browser session will be used.
   * @param operation Browser operation retained for conflict diagnostics.
   * @param action Side effect and state transition performed while the lease is held.
   * @returns The action result after the lease is released.
   * @throws {Error} If lease acquisition, the action, or lease release fails.
   */
  async #withTaskOperation<T>(
    store: StateStore,
    taskId: string,
    operation: string,
    action: (observer: BrowserOperationObserver) => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    store.acquireTaskOperation(taskId, operation, token);
    const observer: BrowserOperationObserver = {
      childSpawned(pid) {
        store.attachTaskOperationChild(taskId, token, pid);
      },
      childExited(pid) {
        store.detachTaskOperationChild(taskId, token, pid);
      },
      commandSpawned(pid) {
        store.attachTaskOperationCommand(taskId, token, pid);
      },
    };
    try {
      return await action(observer);
    } finally {
      store.releaseTaskOperation(taskId, token);
    }
  }

  /**
   * Opens and always closes one process-local database connection around a command.
   *
   * @param operation Command state work; it must not retain the connection.
   * @returns The asynchronous command result.
   * @throws {Error} Re-throws operation and database-close failures.
   */
  async #withStore<T>(operation: (store: StateStore) => Promise<T>): Promise<T> {
    const store = this.#storeFactory();
    try {
      return await operation(store);
    } finally {
      store.close();
    }
  }
}

/**
 * Returns a completed turn without acquiring the task's browser lease.
 *
 * @param store Current process-local state connection.
 * @param taskId Owning task identifier.
 * @param turnId Completed or unfinished turn identifier.
 * @returns Idempotent wait result, or null when browser polling is still required.
 * @throws {CollabError} If a completed row lacks its immutable response path.
 * @throws {Error} If the turn or recorded response cannot be read.
 */
async function completedWaitResult(store: StateStore, taskId: string, turnId: string): Promise<WaitResult | null> {
  const turn = store.requireTurn(taskId, turnId);
  if (turn.status !== 'completed') {
    return null;
  }
  if (turn.responsePath === null) {
    throw new CollabError('TRANSCRIPT_INCONSISTENT', `completed turn has no response path: ${turnId}`);
  }
  return {
    taskId,
    turnId,
    responsePath: await requireResponse(turn.responsePath),
  };
}

/**
 * Reconciles a proven non-submission from either side of the guarded release boundary.
 *
 * @param store Current process-local state connection.
 * @param taskId Owning task identifier.
 * @param turnId Sending or ambiguity-marked turn identifier.
 * @param reason Concrete browser failure.
 * @returns Nothing after the turn is terminally failed.
 * @throws {StateError} If the turn is in any other lifecycle state.
 */
function failUnsubmittedTurn(store: StateStore, taskId: string, turnId: string, reason: string): void {
  const turn = store.requireTurn(taskId, turnId);
  if (turn.status === 'sending') {
    store.failSendingTurn(taskId, turnId, reason);
    return;
  }
  store.failSubmissionAttempt(taskId, turnId, reason);
}

/**
 * Gives a waiting close command a scheduling window between bounded browser polls.
 *
 * @returns A promise resolved on a later event-loop turn.
 * @throws {Error} Timers do not ordinarily throw.
 */
async function yieldTaskOperation(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
}

export interface CliIo {
  writeOutput(value: string): void;
  writeError(value: string): void;
}

/**
 * Parses one CLI invocation, runs exactly one command, and emits stable JSON results.
 *
 * @param arguments_ Arguments after the package script separator.
 * @param service Command service, injectable for tests.
 * @param io Output boundary, injectable for tests.
 * @returns Process exit code.
 * @throws {Error} This function catches command failures and reports them as exit code 1.
 */
export async function runCli(
  arguments_: readonly string[],
  service: CollabService = defaultService(),
  io: CliIo = {
    writeOutput(value) {
      process.stdout.write(value);
    },
    writeError(value) {
      process.stderr.write(value);
    },
  },
): Promise<number> {
  const normalizedArguments = arguments_[0] === '--' ? arguments_.slice(1) : arguments_;
  const [command = 'help', ...parameters] = normalizedArguments;
  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        requireParameterCount(command, parameters, 0);
        io.writeOutput(helpText());
        return 0;
      case 'setup':
        requireParameterCount(command, parameters, 0);
        io.writeOutput(jsonLine({ ok: true, command, ...(await service.setup()) }));
        return 0;
      case 'start':
        requireParameterCount(command, parameters, 0);
        io.writeOutput(jsonLine({ ok: true, command, ...(await service.start()) }));
        return 0;
      case 'send': {
        if (parameters.length < 2) {
          throw usageError('send requires <taskId> <promptPath> [attachmentPath ...]');
        }
        const [taskId, promptPath, ...attachmentPaths] = parameters;
        io.writeOutput(
          jsonLine({
            ok: true,
            command,
            ...(await service.send(required(taskId), required(promptPath), attachmentPaths)),
          }),
        );
        return 0;
      }
      case 'wait': {
        requireParameterCount(command, parameters, 2);
        const [taskId, turnId] = parameters;
        io.writeOutput(jsonLine({ ok: true, command, ...(await service.wait(required(taskId), required(turnId))) }));
        return 0;
      }
      case 'close': {
        requireParameterCount(command, parameters, 1);
        io.writeOutput(jsonLine({ ok: true, command, ...(await service.close(required(parameters[0]))) }));
        return 0;
      }
      case 'archive': {
        requireParameterCount(command, parameters, 1);
        io.writeOutput(jsonLine({ ok: true, command, ...(await service.archive(required(parameters[0]))) }));
        return 0;
      }
      default:
        throw usageError(`unknown command: ${command}`);
    }
  } catch (error) {
    io.writeError(
      jsonLine({
        ok: false,
        error: {
          code: errorCode(error),
          message: errorMessage(error),
        },
      }),
    );
    return 1;
  }
}

/**
 * Creates production paths, browser, and service without reading repository state.
 *
 * @returns The production Collab service.
 * @throws {Error} This factory does not perform I/O.
 */
function defaultService(): CollabService {
  const paths = collabPaths();
  return new CollabService(paths, new PlaywrightBrowser(paths, process.cwd()));
}

/**
 * Enforces an exact positional command signature.
 *
 * @param command Command name used in usage failures.
 * @param parameters Supplied positional parameters.
 * @param expected Required count.
 * @returns Nothing for a matching signature.
 * @throws {CollabError} If the count differs.
 */
function requireParameterCount(command: string, parameters: readonly string[], expected: number): void {
  if (parameters.length !== expected) {
    throw usageError(`${command} expects ${expected} parameter${expected === 1 ? '' : 's'}`);
  }
}

/**
 * Narrows a parameter after a count check.
 *
 * @param value Possibly absent positional value.
 * @returns The supplied string.
 * @throws {CollabError} If a caller bypassed the count check.
 */
function required(value: string | undefined): string {
  if (value === undefined) {
    throw usageError('required parameter is missing');
  }
  return value;
}

/**
 * Creates one stable usage failure.
 *
 * @param message Concrete signature problem.
 * @returns A usage-classified error.
 * @throws {Error} This pure constructor helper does not throw beyond allocation failures.
 */
function usageError(message: string): CollabError {
  return new CollabError('USAGE', message);
}

/**
 * Serializes one compact JSON object with a trailing newline.
 *
 * @param value Successful or failed CLI result.
 * @returns One JSON line.
 * @throws {TypeError} If the value cannot be serialized.
 */
function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Returns the stable command synopsis used by VER-010.
 *
 * @returns Human-readable help text ending in a newline.
 * @throws {Error} This pure helper does not throw.
 */
function helpText(): string {
  return `ChatGPT Pro Collab

Usage:
  node "<skill-directory>/scripts/collab.ts" setup
  node "<skill-directory>/scripts/collab.ts" start
  node "<skill-directory>/scripts/collab.ts" send <taskId> <promptPath> [attachmentPath ...]
  node "<skill-directory>/scripts/collab.ts" wait <taskId> <turnId>
  node "<skill-directory>/scripts/collab.ts" close <taskId>
  node "<skill-directory>/scripts/collab.ts" archive <taskId>
`;
}

/**
 * Preserves stable boundary codes while keeping unexpected failures explicit.
 *
 * @param error Unknown command failure.
 * @returns Machine-readable failure code.
 * @throws {Error} This formatter does not throw for ordinary JavaScript values.
 */
function errorCode(error: unknown): string {
  if (error instanceof CollabError || error instanceof StateError) {
    return error.code;
  }
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'UNEXPECTED';
}

/**
 * Extracts a stable message without discarding non-Error failures.
 *
 * @param error Unknown thrown value.
 * @returns Human-readable cause.
 * @throws {Error} This formatter does not throw for ordinary JavaScript values.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
