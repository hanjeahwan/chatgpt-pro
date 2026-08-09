import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserError,
  PlaywrightBrowser,
  type BrowserArchiveState,
  type BrowserArtifactDownload,
  type BrowserAutoVerifyResult,
  type BrowserAvailability,
  type BrowserCaptureResult,
  type BrowserObservationResult,
  type BrowserOperationObserver,
  type BrowserResolveFailedTurnResult,
  type BrowserResolveSubmittedResult,
  type BrowserSendResult,
  type BrowserSessionInfo,
} from './browser.ts';
import {
  artifactPath,
  artifactTemporaryPath,
  collabPaths,
  discardArtifactTemporary,
  ensureCollabDirectories,
  prepareInputs,
  publishOrVerifyArtifact,
  publishOrVerifyResponse,
  requireArtifact as requireArtifactFile,
  requireResponse,
  requireSeedState,
  responsePath,
  savePromptCopy,
  seedStateValid,
  type CollabPaths,
} from './session.ts';
import { StateError, StateStore, type OperationRecord, type StatusRecord, type TurnRecord } from './state.ts';

const CAPTURE_ABORT_SETTLE_MS = 250;
const OBSERVATION_RELOAD_PERIOD_MS = 300_000;

export interface CollabBrowser {
  setupOpen(sessionName: string): Promise<void>;
  setupSaveSeed(sessionName: string, seedStatePath: string): Promise<{ readonly seedValidated: boolean }>;
  setupClose(sessionName: string): Promise<{ readonly sessionClosed: boolean }>;
  verifyAuthenticatedSeed(sessionName: string, seedStatePath: string): Promise<{ readonly authenticated: boolean }>;
  startTask(
    taskId: string,
    sessionName: string,
    seedStatePath: string,
    rebuild?: boolean,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserSessionInfo>;
  sessionAvailability(sessionName: string): Promise<BrowserAvailability>;
  recoverConversation(
    taskId: string,
    sessionName: string,
    conversationUrl: string,
    conversationId: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly conversationId: string; readonly conversationUrl: string }>;
  reloadConversation(
    taskId: string,
    sessionName: string,
    expectedConversationUrl: string,
    expectedConversationId: string,
    expectedUserTurnId: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly conversationId: string; readonly conversationUrl: string }>;
  send(
    taskId: string,
    sessionName: string,
    expectedConversationId: string | null,
    prompt: string,
    attachmentPaths: readonly string[],
    observer?: BrowserOperationObserver,
    beforeSubmissionRelease?: () => void,
  ): Promise<BrowserSendResult>;
  observeResponse(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    expectedUserTurnId: string,
    observationWindowMs: number,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserObservationResult>;
  captureResponse(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    expectedUserTurnId: string,
    expectedAssistantTurnId: string | null,
    captureTimeoutMs: number,
    signal: AbortSignal,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserCaptureResult>;
  downloadArtifact(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    expectedUserTurnId: string,
    expectedSourceUrls: readonly string[],
    sourceUrl: string,
    temporaryPath: string,
    captureTimeoutMs: number,
    signal: AbortSignal,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserArtifactDownload>;
  closeTask(
    taskId: string,
    sessionName: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly wasOpen: boolean }>;
  archive(
    taskId: string,
    sessionName: string,
    conversationId: string,
    conversationUrl: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly conversationId: string }>;
  resolveSubmittedConversation(
    taskId: string,
    sessionName: string,
    canonicalUrl: string,
    expectedConversationId: string | null,
    expectedProjectIdentity: string | null,
    previousUserTurnIdentity: string | null,
    prompt: string,
    attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<BrowserResolveSubmittedResult>;
  verifySafeComposer(
    taskId: string,
    sessionName: string,
    expectedConversationId: string | null,
    expectedProjectIdentity: string | null,
    previousUserTurnIdentity: string | null,
    prompt: string,
    attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<void>;
  resolveFailedTurn(
    taskId: string,
    sessionName: string,
    expectedConversationId: string,
    expectedUserTurnId: string,
    conversationUrl: string,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserResolveFailedTurnResult>;
  cleanSendComposer(
    taskId: string,
    sessionName: string,
    expectedConversationId: string | null,
    attachmentFileNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<void>;
  observeArchiveState(
    taskId: string,
    sessionName: string,
    conversationUrl: string,
    conversationId: string,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserArchiveState>;
  autoVerifySubmission(
    taskId: string,
    sessionName: string,
    expectedConversationId: string | null,
    expectedProjectIdentity: string | null,
    previousUserTurnIdentity: string | null,
    prompt: string,
    attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<BrowserAutoVerifyResult>;
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

export type WaitResult =
  | {
      readonly status: 'pending';
      readonly taskId: string;
      readonly turnId: string;
    }
  | {
      readonly status: 'completed';
      readonly taskId: string;
      readonly turnId: string;
      readonly responsePath: string;
      readonly artifactPaths: readonly string[];
    };

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
  readonly #now: () => number;

  /**
   * Creates the command service with injectable browser, database, and ID boundaries.
   *
   * @param paths Resolved production or test data paths.
   * @param browser Browser side-effect boundary.
   * @param storeFactory Creates one process-local SQLite connection per command.
   * @param idGenerator Collision-resistant task and turn identifier source.
   * @param now Injectable monotonic clock used by the wait observation schedule.
   * @throws {Error} This constructor does not perform I/O.
   */
  constructor(
    paths: CollabPaths,
    browser: CollabBrowser,
    storeFactory: () => StateStore = () => {
      return new StateStore(paths.database);
    },
    idGenerator: () => string = randomUUID,
    now: () => number = () => {
      return performance.now();
    },
  ) {
    this.#paths = paths;
    this.#browser = browser;
    this.#storeFactory = storeFactory;
    this.#idGenerator = idGenerator;
    this.#now = now;
  }

  /**
   * Completes the interactive setup flow and reconciles any interrupted setup journal.
   *
   * The shared seed is never deleted; an already validated seed skips the login and only
   * finishes the recorded setup-session cleanup before committing the setup operation.
   *
   * @returns The shared authentication seed path.
   * @throws {Error} If the browser flow, seed write, or cleanup fails.
   */
  async setup(): Promise<{ readonly seedPath: string }> {
    await ensureCollabDirectories(this.#paths);
    return this.#withStore(async (store) => {
      const existing = store.getUncommittedSetupOperation();
      const sessionName = existing?.sessionName ?? `chatgpt-pro-collab-setup-${this.#idGenerator()}`;
      let operation =
        existing ??
        store.createOperation({
          id: this.#idGenerator(),
          kind: 'setup',
          step: 'login',
          taskId: null,
          turnId: null,
          sessionName,
        });
      const seedPath = this.#paths.seedState;
      const now = (): string => {
        return new Date().toISOString();
      };

      if (operation.step === 'login') {
        const seedValid = await seedStateValid(this.#paths);
        if (seedValid) {
          const verified = await this.#browser.verifyAuthenticatedSeed(sessionName, seedPath);
          if (verified.authenticated) {
            operation = store.advanceOperationStep(operation.id, 'seed', {
              observedAt: now(),
              sessionName,
              postcondition: 'seed loaded in an isolated session and the authenticated page was verified',
              seedValidated: true,
            });
          } else {
            if (operation.phase === 'prepared') {
              operation = store.markOperationEffectUnknown(operation.id, {
                observedAt: now(),
                sessionName,
                postcondition: 'setup browser command released',
              });
            }
            await this.#browser.setupOpen(sessionName);
            operation = store.advanceOperationStep(operation.id, 'seed', {
              observedAt: now(),
              sessionName,
              postcondition: 'interactive login observed',
            });
          }
        } else {
          if (operation.phase === 'prepared') {
            operation = store.markOperationEffectUnknown(operation.id, {
              observedAt: now(),
              sessionName,
              postcondition: 'setup browser command released',
            });
          }
          await this.#browser.setupOpen(sessionName);
          operation = store.advanceOperationStep(operation.id, 'seed', {
            observedAt: now(),
            sessionName,
            postcondition: 'interactive login observed',
          });
        }
      }

      if (operation.step === 'seed') {
        const seedValid = await seedStateValid(this.#paths);
        if (!seedValid) {
          if (operation.phase === 'prepared') {
            operation = store.markOperationEffectUnknown(operation.id, {
              observedAt: now(),
              sessionName,
              postcondition: 'state-save command released',
            });
            await this.#browser.setupSaveSeed(sessionName, seedPath);
          } else {
            await this.#browser.setupOpen(sessionName);
            await this.#browser.setupSaveSeed(sessionName, seedPath);
          }
        }
        const validated = await seedStateValid(this.#paths);
        if (!validated) {
          throw new CollabError(
            'SEED_NOT_AUTHENTICATED',
            'saved authentication state is not a loadable ChatGPT storage state; run setup again and complete the login',
          );
        }
        let verified = await this.#browser.verifyAuthenticatedSeed(sessionName, seedPath);
        if (!verified.authenticated) {
          if (operation.phase === 'prepared') {
            operation = store.markOperationEffectUnknown(operation.id, {
              observedAt: now(),
              sessionName,
              postcondition: 'state-save command released after an interactive login',
            });
            await this.#browser.setupSaveSeed(sessionName, seedPath);
          } else if (operation.phase === 'effect-unknown') {
            await this.#browser.setupOpen(sessionName);
            await this.#browser.setupSaveSeed(sessionName, seedPath);
          }
          verified = await this.#browser.verifyAuthenticatedSeed(sessionName, seedPath);
        }
        if (!verified.authenticated) {
          throw new CollabError(
            'SEED_NOT_AUTHENTICATED',
            'saved authentication state did not produce an authenticated ChatGPT page; run setup again and complete the login',
          );
        }
        operation = store.advanceOperationStep(operation.id, 'cleanup', {
          observedAt: now(),
          sessionName,
          postcondition: 'authentication seed saved, loaded, and authenticated on the page',
          seedValidated: true,
        });
      }

      if (operation.step === 'cleanup') {
        if (operation.phase === 'prepared') {
          operation = store.markOperationEffectUnknown(operation.id, {
            observedAt: now(),
            sessionName,
            postcondition: 'setup close command released',
          });
        }
        const closed = await this.#browser.setupClose(sessionName);
        if (closed.sessionClosed !== true) {
          throw new CollabError(
            'SETUP_SESSION_NOT_CLOSED',
            `setup session could not be confirmed closed (sessionClosed: ${closed.sessionClosed}); run setup again to finish cleanup`,
          );
        }
        operation = store.commitOperation(operation.id, 'automatic', {
          observedAt: now(),
          sessionName,
          postcondition: 'setup session closed after verified seed',
          seedValidated: true,
          sessionClosed: true,
        });
      }
      return { seedPath: await requireSeedState(this.#paths) };
    });
  }

  /**
   * Starts one independent task from a caller-provided canonical UUID v4 identity.
   *
   * The task is only reserved as `starting` together with its start operation before any
   * browser command. Repeats resume the same starting task or an active task that has not
   * bound a conversation; other lifecycle states conflict before browser side effects.
   *
   * @param taskId Caller-provided canonical lowercase UUID v4.
   * @returns Task identity plus observed browser evidence.
   * @throws {CollabError} If the identity is invalid, the state conflicts, or the fixed
   *   Project or model/mode context cannot be confirmed.
   * @throws {Error} If setup is missing or the browser cannot start.
   */
  async start(taskId: string): Promise<StartResult> {
    requireCanonicalTaskId(taskId);
    await ensureCollabDirectories(this.#paths);
    return this.#withStore(async (store) => {
      const sessionName = `chatgpt-pro-collab-${taskId}`;
      let existing = store.getTask(taskId);
      if (
        existing !== null &&
        existing.status !== 'starting' &&
        !(existing.status === 'active' && existing.conversationId === null)
      ) {
        throw new CollabError('TASK_CONFLICT', `task is ${existing.status}: ${taskId}`);
      }
      if (existing === null) {
        try {
          store.createStartingTask(taskId, sessionName, this.#idGenerator());
        } catch (error) {
          if (!(error instanceof StateError) || error.code !== 'TASK_CONFLICT') {
            throw error;
          }
          const raced = store.getTask(taskId);
          if (raced === null || raced.playwrightSession !== sessionName) {
            throw error;
          }
          if (raced.status !== 'starting' && !(raced.status === 'active' && raced.conversationId === null)) {
            throw error;
          }
          existing = raced;
        }
      }
      while (true) {
        const token = randomUUID();
        try {
          store.acquireTaskOperation(taskId, 'start', token);
          return await this.#withAcquiredTaskOperation(store, taskId, token, async (observer) => {
            return this.#startTaskUnderLease(store, taskId, sessionName, observer);
          });
        } catch (error) {
          if (!(error instanceof StateError) || error.code !== 'TASK_OPERATION_IN_PROGRESS') {
            throw error;
          }
          const operation = store.getTaskOperation(taskId);
          if (operation !== null && operation !== 'start') {
            throw error;
          }
          await yieldTaskOperation();
        }
      }
    });
  }

  /**
   * Auto-verifies a released submission whose result was lost, or opens the decision gate.
   *
   * @param store Current process-local state connection.
   * @param taskId Task whose send workflow is recovered.
   * @param operation Effect-unknown send operation at the submit step.
   * @param sendingTurn The sending turn of the released submission.
   * @param observer Task-lease child-process observer.
   * @returns The recovered status snapshot.
   * @throws {CollabError} If the saved prompt is unreadable or state is inconsistent.
   * @throws {Error} If state or browser operations fail.
   */
  async #recoverSubmittedSend(
    store: StateStore,
    taskId: string,
    operation: OperationRecord,
    sendingTurn: TurnRecord | undefined,
    observer: BrowserOperationObserver,
  ): Promise<StatusRecord> {
    const task = store.requireTask(taskId);
    const observedAt = new Date().toISOString();
    if (sendingTurn === undefined) {
      store.commitOperation(operation.id, 'automatic', {
        observedAt,
        sessionName: task.playwrightSession,
        postcondition: 'released submission had no recoverable sending turn',
      });
      const afterMissing = await this.#browser.sessionAvailability(task.playwrightSession);
      return store.getStatus(taskId, afterMissing);
    }
    const prompt = await readSavedPrompt(this.#paths, taskId, sendingTurn.id);
    const attachmentNames = sendingTurn.attachmentPaths.map((attachmentPath) => {
      return basename(attachmentPath);
    });
    const previousUserTurnIdentity = await previousUserTurnIdentityBefore(store, taskId, sendingTurn.id);
    if ((await this.#browser.sessionAvailability(task.playwrightSession)) === 'missing') {
      const seedStatePath = await requireSeedState(this.#paths);
      await this.#browser.startTask(taskId, task.playwrightSession, seedStatePath, true, observer);
      if (task.conversationId !== null && task.conversationUrl !== null) {
        await this.#browser.recoverConversation(
          taskId,
          task.playwrightSession,
          task.conversationUrl,
          task.conversationId,
          observer,
        );
      }
    }
    if ((await this.#browser.sessionAvailability(task.playwrightSession)) === 'missing') {
      store.markSubmissionUnknownAndNeedsDecision(
        taskId,
        sendingTurn.id,
        operation.id,
        'browser session could not be rebuilt; submission outcome could not be verified',
        {
          observedAt,
          sessionName: task.playwrightSession,
          postcondition: 'no page evidence available for automatic proof',
        },
      );
      const after = await this.#browser.sessionAvailability(task.playwrightSession);
      return store.getStatus(taskId, after);
    }
    const verified = await this.#browser.autoVerifySubmission(
      taskId,
      task.playwrightSession,
      task.conversationId,
      store.getStartProjectIdentity(taskId),
      previousUserTurnIdentity,
      prompt,
      attachmentNames,
      observer,
    );
    if (verified.status === 'submitted') {
      store.commitSubmittedTurn(
        taskId,
        sendingTurn.id,
        verified.conversationId,
        verified.conversationUrl,
        verified.userTurnIdentity,
        operation.id,
        {
          observedAt,
          sessionName: task.playwrightSession,
          pageUrl: verified.conversationUrl,
          postcondition: 'unique matching user turn auto-verified after the recorded anchor',
          conversationId: verified.conversationId,
          userTurnIdentity: verified.userTurnIdentity,
          promptVerbatimMatch: true,
          attachmentNamesMatch: true,
        },
      );
      const after = await this.#browser.sessionAvailability(task.playwrightSession);
      return store.getStatus(taskId, after);
    }
    store.markSubmissionUnknownAndNeedsDecision(
      taskId,
      sendingTurn.id,
      operation.id,
      `auto-verification unresolved: ${verified.reason}`,
      {
        observedAt,
        sessionName: task.playwrightSession,
        postcondition: 'page evidence did not prove the submission',
      },
    );
    const after = await this.#browser.sessionAvailability(task.playwrightSession);
    return store.getStatus(taskId, after);
  }

  /**
   * Runs or resumes the fixed Project and model/mode start context under the task lease.
   *
   * @param store Current process-local state connection.
   * @param taskId Task identifier.
   * @param sessionName Stable session identity of the task.
   * @param observer Task-lease child-process observer.
   * @returns Task identity plus observed browser evidence.
   * @throws {CollabError} If the fixed context cannot be confirmed or the start conflicts.
   * @throws {Error} If setup is missing or the browser cannot start.
   */
  async #startTaskUnderLease(
    store: StateStore,
    taskId: string,
    sessionName: string,
    observer: BrowserOperationObserver,
  ): Promise<StartResult> {
    const seedStatePath = await requireSeedState(this.#paths);
    const task = store.requireTask(taskId);
    const operation = store.getUncommittedTaskOperation(taskId);
    if (operation === null || operation.kind !== 'start') {
      if (task.status === 'starting') {
        const resumed = await this.#browser.startTask(taskId, task.playwrightSession, seedStatePath, true, observer);
        store.activateTask(taskId);
        return {
          taskId,
          browserPid: resumed.pid,
          contextMarker: resumed.contextMarker,
          sessionDirectory: resolve(this.#paths.sessionsDirectory, taskId),
        };
      }
      if (task.status === 'active' && task.conversationId === null) {
        const resumed = await this.#browser.startTask(taskId, task.playwrightSession, seedStatePath, true, observer);
        return {
          taskId,
          browserPid: resumed.pid,
          contextMarker: resumed.contextMarker,
          sessionDirectory: resolve(this.#paths.sessionsDirectory, taskId),
        };
      }
      throw new CollabError('TASK_CONFLICT', `start is not the active operation: ${taskId}`);
    }
    let effectOperation = operation;
    if (effectOperation.phase === 'prepared') {
      effectOperation = store.markOperationEffectUnknown(effectOperation.id, {
        observedAt: new Date().toISOString(),
        sessionName,
        postcondition: 'start browser commands released',
      });
    }
    try {
      const resumed = task.status === 'active' && task.conversationId === null;
      const browser = await this.#browser.startTask(taskId, task.playwrightSession, seedStatePath, resumed, observer);
      if (effectOperation.step === 'session') {
        effectOperation = store.advanceOperationStep(effectOperation.id, 'project', {
          observedAt: new Date().toISOString(),
          sessionName,
          pageUrl: browser.url,
          postcondition: 'fixed Project and blank composer verified',
        });
      }
      if (effectOperation.step === 'project') {
        effectOperation = store.advanceOperationStep(effectOperation.id, 'configuration', {
          observedAt: new Date().toISOString(),
          sessionName,
          pageUrl: browser.url,
          postcondition: 'current model GPT-5.6 Sol read back and Power slider at the maximum level',
          projectIdentity: browser.projectId,
          modelConfirmed: browser.modelConfirmed,
          powerConfirmed: browser.powerConfirmed,
          powerNow: browser.powerNow,
          powerMin: browser.powerMin,
          powerMax: browser.powerMax,
        });
      }
      store.commitOperation(effectOperation.id, 'automatic', {
        observedAt: new Date().toISOString(),
        sessionName,
        pageUrl: browser.url,
        postcondition: 'fixed start context confirmed',
        projectIdentity: browser.projectId,
        modelConfirmed: browser.modelConfirmed,
        powerConfirmed: browser.powerConfirmed,
        powerNow: browser.powerNow,
        powerMin: browser.powerMin,
        powerMax: browser.powerMax,
      });
      if (task.status === 'starting') {
        store.activateTask(taskId);
      }
      return {
        taskId,
        browserPid: browser.pid,
        contextMarker: browser.contextMarker,
        sessionDirectory: resolve(this.#paths.sessionsDirectory, taskId),
      };
    } catch (error) {
      if (isDefiniteStartFailure(error)) {
        try {
          store.failTask(taskId);
          store.commitOperation(effectOperation.id, 'automatic', undefined, errorMessage(error));
        } catch {
          // Preserve the original start failure when the failure commit itself fails.
        }
      }
      throw error;
    }
  }

  /**
   * Saves an immutable prompt copy, uploads explicit attachments, and submits one turn.
   *
   * The sending turn and its `send: draft: prepared` operation are reserved in one
   * transaction before the prompt copy or any browser command; the operation enters
   * `send: submit: effect-unknown` immediately before the guarded submit release.
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
    if (input.promptText !== input.promptText.trim()) {
      throw new CollabError(
        'PROMPT_NOT_VERBATIM_PROVABLE',
        'prompt has leading or trailing whitespace that cannot be proven verbatim on the page; trim it before sending',
      );
    }
    const turnId = this.#idGenerator();

    return this.#withStore(async (store) => {
      return this.#withTaskOperation(store, taskId, 'send', async (observer) => {
        const task = store.requireActiveTask(taskId);
        const reserved = store.beginSendTurn(
          taskId,
          turnId,
          input.promptPath,
          input.attachmentPaths,
          this.#idGenerator(),
        );
        const operationId = reserved.operation.id;
        try {
          await savePromptCopy(this.#paths, taskId, turnId, input.prompt);
        } catch (error) {
          store.failSubmissionAndCommit(taskId, turnId, operationId, `save prompt copy: ${errorMessage(error)}`, {
            observedAt: new Date().toISOString(),
            sessionName: task.playwrightSession,
            postcondition: 'prompt copy could not be published before browser actions',
          });
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
            store.advanceSendToSubmitEffectUnknown(operationId, {
              observedAt: new Date().toISOString(),
              sessionName: task.playwrightSession,
              postcondition: 'submit command released',
            });
          },
        );
        const observedAt = new Date().toISOString();
        if (browserResult.status === 'unsafe-not-submitted') {
          await this.#recoverDraftComposer(
            taskId,
            task.playwrightSession,
            task.conversationId,
            task.conversationUrl,
            input.attachmentPaths.map((attachmentPath) => {
              return basename(attachmentPath);
            }),
            observer,
          );
          store.failSubmissionAndCommit(taskId, turnId, operationId, browserResult.error, {
            observedAt,
            sessionName: task.playwrightSession,
            postcondition: 'target composer verified safe after draft recovery',
          });
          throw new CollabError('SUBMISSION_FAILED', browserResult.error);
        }
        if (browserResult.status === 'not-submitted') {
          store.failSubmissionAndCommit(taskId, turnId, operationId, browserResult.error, {
            observedAt,
            sessionName: task.playwrightSession,
            postcondition: 'browser proved the message was not submitted',
          });
          throw new CollabError('SUBMISSION_FAILED', browserResult.error);
        }
        if (browserResult.status === 'unknown-submission') {
          store.markSubmissionUnknownAndNeedsDecision(taskId, turnId, operationId, browserResult.error, {
            observedAt,
            sessionName: task.playwrightSession,
            postcondition: 'submission outcome could not be proven',
          });
          throw new CollabError('SUBMISSION_UNKNOWN', browserResult.error);
        }

        store.commitSubmittedTurn(
          taskId,
          turnId,
          browserResult.conversationId,
          browserResult.conversationUrl,
          browserResult.userTurnIdentity,
          operationId,
          {
            observedAt,
            sessionName: task.playwrightSession,
            pageUrl: browserResult.conversationUrl,
            postcondition: 'unique user turn observed after the recorded anchor',
            conversationId: browserResult.conversationId,
            userTurnIdentity: browserResult.userTurnIdentity,
            promptVerbatimMatch: true,
            attachmentNamesMatch: true,
          },
        );
        return { taskId, turnId };
      });
    });
  }

  /**
   * Observes within one finite window, then captures within one independent finite deadline.
   *
   * Every positive observation window performs at least one page observation even when local
   * wait overhead has exhausted the window: the first observation is never skipped for an
   * early pending return or a reload, and a completed first observation still captures.
   * While the pending turn stays uncaptured, the same monotonic schedule unconditionally
   * reloads the bound canonical conversation every 300000ms of uncaptured time inside the
   * observation budget. Each observation slice is capped at the smaller of the remaining
   * observation budget and the time until the next reload, so no slice crosses the cadence
   * and the next action at a reached boundary is the reload. Reload time counts against the
   * original observation deadline and never terminates generation, changes turn state, or
   * sends a continuation. The reload cadence stays anchored to the observation start: a
   * reload's own duration counts toward the current period and never re-anchors the next
   * trigger from reload completion. A reload that exhausts the observation budget returns
   * pending without observing further. Capturing retries skip the reload schedule.
   *
   * @param taskId Active task identifier.
   * @param turnId Submitted turn identifier.
   * @param observationWindowMs Maximum reply-generation observation window for this call.
   * @param captureTimeoutMs Maximum response capture duration after completion is observed.
   * @returns Pending at normal observation expiry, or immutable completed transcript paths.
   * @throws {CollabError} If durations are invalid, capture times out, or state is inconsistent.
   * @throws {Error} If browser capture, transcript write, or database completion fails.
   */
  async wait(
    taskId: string,
    turnId: string,
    observationWindowMs: number,
    captureTimeoutMs: number,
  ): Promise<WaitResult> {
    requirePositiveMilliseconds('observationWindowMs', observationWindowMs);
    requirePositiveMilliseconds('captureTimeoutMs', captureTimeoutMs);
    const waitStartedAt = this.#now();
    const observationDeadline = waitStartedAt + observationWindowMs;
    let nextReloadAt = waitStartedAt + OBSERVATION_RELOAD_PERIOD_MS;

    return this.#withStore(async (store) => {
      const completed = await completedWaitResult(store, taskId, turnId);
      if (completed !== null) {
        return completed;
      }
      const initialTurn = store.requireTurn(taskId, turnId);
      let captureDeadline = initialTurn.status === 'capturing' ? waitStartedAt + captureTimeoutMs : null;
      let observedOnce = false;

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
          if (turn.status !== 'pending' && turn.status !== 'capturing') {
            throw new CollabError('TURN_NOT_CAPTURABLE', `turn is ${turn.status}: ${turnId}`);
          }
          if (task.conversationId === null || task.conversationUrl === null) {
            throw new CollabError('TRANSCRIPT_INCONSISTENT', `capturable task has no conversation: ${taskId}`);
          }
          if (turn.userTurnIdentity === null) {
            throw new CollabError(
              'TRANSCRIPT_INCONSISTENT',
              `${turn.status} turn has no persisted user turn identity: ${turnId}`,
            );
          }
          const conversationId = task.conversationId;
          const userTurnIdentity = turn.userTurnIdentity;
          if (turn.status === 'capturing' && captureDeadline === null) {
            captureDeadline = this.#now() + captureTimeoutMs;
          }

          let targetResponsePath = turn.responsePath;
          let expectedAssistantTurnId: string | null = null;
          const captureWasPending = turn.status === 'pending';
          if (turn.status === 'pending') {
            const remainingObservationMs = remainingMilliseconds(observationDeadline, this.#now);
            const remainingUntilReloadMs = remainingMilliseconds(nextReloadAt, this.#now);
            if (remainingObservationMs === 0 && observedOnce) {
              return { status: 'pending' as const, taskId, turnId };
            }
            if (remainingObservationMs > 0 && remainingUntilReloadMs === 0) {
              const reloaded = await this.#browser.reloadConversation(
                taskId,
                task.playwrightSession,
                task.conversationUrl,
                task.conversationId,
                userTurnIdentity,
                observer,
              );
              assertConversation(taskId, task.conversationId, task.conversationUrl, reloaded);
              nextReloadAt += OBSERVATION_RELOAD_PERIOD_MS;
              while (nextReloadAt <= this.#now()) {
                nextReloadAt += OBSERVATION_RELOAD_PERIOD_MS;
              }
              return remainingMilliseconds(observationDeadline, this.#now) === 0
                ? { status: 'pending' as const, taskId, turnId }
                : null;
            }
            const observed = await this.#browser.observeResponse(
              taskId,
              task.playwrightSession,
              task.conversationId,
              userTurnIdentity,
              Math.max(1, Math.min(remainingObservationMs, remainingUntilReloadMs)),
              observer,
            );
            observedOnce = true;
            if (observed.status === 'pending') {
              return remainingMilliseconds(observationDeadline, this.#now) === 0
                ? { status: 'pending' as const, taskId, turnId }
                : null;
            }
            assertConversation(taskId, task.conversationId, task.conversationUrl, observed);
            expectedAssistantTurnId = observed.assistantTurnId;
            targetResponsePath = responsePath(this.#paths, taskId, turnId);
            captureDeadline = this.#now() + captureTimeoutMs;
          }

          if (targetResponsePath === null || captureDeadline === null) {
            throw new CollabError('TRANSCRIPT_INCONSISTENT', `capturing turn has no response deadline: ${turnId}`);
          }
          const captured = await captureOperationWithinDeadline(
            captureDeadline,
            turnId,
            'response',
            (remainingCaptureMs, signal) => {
              return this.#browser.captureResponse(
                taskId,
                task.playwrightSession,
                conversationId,
                userTurnIdentity,
                expectedAssistantTurnId,
                remainingCaptureMs,
                signal,
                observer,
              );
            },
            this.#now,
          );
          assertConversation(taskId, conversationId, task.conversationUrl, captured);
          if (remainingMilliseconds(captureDeadline, this.#now) === 0) {
            throw new CollabError('CAPTURE_TIMEOUT', `response capture timed out: ${turnId}`);
          }
          if (captureWasPending) {
            store.freezeCapture(taskId, turnId, targetResponsePath, captured.artifacts);
          } else {
            store.verifyArtifactSet(taskId, turnId, captured.artifacts);
          }
          if (remainingMilliseconds(captureDeadline, this.#now) === 0) {
            throw new CollabError('CAPTURE_TIMEOUT', `response capture timed out: ${turnId}`);
          }
          await publishOrVerifyResponse(targetResponsePath, captured.response);
          const artifactPaths = await this.#captureArtifacts(
            store,
            taskId,
            turnId,
            task.playwrightSession,
            task.conversationId,
            userTurnIdentity,
            captureDeadline,
            observer,
            this.#now,
          );
          if (remainingMilliseconds(captureDeadline, this.#now) === 0) {
            throw new CollabError('CAPTURE_TIMEOUT', `response capture timed out: ${turnId}`);
          }
          store.completeTurn(taskId, turnId, targetResponsePath);
          return {
            status: 'completed' as const,
            taskId,
            turnId,
            responsePath: targetResponsePath,
            artifactPaths,
          };
        });
        if (result !== null) {
          return result;
        }
        await yieldTaskOperation();
      }
    });
  }

  /**
   * Reuses completed artifacts and downloads each remaining target within one shared deadline.
   *
   * @param store Current process-local state connection.
   * @param taskId Owning task identifier.
   * @param turnId Capturing turn identifier.
   * @param sessionName Owning Playwright named session.
   * @param conversationId Database-bound conversation identity.
   * @param userTurnIdentity Persisted target user turn identity.
   * @param captureDeadline Monotonic deadline shared by response and all artifact capture.
   * @param observer Task-lease child-process observer.
   * @param now Injectable monotonic clock matching the deadline's time base.
   * @returns Readable final artifact paths in response order.
   * @throws {CollabError} If the shared capture deadline expires.
   * @throws {Error} If download, publication, or persisted artifact state is inconsistent.
   */
  async #captureArtifacts(
    store: StateStore,
    taskId: string,
    turnId: string,
    sessionName: string,
    conversationId: string,
    userTurnIdentity: string,
    captureDeadline: number,
    observer: BrowserOperationObserver,
    now: () => number = () => {
      return performance.now();
    },
  ): Promise<readonly string[]> {
    const artifactPaths: string[] = [];
    const artifacts = store.listArtifacts(taskId, turnId);
    const expectedSourceUrls = artifacts.map((artifact) => {
      return artifact.sourceUrl;
    });
    for (const artifact of artifacts) {
      if (artifact.status === 'completed') {
        if (artifact.localPath === null) {
          throw new CollabError('ARTIFACT_INCONSISTENT', `completed artifact has no local path: ${artifact.ordinal}`);
        }
        artifactPaths.push(await requireArtifactFile(artifact.localPath));
        continue;
      }

      const temporaryPath = await artifactTemporaryPath(this.#paths, taskId, turnId, artifact.ordinal);
      try {
        const download = await captureOperationWithinDeadline(
          captureDeadline,
          turnId,
          'artifact',
          (remainingCaptureMs, signal) => {
            return this.#browser.downloadArtifact(
              taskId,
              sessionName,
              conversationId,
              userTurnIdentity,
              expectedSourceUrls,
              artifact.sourceUrl,
              temporaryPath,
              remainingCaptureMs,
              signal,
              observer,
            );
          },
          now,
        );
        let target = artifact.localPath;
        if (target === null) {
          target = artifactPath(this.#paths, taskId, turnId, artifact.ordinal, download.suggestedFilename);
          store.setArtifactDestination(taskId, turnId, artifact.ordinal, download.suggestedFilename, target);
        } else if (artifact.filename === null) {
          throw new CollabError('ARTIFACT_INCONSISTENT', `pending artifact path has no filename: ${artifact.ordinal}`);
        }
        await publishOrVerifyArtifact(temporaryPath, target);
        if (remainingMilliseconds(captureDeadline, now) === 0) {
          throw new CollabError('CAPTURE_TIMEOUT', `artifact capture timed out: ${turnId}`);
        }
        store.completeArtifact(taskId, turnId, artifact.ordinal);
        artifactPaths.push(await requireArtifactFile(target));
      } catch (error) {
        await discardArtifactTemporary(temporaryPath);
        if (store.requireArtifact(taskId, turnId, artifact.ordinal).status === 'pending') {
          store.recordArtifactError(taskId, turnId, artifact.ordinal, errorMessage(error));
        }
        if (remainingMilliseconds(captureDeadline, now) === 0) {
          throw new CollabError('CAPTURE_TIMEOUT', `artifact capture timed out: ${turnId}`);
        }
        throw error;
      }
    }
    return artifactPaths;
  }

  /**
   * Terminates one task browser and records idempotent local closure.
   *
   * The close intent is persisted as `closing` before any browser termination side effect;
   * an interrupted close stays `closing` and a repeated call continues the cleanup.
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
        const token = randomUUID();
        try {
          if (!store.acquireCloseTaskOperation(taskId, token)) {
            return { taskId, wasOpen: false, alreadyClosed: true };
          }
          return await this.#withAcquiredTaskOperation(store, taskId, token, async (observer) => {
            const task = store.requireTask(taskId);
            store.markTaskClosing(taskId);
            const result = await this.#browser.closeTask(taskId, task.playwrightSession, observer);
            const availability = await this.#browser.sessionAvailability(task.playwrightSession);
            if (availability !== 'missing') {
              throw new CollabError(
                'BROWSER_SESSION_NOT_CLOSED',
                `browser session could not be confirmed missing after close: ${availability}`,
              );
            }
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
   * The canonical identity is journaled as a prepared archive operation before the click;
   * an interrupted archive is reconciled by observing the actual Web archive state first.
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
        const conversationUrl = task.conversationUrl ?? `https://chatgpt.com/c/${conversationId}`;
        const existingOperation = store.getUncommittedTaskOperation(taskId);
        if (existingOperation !== null && existingOperation.kind === 'archive') {
          return this.#recoverArchive(store, taskId, existingOperation, conversationId, conversationUrl, observer);
        }
        const operation = store.createOperation({
          id: this.#idGenerator(),
          kind: 'archive',
          step: 'archive',
          taskId,
          turnId: null,
          sessionName: task.playwrightSession,
          evidence: {
            observedAt: new Date().toISOString(),
            sessionName: task.playwrightSession,
            conversationId,
            postcondition: 'target canonical identity recorded before the Archive command',
          },
        });
        store.markOperationEffectUnknown(operation.id, {
          observedAt: new Date().toISOString(),
          sessionName: task.playwrightSession,
          conversationId,
          postcondition: 'Archive command released',
        });
        const result = await this.#browser.archive(
          taskId,
          task.playwrightSession,
          conversationId,
          conversationUrl,
          observer,
        );
        store.commitOperation(operation.id, 'automatic', {
          observedAt: new Date().toISOString(),
          sessionName: task.playwrightSession,
          pageUrl: conversationUrl,
          postcondition: 'conversation archived and canonical binding restored',
          conversationId,
          archived: true,
          bindingRestored: true,
        });
        return { taskId, conversationId: result.conversationId };
      });
    });
  }

  /**
   * Reconciles an interrupted archive operation by observing the real Web state first.
   *
   * @param store Current process-local state connection.
   * @param taskId Task identifier.
   * @param operation Uncommitted archive operation.
   * @param conversationId Database-bound canonical identity.
   * @param conversationUrl Recorded canonical conversation URL.
   * @param observer Task-lease child-process observer.
   * @returns The confirmed archived conversation identity.
   * @throws {CollabError} If the archive state cannot be proven and no retry is allowed.
   * @throws {Error} If state or browser operations fail.
   */
  async #recoverArchive(
    store: StateStore,
    taskId: string,
    operation: OperationRecord,
    conversationId: string,
    conversationUrl: string,
    observer: BrowserOperationObserver,
  ): Promise<{ readonly taskId: string; readonly conversationId: string }> {
    const task = store.requireTask(taskId);
    if (operation.phase === 'prepared') {
      store.markOperationEffectUnknown(operation.id, {
        observedAt: new Date().toISOString(),
        sessionName: task.playwrightSession,
        conversationId,
        postcondition: 'Archive command released',
      });
      const result = await this.#browser.archive(
        taskId,
        task.playwrightSession,
        conversationId,
        conversationUrl,
        observer,
      );
      store.commitOperation(operation.id, 'automatic', {
        observedAt: new Date().toISOString(),
        sessionName: task.playwrightSession,
        conversationId,
        archived: true,
        bindingRestored: true,
      });
      return { taskId, conversationId: result.conversationId };
    }
    const observed = await this.#browser.observeArchiveState(
      taskId,
      task.playwrightSession,
      conversationUrl,
      conversationId,
      observer,
    );
    if (observed.status === 'archived') {
      await this.#browser.recoverConversation(
        taskId,
        task.playwrightSession,
        conversationUrl,
        conversationId,
        observer,
      );
      store.commitOperation(operation.id, 'automatic', {
        observedAt: new Date().toISOString(),
        sessionName: task.playwrightSession,
        pageUrl: conversationUrl,
        postcondition: 'already archived; canonical binding restored without a second click',
        conversationId,
        archived: true,
        bindingRestored: true,
      });
      return { taskId, conversationId };
    }
    if (observed.status === 'not-archived') {
      const result = await this.#browser.archive(
        taskId,
        task.playwrightSession,
        conversationId,
        conversationUrl,
        observer,
      );
      store.commitOperation(operation.id, 'automatic', {
        observedAt: new Date().toISOString(),
        sessionName: task.playwrightSession,
        conversationId,
        archived: true,
        bindingRestored: true,
      });
      return { taskId, conversationId: result.conversationId };
    }
    throw new CollabError(
      'ARCHIVE_STATE_UNKNOWN',
      `archive state could not be proven; no Archive click was repeated: ${observed.error}`,
    );
  }

  /**
   * Returns the read-only task status with the named-session availability probe.
   *
   * @param taskId Task identifier.
   * @returns The status snapshot and the single safe next action.
   * @throws {CollabError} If the task does not exist.
   * @throws {Error} If the state store or availability probe fails.
   */
  async status(taskId: string): Promise<StatusRecord> {
    return this.#withStore(async (store) => {
      const task = store.requireTask(taskId);
      const browserStatus = await this.#browser.sessionAvailability(task.playwrightSession);
      return store.getStatus(taskId, browserStatus);
    });
  }

  /**
   * Acquires the task lease and continues the persistent workflow along one recovery path.
   *
   * @param taskId Task identifier.
   * @returns The recovered status snapshot and the next safe action.
   * @throws {CollabError} If a page postcondition cannot be obtained or an adjudication is required.
   * @throws {Error} If state, browser, or seed operations fail.
   */
  async recover(taskId: string): Promise<StatusRecord> {
    return this.#withStore(async (store) => {
      while (true) {
        const token = randomUUID();
        try {
          store.acquireTaskOperation(taskId, 'recover', token);
          return await this.#withAcquiredTaskOperation(store, taskId, token, async (observer) => {
            return this.#recoverSnapshot(store, taskId, observer);
          });
        } catch (error) {
          if (!(error instanceof StateError) || error.code !== 'TASK_OPERATION_IN_PROGRESS') {
            throw error;
          }
          const operation = store.getTaskOperation(taskId);
          if (operation !== null && operation !== 'recover') {
            throw error;
          }
          await yieldTaskOperation();
        }
      }
    });
  }

  /**
   * Restores a verified safe composer for a known-unsubmitted send draft.
   *
   * Attempts the in-page cleanup first; when the page cannot be proven safe (for
   * example a residual file chooser blocks the fixed CLI's modal guard), closes
   * the same-name session, rebuilds it from the shared seed with the same task
   * identity, restores the exact canonical conversation when bound, and verifies
   * the composer again. Never resends messages or migrates conversations.
   *
   * @param taskId Task whose composer is restored.
   * @param sessionName Task's stable Playwright named session.
   * @param conversationId Bound conversation identity, or null before binding.
   * @param conversationUrl Bound canonical URL, or null before binding.
   * @param attachmentNames Basenames that must disappear from the composer.
   * @param observer Task-lease child-process observer.
   * @throws {Error} If cleanup, close, rebuild, identity recovery, or re-verification fails.
   */
  async #recoverDraftComposer(
    taskId: string,
    sessionName: string,
    conversationId: string | null,
    conversationUrl: string | null,
    attachmentNames: readonly string[],
    observer: BrowserOperationObserver,
  ): Promise<void> {
    try {
      await this.#browser.cleanSendComposer(taskId, sessionName, conversationId, attachmentNames, observer);
      return;
    } catch {
      // The composer cannot be proven safe in-page; continue with the close-and-rebuild path.
    }
    const seedStatePath = await requireSeedState(this.#paths);
    await this.#browser.closeTask(taskId, sessionName, observer);
    await this.#browser.startTask(taskId, sessionName, seedStatePath, true, observer);
    if (conversationId !== null && conversationUrl !== null) {
      await this.#browser.recoverConversation(taskId, sessionName, conversationUrl, conversationId, observer);
    }
    await this.#browser.cleanSendComposer(taskId, sessionName, conversationId, attachmentNames, observer);
  }

  /**
   * Applies the unique recovery path implied by the current persistent state.
   *
   * @param store Current process-local state connection.
   * @param taskId Task whose workflow is recovered.
   * @param observer Task-lease child-process observer.
   * @returns A fresh status snapshot after the single recovery action.
   * @throws {CollabError} If the page postcondition cannot be obtained.
   * @throws {Error} If state, browser, or seed operations fail.
   */
  async #recoverSnapshot(store: StateStore, taskId: string, observer: BrowserOperationObserver): Promise<StatusRecord> {
    const task = store.requireTask(taskId);
    let browserStatus = await this.#browser.sessionAvailability(task.playwrightSession);
    const before = store.getStatus(taskId, browserStatus);
    if (before.nextAction === 'none') {
      return before;
    }
    const operation = store.getUncommittedTaskOperation(taskId);
    const pendingTurn = store
      .listTurns(taskId)
      .filter((turn) => {
        return (
          turn.status === 'sending' ||
          turn.status === 'pending' ||
          turn.status === 'capturing' ||
          turn.status === 'unknown-submission'
        );
      })
      .at(-1);

    if (task.status === 'closing') {
      return before;
    }
    if (task.status === 'closed') {
      const seedStatePath = await requireSeedState(this.#paths);
      await this.#browser.startTask(taskId, task.playwrightSession, seedStatePath, true, observer);
      if (task.conversationId !== null && task.conversationUrl !== null) {
        await this.#browser.recoverConversation(
          taskId,
          task.playwrightSession,
          task.conversationUrl,
          task.conversationId,
          observer,
        );
      }
      store.reactivateClosedTask(taskId);
      const after = await this.#browser.sessionAvailability(task.playwrightSession);
      return store.getStatus(taskId, after);
    }
    const pageWorkPending =
      browserStatus === 'missing' && task.status !== 'starting' && (pendingTurn !== undefined || operation !== null);
    if (pageWorkPending) {
      const seedStatePath = await requireSeedState(this.#paths);
      await this.#browser.startTask(taskId, task.playwrightSession, seedStatePath, true, observer);
      if (task.conversationId !== null && task.conversationUrl !== null) {
        await this.#browser.recoverConversation(
          taskId,
          task.playwrightSession,
          task.conversationUrl,
          task.conversationId,
          observer,
        );
      }
      browserStatus = await this.#browser.sessionAvailability(task.playwrightSession);
    }
    if (pendingTurn !== undefined && (pendingTurn.status === 'pending' || pendingTurn.status === 'capturing')) {
      return store.getStatus(taskId, browserStatus);
    }
    if (pendingTurn !== undefined && pendingTurn.status === 'unknown-submission') {
      return store.getStatus(taskId, browserStatus);
    }
    if (operation !== null && operation.kind === 'send' && operation.step === 'submit') {
      if (operation.phase === 'needs-decision') {
        return store.getStatus(taskId, browserStatus);
      }
      if (operation.phase !== 'effect-unknown') {
        throw new CollabError(
          'OPERATION_PHASE_CONFLICT',
          `send operation is ${operation.phase}, expected effect-unknown: ${operation.id}`,
        );
      }
      return this.#recoverSubmittedSend(store, taskId, operation, pendingTurn, observer);
    }
    if (operation !== null && operation.kind === 'send' && operation.step === 'draft') {
      const task = store.requireTask(taskId);
      const sendingTurn = pendingTurn;
      await this.#recoverDraftComposer(
        taskId,
        task.playwrightSession,
        task.conversationId,
        task.conversationUrl,
        sendingTurn === undefined
          ? []
          : sendingTurn.attachmentPaths.map((attachmentPath) => {
              return basename(attachmentPath);
            }),
        observer,
      );
      if (sendingTurn !== undefined) {
        store.failSubmissionAndCommit(
          taskId,
          sendingTurn.id,
          operation.id,
          'send interrupted before submission; composer cleaned or rebuilt to a safe state',
          {
            observedAt: new Date().toISOString(),
            sessionName: task.playwrightSession,
            postcondition: 'target composer verified safe after draft recovery',
          },
        );
      }
      const after = await this.#browser.sessionAvailability(task.playwrightSession);
      return { ...store.getStatus(taskId, after), nextAction: 'send' };
    }
    if (operation !== null && operation.kind === 'archive') {
      const task = store.requireTask(taskId);
      if (task.conversationId === null || task.conversationUrl === null) {
        throw new CollabError(
          'CONVERSATION_NOT_ESTABLISHED',
          `archive recovery needs a recorded canonical conversation: ${taskId}`,
        );
      }
      await this.#recoverArchive(store, taskId, operation, task.conversationId, task.conversationUrl, observer);
      const after = await this.#browser.sessionAvailability(task.playwrightSession);
      return store.getStatus(taskId, after);
    }
    if (task.status === 'starting' || operation?.kind === 'start') {
      const seedStatePath = await requireSeedState(this.#paths);
      const browser = await this.#browser.startTask(taskId, task.playwrightSession, seedStatePath, true, observer);
      let recoveredOperation = operation;
      if (recoveredOperation !== null && recoveredOperation.step === 'session') {
        recoveredOperation = store.advanceOperationStep(recoveredOperation.id, 'project', {
          observedAt: new Date().toISOString(),
          sessionName: task.playwrightSession,
          pageUrl: browser.url,
          postcondition: 'fixed Project and blank composer verified',
        });
      }
      if (recoveredOperation !== null && recoveredOperation.step === 'project') {
        recoveredOperation = store.advanceOperationStep(recoveredOperation.id, 'configuration', {
          observedAt: new Date().toISOString(),
          sessionName: task.playwrightSession,
          pageUrl: browser.url,
          postcondition: 'current model GPT-5.6 Sol read back and Power slider at the maximum level',
          projectIdentity: browser.projectId,
          modelConfirmed: browser.modelConfirmed,
          powerConfirmed: browser.powerConfirmed,
          powerNow: browser.powerNow,
          powerMin: browser.powerMin,
          powerMax: browser.powerMax,
        });
      }
      if (recoveredOperation !== null) {
        store.commitOperation(recoveredOperation.id, 'automatic', {
          observedAt: new Date().toISOString(),
          sessionName: task.playwrightSession,
          pageUrl: browser.url,
          postcondition: 'start session resumed from seed',
          projectIdentity: browser.projectId,
          modelConfirmed: browser.modelConfirmed,
          powerConfirmed: browser.powerConfirmed,
          powerNow: browser.powerNow,
          powerMin: browser.powerMin,
          powerMax: browser.powerMax,
        });
      }
      if (task.status === 'starting') {
        store.activateTask(taskId);
      }
      const after = await this.#browser.sessionAvailability(task.playwrightSession);
      return store.getStatus(taskId, after);
    }
    if (browserStatus === 'missing') {
      const seedStatePath = await requireSeedState(this.#paths);
      await this.#browser.startTask(taskId, task.playwrightSession, seedStatePath, true, observer);
      const rebuilt = store.requireTask(taskId);
      if (rebuilt.conversationId !== null && rebuilt.conversationUrl !== null) {
        await this.#browser.recoverConversation(
          taskId,
          rebuilt.playwrightSession,
          rebuilt.conversationUrl,
          rebuilt.conversationId,
          observer,
        );
      }
      const after = await this.#browser.sessionAvailability(task.playwrightSession);
      return store.getStatus(taskId, after);
    }
    return store.getStatus(taskId, browserStatus);
  }

  /**
   * Verifies and applies a human submission adjudication on an unknown-submission turn.
   *
   * @param taskId Task identifier.
   * @param turnId Unknown-submission turn identifier.
   * @param verdict Human-provided submission fact.
   * @param conversationUrl Canonical conversation URL required by the submitted verdict.
   * @returns The resolved status snapshot.
   * @throws {CollabError} If the turn, operation, URL, page, or unique turn cannot be verified.
   * @throws {Error} If state or browser operations fail.
   */
  async resolveSubmission(
    taskId: string,
    turnId: string,
    verdict: 'submitted' | 'not-submitted',
    conversationUrl?: string,
  ): Promise<StatusRecord> {
    const canonicalUrl = verdict === 'submitted' ? requireCanonicalConversationUrl(conversationUrl) : null;
    return this.#withStore(async (store) => {
      return this.#withTaskOperation(store, taskId, 'resolve-submission', async (observer) => {
        const task = store.requireTask(taskId);
        const turn = store.requireTurn(taskId, turnId);
        if (turn.status !== 'unknown-submission') {
          throw new CollabError('TURN_NOT_RESOLVABLE', `turn is ${turn.status}: ${turnId}`);
        }
        const operation = store.getUncommittedTaskOperation(taskId);
        if (operation === null || operation.kind !== 'send' || operation.phase !== 'needs-decision') {
          throw new CollabError('OPERATION_NOT_RESOLVABLE', `task has no send operation awaiting decision: ${taskId}`);
        }
        const prompt = await readSavedPrompt(this.#paths, taskId, turnId);
        const attachmentNames = turn.attachmentPaths.map((path) => {
          return basename(path);
        });
        const previousUserTurnIdentity = await previousUserTurnIdentityBefore(store, taskId, turnId);
        const sessionName = task.playwrightSession;
        const resolvedAt = new Date().toISOString();
        if ((await this.#browser.sessionAvailability(sessionName)) === 'missing') {
          const seedStatePath = await requireSeedState(this.#paths);
          await this.#browser.startTask(taskId, sessionName, seedStatePath, true, observer);
          if (task.conversationId !== null && task.conversationUrl !== null) {
            await this.#browser.recoverConversation(
              taskId,
              sessionName,
              task.conversationUrl,
              task.conversationId,
              observer,
            );
          }
        }
        if (verdict === 'submitted' && canonicalUrl !== null) {
          const verified = await this.#browser.resolveSubmittedConversation(
            taskId,
            sessionName,
            canonicalUrl,
            task.conversationId,
            store.getStartProjectIdentity(taskId),
            previousUserTurnIdentity,
            prompt,
            attachmentNames,
            observer,
          );
          store.commitSubmittedTurn(
            taskId,
            turnId,
            verified.conversationId,
            verified.conversationUrl,
            verified.userTurnIdentity,
            operation.id,
            {
              observedAt: resolvedAt,
              sessionName,
              pageUrl: verified.conversationUrl,
              postcondition: 'submitted adjudication verified the unique user turn',
              conversationId: verified.conversationId,
              userTurnIdentity: verified.userTurnIdentity,
              promptVerbatimMatch: true,
              attachmentNamesMatch: true,
              decision: 'submitted',
              canonicalUrl,
              pageVerification: 'canonical conversation and unique matching user turn verified in the fixed Project',
            },
            'human',
          );
        } else {
          await this.#browser.verifySafeComposer(
            taskId,
            sessionName,
            task.conversationId,
            store.getStartProjectIdentity(taskId),
            previousUserTurnIdentity,
            prompt,
            attachmentNames,
            observer,
          );
          store.failSubmissionAndCommit(
            taskId,
            turnId,
            operation.id,
            'human adjudication: message was not submitted',
            {
              observedAt: resolvedAt,
              sessionName,
              pageUrl: task.conversationUrl ?? null,
              postcondition: 'safe composer verified after not-submitted adjudication',
              decision: 'not-submitted',
              canonicalUrl: null,
              pageVerification: 'safe bound composer or blank target Project composer verified',
            },
            'human',
          );
        }
        const browserStatus = await this.#browser.sessionAvailability(sessionName);
        return store.getStatus(taskId, browserStatus);
      });
    });
  }

  /**
   * Applies a user-confirmed terminal response failure to one active pending turn.
   *
   * The user's failure fact is authoritative and never inferred. Under the task lease
   * the command rebuilds the same named browser and canonical conversation when
   * missing, verifies the exact recorded canonical conversation URL and identity, the
   * unique persisted target user turn, the absence of any later user turn, and a safe
   * empty composer, stops an exact visible `Stop answering` at most once, and only
   * then atomically fails the pending turn while recording the human adjudication,
   * page identity, target user turn, and Stop outcome in the turn error. A repeated
   * call after the recorded resolution is idempotent without browser actions; every
   * proof failure preserves the pending state and never creates a user turn.
   *
   * @param taskId Active task identifier.
   * @param turnId Pending turn whose Pro response the user confirmed failed.
   * @param verdict Required terminal failure verdict.
   * @returns The status snapshot with `nextAction: send` after resolution.
   * @throws {CollabError} If the task, turn, conversation, page, or Stop proof fails.
   * @throws {Error} If state, browser, or seed operations fail.
   */
  async resolveTurn(taskId: string, turnId: string, verdict: 'failed'): Promise<StatusRecord> {
    if (verdict !== 'failed') {
      throw new CollabError('USAGE', 'resolve-turn verdict must be failed');
    }
    return this.#withStore(async (store) => {
      return this.#withTaskOperation(store, taskId, 'resolve-turn', async (observer) => {
        const task = store.requireTask(taskId);
        const turn = store.requireTurn(taskId, turnId);
        if (task.status !== 'active') {
          throw new CollabError('TASK_NOT_ACTIVE', `task is ${task.status}: ${taskId}`);
        }
        const recorded = store.getFailedTurnResolution(taskId, turnId);
        if (turn.status === 'failed' && recorded !== null) {
          const browserStatus = await this.#browser.sessionAvailability(task.playwrightSession);
          return { ...store.getStatus(taskId, browserStatus), nextAction: 'send' };
        }
        if (turn.status !== 'pending') {
          throw new CollabError('TURN_NOT_RESOLVABLE', `turn is ${turn.status}: ${turnId}`);
        }
        if (task.conversationId === null || task.conversationUrl === null) {
          throw new CollabError('TRANSCRIPT_INCONSISTENT', `resolvable task has no conversation: ${taskId}`);
        }
        if (turn.userTurnIdentity === null) {
          throw new CollabError('TRANSCRIPT_INCONSISTENT', `pending turn has no user turn identity: ${turnId}`);
        }
        const sessionName = task.playwrightSession;
        const resolvedAt = new Date().toISOString();
        if ((await this.#browser.sessionAvailability(sessionName)) === 'missing') {
          const seedStatePath = await requireSeedState(this.#paths);
          await this.#browser.startTask(taskId, sessionName, seedStatePath, true, observer);
          await this.#browser.recoverConversation(
            taskId,
            sessionName,
            task.conversationUrl,
            task.conversationId,
            observer,
          );
        }
        const verified = await this.#browser.resolveFailedTurn(
          taskId,
          sessionName,
          task.conversationId,
          turn.userTurnIdentity,
          task.conversationUrl,
          observer,
        );
        assertConversation(taskId, task.conversationId, task.conversationUrl, verified);
        store.failPendingTurnWithResolution(taskId, turnId, {
          adjudication: 'failed',
          resolvedAt,
          pageUrl: verified.conversationUrl,
          userTurnIdentity: verified.userTurnIdentity,
          stop: verified.stop,
        });
        const browserStatus = await this.#browser.sessionAvailability(sessionName);
        return { ...store.getStatus(taskId, browserStatus), nextAction: 'send' };
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
    return this.#withAcquiredTaskOperation(store, taskId, token, action);
  }

  /**
   * Runs one browser action under a lease already acquired by the caller's state gate.
   *
   * @param store Current process-local state connection.
   * @param taskId Task whose named browser session will be used.
   * @param token Current lease token used for observer updates and release.
   * @param action Side effect and state transition performed while the lease is held.
   * @returns The action result after the lease is released.
   * @throws {Error} If the action, observer state update, or lease release fails.
   */
  async #withAcquiredTaskOperation<T>(
    store: StateStore,
    taskId: string,
    token: string,
    action: (observer: BrowserOperationObserver) => Promise<T>,
  ): Promise<T> {
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
  const artifactPaths: string[] = [];
  for (const artifact of store.listArtifacts(taskId, turnId)) {
    if (artifact.status !== 'completed' || artifact.localPath === null) {
      throw new CollabError('ARTIFACT_INCONSISTENT', `completed turn has incomplete artifact: ${artifact.ordinal}`);
    }
    artifactPaths.push(await requireArtifactFile(artifact.localPath));
  }
  return {
    status: 'completed',
    taskId,
    turnId,
    responsePath: await requireResponse(turn.responsePath),
    artifactPaths,
  };
}

/**
 * Verifies that a browser result stayed on the database-bound conversation.
 *
 * @param taskId Task used in failure diagnostics.
 * @param expectedConversationId Database-bound canonical identity.
 * @param expectedConversationUrl Database-bound canonical URL.
 * @param observed Browser-observed identity after an operation.
 * @returns Nothing for an exact identity match.
 * @throws {CollabError} If the browser crossed into another conversation.
 */
function assertConversation(
  taskId: string,
  expectedConversationId: string,
  expectedConversationUrl: string,
  observed: { readonly conversationId: string; readonly conversationUrl: string },
): void {
  if (observed.conversationId !== expectedConversationId || observed.conversationUrl !== expectedConversationUrl) {
    throw new CollabError('CONVERSATION_MISMATCH', `wait observed a different conversation: ${taskId}`);
  }
}

/**
 * Enforces the finite positive integer duration contract at the service boundary.
 *
 * @param name Parameter name used in stable diagnostics.
 * @param value Unknown numeric value supplied by a direct caller.
 * @returns Nothing for a finite positive safe integer.
 * @throws {CollabError} If the duration is zero, fractional, unsafe, or non-finite.
 */
function requirePositiveMilliseconds(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CollabError('USAGE', `${name} must be a finite positive integer`);
  }
}

/**
 * Converts a monotonic deadline to a positive integer browser budget.
 *
 * @param deadline Monotonic `performance.now()` deadline.
 * @param now Injectable monotonic clock matching the deadline's time base.
 * @returns Zero after expiry, otherwise the remaining whole-millisecond ceiling.
 * @throws {Error} This pure arithmetic helper does not throw for a finite deadline.
 */
function remainingMilliseconds(
  deadline: number,
  now: () => number = () => {
    return performance.now();
  },
): number {
  return Math.max(0, Math.ceil(deadline - now()));
}

type CaptureOperationOutcome<T> =
  | { readonly kind: 'completed'; readonly value: T; readonly settledAt: number }
  | { readonly kind: 'failed'; readonly error: unknown; readonly settledAt: number };

/**
 * Runs one response or artifact capture operation behind the shared host monotonic watchdog.
 *
 * @param deadline Shared monotonic capture deadline for this wait call.
 * @param turnId Turn identifier used in the stable timeout diagnostic.
 * @param phase Capture phase used in the timeout diagnostic.
 * @param operation Browser operation started with the remaining budget and host cancellation signal.
 * @param now Injectable monotonic clock matching the deadline's time base.
 * @returns The operation result when it settles before the deadline.
 * @throws {CollabError} With `CAPTURE_TIMEOUT` after deadline expiry, including delayed failures.
 * @throws {Error} The original browser error when it settles before the deadline.
 */
async function captureOperationWithinDeadline<T>(
  deadline: number,
  turnId: string,
  phase: 'response' | 'artifact',
  operation: (remainingCaptureMs: number, signal: AbortSignal) => Promise<T>,
  now: () => number = () => {
    return performance.now();
  },
): Promise<T> {
  const remainingCaptureMs = remainingMilliseconds(deadline, now);
  if (remainingCaptureMs === 0) {
    throw captureTimeout(turnId, phase);
  }

  const controller = new AbortController();
  const outcome = Promise.resolve()
    .then(() => {
      return operation(remainingCaptureMs, controller.signal);
    })
    .then(
      (value): CaptureOperationOutcome<T> => {
        return { kind: 'completed', value, settledAt: now() };
      },
      (error: unknown): CaptureOperationOutcome<T> => {
        return { kind: 'failed', error, settledAt: now() };
      },
    );
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadlineReached = new Promise<{ readonly kind: 'deadline' }>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'deadline' });
    }, remainingCaptureMs);
  });
  const result = await Promise.race([outcome, deadlineReached]);
  if (deadlineTimer !== undefined) {
    clearTimeout(deadlineTimer);
  }

  if (result.kind === 'deadline') {
    await waitForCaptureOperationTermination(outcome);
    throw captureTimeout(turnId, phase);
  }
  if (result.settledAt >= deadline) {
    controller.abort();
    throw captureTimeout(turnId, phase);
  }
  if (result.kind === 'failed') {
    throw result.error;
  }
  return result.value;
}

/**
 * Gives an aborted browser boundary time to reap its gate and guarded command before lease release.
 *
 * @param outcome Non-rejecting browser operation outcome.
 * @returns Nothing when the operation settles or the bounded cleanup allowance expires.
 * @throws {Error} Timers do not ordinarily throw.
 */
async function waitForCaptureOperationTermination<T>(outcome: Promise<CaptureOperationOutcome<T>>): Promise<void> {
  let cleanupTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    outcome.then(() => {
      return undefined;
    }),
    new Promise<void>((resolve) => {
      cleanupTimer = setTimeout(resolve, CAPTURE_ABORT_SETTLE_MS);
    }),
  ]);
  if (cleanupTimer !== undefined) {
    clearTimeout(cleanupTimer);
  }
}

/**
 * Constructs the single capture timeout used before and after the atomic boundary.
 *
 * @param turnId Turn whose shared capture deadline expired.
 * @param phase Capture phase used in the stable message.
 * @returns Stable capture timeout error.
 * @throws {Error} This pure constructor helper only allocates an error.
 */
function captureTimeout(turnId: string, phase: 'response' | 'artifact'): CollabError {
  return new CollabError('CAPTURE_TIMEOUT', `${phase} capture timed out: ${turnId}`);
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

/**
 * Validates the caller-provided canonical lowercase UUID v4 task identity before any side effect.
 *
 * @param taskId Task identity supplied by the host.
 * @returns Nothing for a canonical UUID v4.
 * @throws {CollabError} If the identity violates the canonical lowercase UUID v4 grammar.
 */
function requireCanonicalTaskId(taskId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(taskId)) {
    throw new CollabError('USAGE', 'taskId must be a canonical lowercase UUID v4');
  }
}

/**
 * Classifies a start failure whose page postcondition was deterministically violated.
 *
 * @param error Unknown value thrown by the browser boundary.
 * @returns `true` only for typed start-context failures that must mark the task failed.
 * @throws {Error} This classifier does not throw for ordinary values.
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

/**
 * Reads the immutable prompt copy published before the send side effect.
 *
 * @param paths Resolved Collab paths.
 * @param taskId Owning task identifier.
 * @param turnId Turn whose prompt copy is read.
 * @returns The exact saved prompt text.
 * @throws {CollabError} If the prompt copy is missing or unreadable.
 * @throws {Error} If the file cannot be decoded as UTF-8.
 */
async function readSavedPrompt(paths: CollabPaths, taskId: string, turnId: string): Promise<string> {
  const target = resolve(paths.sessionsDirectory, taskId, 'turns', turnId, 'prompt.md');
  try {
    const bytes = await readFile(target);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CollabError('PROMPT_COPY_MISSING', `saved prompt copy is unreadable: ${target}: ${errorMessage(error)}`);
  }
}

/**
 * Resolves the nearest persisted user identity before the current turn.
 *
 * Pre-submission failures have no identity and are skipped. A turn failed after
 * submission retains its identity and remains the correct conversation anchor.
 *
 * @param store Current process-local state connection.
 * @param taskId Owning task identifier.
 * @param turnId Current turn whose predecessor anchor is needed.
 * @returns The nearest earlier user identity, or null when none was persisted.
 * @throws {Error} If the state store cannot be read.
 */
async function previousUserTurnIdentityBefore(
  store: StateStore,
  taskId: string,
  turnId: string,
): Promise<string | null> {
  const turns = store.listTurns(taskId);
  const index = turns.findIndex((turn) => {
    return turn.id === turnId;
  });
  if (index <= 0) {
    return null;
  }
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
    const identity = turns[previousIndex]?.userTurnIdentity;
    if (identity !== undefined && identity !== null) {
      return identity;
    }
  }
  return null;
}

/**
 * Validates the strict canonical conversation URL contract before any browser action.
 *
 * @param value Conversation URL supplied by the adjudication caller.
 * @returns The normalized `https://chatgpt.com/c/<conversationId>` URL.
 * @throws {CollabError} If the URL is absent or violates the canonical grammar.
 */
function requireCanonicalConversationUrl(value: string | undefined): string {
  if (value === undefined) {
    throw usageError('resolve-submission submitted requires <conversationUrl>');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CollabError('USAGE', 'conversationUrl must be a canonical https://chatgpt.com/c/<conversationId> URL');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') {
    throw new CollabError('USAGE', 'conversationUrl must be on https://chatgpt.com');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new CollabError('USAGE', 'conversationUrl must not contain credentials, query, or fragment');
  }
  const match = /^\/c\/([^/?#]+)\/?$/u.exec(url.pathname);
  if (match === null || match[1] === undefined || match[1].startsWith('WEB:')) {
    throw new CollabError('USAGE', 'conversationUrl must be a canonical /c/<conversationId> path');
  }
  return `${url.origin}/c/${match[1]}`;
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
        requireParameterCount(command, parameters, 1);
        io.writeOutput(jsonLine({ ok: true, command, ...(await service.start(required(parameters[0]))) }));
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
        requireParameterCount(command, parameters, 4);
        const [taskId, turnId, observationWindowMs, captureTimeoutMs] = parameters;
        io.writeOutput(
          jsonLine({
            ok: true,
            command,
            ...(await service.wait(
              required(taskId),
              required(turnId),
              parsePositiveMilliseconds('observationWindowMs', required(observationWindowMs)),
              parsePositiveMilliseconds('captureTimeoutMs', required(captureTimeoutMs)),
            )),
          }),
        );
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
      case 'status': {
        requireParameterCount(command, parameters, 1);
        io.writeOutput(jsonLine({ ok: true, command, ...(await service.status(required(parameters[0]))) }));
        return 0;
      }
      case 'recover': {
        requireParameterCount(command, parameters, 1);
        io.writeOutput(jsonLine({ ok: true, command, ...(await service.recover(required(parameters[0]))) }));
        return 0;
      }
      case 'resolve-submission': {
        if (parameters.length < 3) {
          throw usageError(
            'resolve-submission requires <taskId> <turnId> submitted <conversationUrl> or <taskId> <turnId> not-submitted',
          );
        }
        const [taskId, turnId, verdict, ...rest] = parameters;
        if (verdict === 'submitted') {
          if (rest.length !== 1) {
            throw usageError('resolve-submission submitted requires exactly <conversationUrl>');
          }
          io.writeOutput(
            jsonLine({
              ok: true,
              command,
              ...(await service.resolveSubmission(required(taskId), required(turnId), 'submitted', required(rest[0]))),
            }),
          );
          return 0;
        }
        if (verdict === 'not-submitted') {
          if (rest.length !== 0) {
            throw usageError('resolve-submission not-submitted takes no extra parameters');
          }
          io.writeOutput(
            jsonLine({
              ok: true,
              command,
              ...(await service.resolveSubmission(required(taskId), required(turnId), 'not-submitted')),
            }),
          );
          return 0;
        }
        throw usageError('resolve-submission verdict must be submitted or not-submitted');
      }
      case 'resolve-turn': {
        requireParameterCount(command, parameters, 3);
        const [taskId, turnId, verdict] = parameters;
        if (verdict !== 'failed') {
          throw usageError('resolve-turn verdict must be failed');
        }
        io.writeOutput(
          jsonLine({
            ok: true,
            command,
            ...(await service.resolveTurn(required(taskId), required(turnId), 'failed')),
          }),
        );
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
 * Parses one CLI duration without accepting exponent, sign, whitespace, or fractions.
 *
 * @param name Parameter name used in usage diagnostics.
 * @param value Positional CLI value.
 * @returns A finite positive safe integer count of milliseconds.
 * @throws {CollabError} If the value is outside the duration grammar.
 */
function parsePositiveMilliseconds(name: string, value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw usageError(`${name} must be a finite positive integer`);
  }
  const milliseconds = Number(value);
  requirePositiveMilliseconds(name, milliseconds);
  return milliseconds;
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
  node "<skill-directory>/scripts/collab.ts" start <taskId>
  node "<skill-directory>/scripts/collab.ts" send <taskId> <promptPath> [attachmentPath ...]
  node "<skill-directory>/scripts/collab.ts" wait <taskId> <turnId> <observationWindowMs> <captureTimeoutMs>
  node "<skill-directory>/scripts/collab.ts" status <taskId>
  node "<skill-directory>/scripts/collab.ts" recover <taskId>
  node "<skill-directory>/scripts/collab.ts" resolve-submission <taskId> <turnId> submitted <conversationUrl>
  node "<skill-directory>/scripts/collab.ts" resolve-submission <taskId> <turnId> not-submitted
  node "<skill-directory>/scripts/collab.ts" resolve-turn <taskId> <turnId> failed
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
