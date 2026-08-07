import { existsSync, statSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type TaskStatus = 'starting' | 'active' | 'closing' | 'closed' | 'failed';
export type TurnStatus = 'sending' | 'pending' | 'capturing' | 'completed' | 'failed' | 'unknown-submission';
export type ArtifactStatus = 'pending' | 'completed';
export type OperationKind = 'setup' | 'start' | 'send' | 'archive';
export type OperationPhase = 'prepared' | 'effect-unknown' | 'needs-decision' | 'committed';
export type ResolutionSource = 'automatic' | 'human';
export type BrowserStatus = 'available' | 'missing' | 'unknown';
export type NextAction = 'setup' | 'start' | 'send' | 'wait' | 'recover' | 'resolve-submission' | 'close' | 'none';
export type OperationStep =
  | 'login'
  | 'seed'
  | 'cleanup'
  | 'session'
  | 'project'
  | 'configuration'
  | 'draft'
  | 'submit'
  | 'archive'
  | 'restore';

/**
 * Defines the ordered verified steps each operation kind advances through.
 *
 * `progress` is the zero-based index of the current step inside this list.
 */
export const OPERATION_STEPS: Readonly<Record<OperationKind, readonly OperationStep[]>> = {
  setup: ['login', 'seed', 'cleanup'],
  start: ['session', 'project', 'configuration'],
  send: ['draft', 'submit'],
  archive: ['archive', 'restore'],
};

export interface ArtifactDescription {
  readonly sourceUrl: string;
  readonly label: string;
}

export interface TaskRecord {
  readonly id: string;
  readonly playwrightSession: string;
  readonly conversationId: string | null;
  readonly conversationUrl: string | null;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface TurnRecord {
  readonly taskId: string;
  readonly id: string;
  readonly status: TurnStatus;
  readonly promptPath: string;
  readonly attachmentPaths: readonly string[];
  readonly userTurnIdentity: string | null;
  readonly responsePath: string | null;
  readonly artifactSetRecorded: boolean;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OperationEvidence {
  readonly observedAt: string;
  readonly sessionName: string;
  readonly pageUrl?: string | null;
  readonly postcondition?: string | null;
  readonly seedValidated?: boolean;
  readonly sessionClosed?: boolean;
  readonly projectIdentity?: string | null;
  readonly modelConfirmed?: boolean;
  readonly powerConfirmed?: boolean;
  readonly powerNow?: number;
  readonly powerMin?: number;
  readonly powerMax?: number;
  readonly conversationId?: string | null;
  readonly userTurnIdentity?: string | null;
  readonly promptVerbatimMatch?: boolean;
  readonly attachmentNamesMatch?: boolean;
  readonly archived?: boolean;
  readonly bindingRestored?: boolean;
  readonly decision?: 'submitted' | 'not-submitted';
  readonly canonicalUrl?: string | null;
  readonly pageVerification?: string | null;
}

export interface OperationRecord {
  readonly id: string;
  readonly kind: OperationKind;
  readonly step: OperationStep;
  readonly phase: OperationPhase;
  readonly progress: number;
  readonly taskId: string | null;
  readonly turnId: string | null;
  readonly sessionName: string;
  readonly evidence: OperationEvidence;
  readonly resolutionSource: ResolutionSource | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt: string | null;
}

export interface StatusRecord {
  readonly taskId: string;
  readonly taskStatus: TaskStatus;
  readonly turnId: string | null;
  readonly turnStatus: TurnStatus | null;
  readonly browserStatus: BrowserStatus;
  readonly operationKind: OperationKind | null;
  readonly operationStep: OperationStep | null;
  readonly operationPhase: OperationPhase | null;
  readonly operationProgress: number | null;
  readonly evidence: OperationEvidence | null;
  readonly error: string | null;
  readonly nextAction: NextAction;
}

export interface OperationInsert {
  readonly id: string;
  readonly kind: OperationKind;
  readonly step: OperationStep;
  readonly taskId: string | null;
  readonly turnId: string | null;
  readonly sessionName: string;
  readonly evidence?: OperationEvidence;
}

export interface ArtifactRecord {
  readonly taskId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly sourceUrl: string;
  readonly label: string;
  readonly filename: string | null;
  readonly localPath: string | null;
  readonly status: ArtifactStatus;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class StateError extends Error {
  readonly code: string;

  /**
   * Creates a stable state-boundary error.
   *
   * @param code Machine-readable failure code for CLI output and tests.
   * @param message Human-readable failure reason.
   * @throws {Error} This constructor does not throw beyond ordinary allocation failures.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export class StateStore {
  readonly #database: DatabaseSync;

  /**
   * Opens one process-local SQLite connection and installs the current schema.
   *
   * @param databasePath Absolute path to the Collab coordination database.
   * @throws {Error} If SQLite cannot open, configure, or initialize the database.
   */
  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec('PRAGMA foreign_keys = ON');
    executeWithBusyRetry(this.#database, 'PRAGMA journal_mode = WAL', 5000);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS task (
        id TEXT PRIMARY KEY,
        playwright_session TEXT NOT NULL UNIQUE,
        conversation_id TEXT,
        conversation_url TEXT,
        status TEXT NOT NULL CHECK (status IN ('starting', 'active', 'closing', 'closed', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        browser_operation_token TEXT,
        browser_operation_pid INTEGER,
        browser_operation_name TEXT,
        browser_operation_child_pid INTEGER,
        browser_operation_command_pid INTEGER
      ) STRICT;
    `);
    migrateTaskStatuses(this.#database);

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS turn (
        task_id TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('sending', 'pending', 'capturing', 'completed', 'failed', 'unknown-submission')
        ),
        prompt_path TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        response_path TEXT,
        artifact_set_recorded INTEGER NOT NULL DEFAULT 0 CHECK (artifact_set_recorded IN (0, 1)),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, id),
        FOREIGN KEY (task_id) REFERENCES task(id)
      ) STRICT;
    `);
    migrateTurnIdentity(this.#database);

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS artifact (
        task_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        source_url TEXT NOT NULL,
        label TEXT NOT NULL,
        filename TEXT,
        local_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, turn_id, ordinal),
        UNIQUE (task_id, turn_id, source_url),
        FOREIGN KEY (task_id, turn_id) REFERENCES turn(task_id, id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS operation (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('setup', 'start', 'send', 'archive')),
        step TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('prepared', 'effect-unknown', 'needs-decision', 'committed')),
        progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0),
        task_id TEXT,
        turn_id TEXT,
        session_name TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        resolution_source TEXT CHECK (
          resolution_source IS NULL OR resolution_source IN ('automatic', 'human')
        ),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        committed_at TEXT,
        FOREIGN KEY (task_id) REFERENCES task(id),
        FOREIGN KEY (task_id, turn_id) REFERENCES turn(task_id, id)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS operation_task_uncommitted
        ON operation (task_id) WHERE phase != 'committed' AND task_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS operation_setup_uncommitted
        ON operation (kind) WHERE kind = 'setup' AND phase != 'committed';
    `);
  }

  /**
   * Closes this process-local database connection.
   *
   * @returns Nothing.
   * @throws {Error} If SQLite cannot close the connection.
   */
  close(): void {
    this.#database.close();
  }

  /**
   * Records a task reservation before its browser is started.
   *
   * @param taskId Caller-provided canonical task identifier.
   * @param playwrightSession Unique Playwright CLI session name.
   * @param status Initial lifecycle status; `starting` for a caller-provided start reservation.
   * @returns The inserted task record.
   * @throws {StateError} If either identifier already exists.
   * @throws {Error} If SQLite rejects the write.
   */
  createTask(taskId: string, playwrightSession: string, status: TaskStatus = 'active'): TaskRecord {
    const now = new Date().toISOString();
    try {
      this.#database
        .prepare(
          `INSERT INTO task (
            id, playwright_session, conversation_id, conversation_url,
            status, created_at, updated_at, closed_at
          ) VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL)`,
        )
        .run(taskId, playwrightSession, status, now, now);
    } catch (error) {
      if (!isSqliteConstraint(error)) {
        throw error;
      }
      throw new StateError('TASK_CONFLICT', `task or Playwright session already exists: ${errorMessage(error)}`);
    }
    return this.requireTask(taskId);
  }

  /**
   * Reserves a starting task and its start operation in one transaction.
   *
   * @param taskId Caller-provided canonical task identifier.
   * @param playwrightSession Unique Playwright CLI session name.
   * @param operationId Collision-resistant operation identifier.
   * @returns The inserted starting task.
   * @throws {StateError} If either identifier already exists or the task has an uncommitted operation.
   * @throws {Error} If SQLite rejects the transaction.
   */
  createStartingTask(taskId: string, playwrightSession: string, operationId: string): TaskRecord {
    return this.#transaction(() => {
      const now = new Date().toISOString();
      try {
        this.#database
          .prepare(
            `INSERT INTO task (
              id, playwright_session, conversation_id, conversation_url,
              status, created_at, updated_at, closed_at
            ) VALUES (?, ?, NULL, NULL, 'starting', ?, ?, NULL)`,
          )
          .run(taskId, playwrightSession, now, now);
      } catch (error) {
        if (!isSqliteConstraint(error)) {
          throw error;
        }
        throw new StateError('TASK_CONFLICT', `task or Playwright session already exists: ${errorMessage(error)}`);
      }
      this.#insertOperation({
        id: operationId,
        kind: 'start',
        step: 'session',
        taskId,
        turnId: null,
        sessionName: playwrightSession,
      });
      return this.requireTask(taskId);
    });
  }

  /**
   * Loads one task regardless of lifecycle status.
   *
   * @param taskId Task identifier.
   * @returns The task record, or `null` when it does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  getTask(taskId: string): TaskRecord | null {
    const row = this.#database.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
    return row === undefined ? null : decodeTask(row);
  }

  /**
   * Loads one task and rejects unknown identifiers.
   *
   * @param taskId Task identifier.
   * @returns The task record.
   * @throws {StateError} If the task does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  requireTask(taskId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (task === null) {
      throw new StateError('TASK_NOT_FOUND', `task does not exist: ${taskId}`);
    }
    return task;
  }

  /**
   * Loads one task and enforces the active lifecycle gate.
   *
   * @param taskId Task identifier.
   * @returns The active task record.
   * @throws {StateError} If the task is unknown or not active.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  requireActiveTask(taskId: string): TaskRecord {
    const task = this.requireTask(taskId);
    if (task.status !== 'active') {
      throw new StateError('TASK_NOT_ACTIVE', `task is ${task.status}: ${taskId}`);
    }
    return task;
  }

  /**
   * Acquires the task-local browser-operation lease after every recorded owner and command has exited.
   *
   * @param taskId Task whose named browser session will be operated.
   * @param operation Human-readable operation name retained for conflict diagnostics.
   * @param token Collision-resistant owner token for release authorization.
   * @param ownerPid Process holding the lease; defaults to the current CLI process.
   * @returns Nothing after the lease is committed.
   * @throws {StateError} If another live process owns the task browser.
   * @throws {Error} If SQLite cannot commit the lease.
   */
  acquireTaskOperation(taskId: string, operation: string, token: string, ownerPid: number = process.pid): void {
    this.#transaction(() => {
      this.requireTask(taskId);
      this.#acquireTaskOperation(taskId, operation, token, ownerPid);
    });
  }

  /**
   * Atomically skips an already-closed task or acquires its close-operation lease.
   *
   * @param taskId Task whose named browser session will be closed.
   * @param token Collision-resistant owner token for release authorization.
   * @param ownerPid Process holding the lease; defaults to the current CLI process.
   * @returns `true` after acquiring the lease, or `false` without any write when the task is already closed.
   * @throws {StateError} If the task is unknown or another live process owns its browser.
   * @throws {Error} If SQLite cannot commit the state gate.
   */
  acquireCloseTaskOperation(taskId: string, token: string, ownerPid: number = process.pid): boolean {
    return this.#transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'closed') {
        return false;
      }
      this.#acquireTaskOperation(taskId, 'close', token, ownerPid);
      return true;
    });
  }

  /**
   * Records the exact spawned browser-command child under the current task lease.
   *
   * @param taskId Task whose named browser session is being operated.
   * @param token Current lease token.
   * @param childPid Spawned npx process identifier.
   * @returns Nothing after the child PID is committed.
   * @throws {StateError} If the caller no longer owns the lease.
   * @throws {Error} If SQLite cannot commit the child process.
   */
  attachTaskOperationChild(taskId: string, token: string, childPid: number): void {
    this.#transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE task SET browser_operation_child_pid = ?
           WHERE id = ? AND browser_operation_token = ? AND browser_operation_child_pid IS NULL`,
        )
        .run(childPid, taskId, token);
      if (result.changes !== 1) {
        throw new StateError('TASK_OPERATION_NOT_OWNED', `cannot attach child to task browser lease: ${taskId}`);
      }
    });
  }

  /**
   * Clears the exact browser-command child after it exits.
   *
   * @param taskId Task whose named browser session was operated.
   * @param token Current lease token.
   * @param childPid Spawned npx process identifier that exited.
   * @returns Nothing after the child PID is cleared.
   * @throws {StateError} If the caller no longer owns this child slot.
   * @throws {Error} If SQLite cannot commit the child exit.
   */
  detachTaskOperationChild(taskId: string, token: string, childPid: number): void {
    this.#transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE task SET browser_operation_child_pid = NULL
           WHERE id = ? AND browser_operation_token = ? AND browser_operation_child_pid = ?`,
        )
        .run(taskId, token, childPid);
      if (result.changes !== 1) {
        throw new StateError('TASK_OPERATION_NOT_OWNED', `cannot detach child from task browser lease: ${taskId}`);
      }
    });
  }

  /**
   * Records the exact command process started behind the browser-command gate.
   *
   * @param taskId Task whose named browser session is being operated.
   * @param token Current lease token.
   * @param commandPid Spawned command process identifier.
   * @returns Nothing after the command PID is committed.
   * @throws {StateError} If the caller no longer owns the lease or command slot.
   * @throws {Error} If SQLite cannot commit the command process.
   */
  attachTaskOperationCommand(taskId: string, token: string, commandPid: number): void {
    this.#transaction(() => {
      const value = this.#database
        .prepare(
          `SELECT browser_operation_token, browser_operation_command_pid
           FROM task WHERE id = ?`,
        )
        .get(taskId);
      const row = record(value);
      if (nullableText(row.browser_operation_token, 'task.browser_operation_token') !== token) {
        throw new StateError('TASK_OPERATION_NOT_OWNED', `cannot attach command to task browser lease: ${taskId}`);
      }
      const previousPid = nullableInteger(row.browser_operation_command_pid, 'task.browser_operation_command_pid');
      if (previousPid !== null && isProcessAlive(previousPid)) {
        throw new StateError(
          'TASK_OPERATION_CHILD_ACTIVE',
          `previous task browser command is still running: ${taskId}`,
        );
      }
      const result = this.#database
        .prepare(
          `UPDATE task SET browser_operation_command_pid = ?
           WHERE id = ? AND browser_operation_token = ?`,
        )
        .run(commandPid, taskId, token);
      if (result.changes !== 1) {
        throw new StateError('TASK_OPERATION_NOT_OWNED', `cannot attach command to task browser lease: ${taskId}`);
      }
    });
  }

  /**
   * Returns the operation currently holding a task browser lease.
   *
   * @param taskId Task whose operation is queried.
   * @returns Operation name, or null when no lease is present.
   * @throws {StateError} If the task does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  getTaskOperation(taskId: string): string | null {
    this.requireTask(taskId);
    const value = this.#database
      .prepare('SELECT browser_operation_token, browser_operation_name FROM task WHERE id = ?')
      .get(taskId);
    const row = record(value);
    const token = nullableText(row.browser_operation_token, 'task.browser_operation_token');
    return token === null ? null : nullableText(row.browser_operation_name, 'task.browser_operation_name');
  }

  /**
   * Releases a task-local browser-operation lease owned by the supplied token.
   *
   * @param taskId Task whose named browser session was operated.
   * @param token Lease token returned by the acquiring caller.
   * @returns Nothing after the lease is cleared.
   * @throws {StateError} If the token no longer owns the lease.
   * @throws {Error} If SQLite cannot commit the release.
   */
  releaseTaskOperation(taskId: string, token: string): void {
    this.#transaction(() => {
      const value = this.#database
        .prepare(
          `SELECT browser_operation_token, browser_operation_command_pid
           FROM task WHERE id = ?`,
        )
        .get(taskId);
      const row = record(value);
      if (nullableText(row.browser_operation_token, 'task.browser_operation_token') !== token) {
        throw new StateError('TASK_OPERATION_NOT_OWNED', `task browser lease is not owned by this process: ${taskId}`);
      }
      const commandPid = nullableInteger(row.browser_operation_command_pid, 'task.browser_operation_command_pid');
      if (commandPid !== null && isProcessAlive(commandPid)) {
        throw new StateError('TASK_OPERATION_CHILD_ACTIVE', `task browser command is still running: ${taskId}`);
      }
      const now = new Date().toISOString();
      const result = this.#database
        .prepare(
          `UPDATE task
           SET browser_operation_token = NULL, browser_operation_pid = NULL,
               browser_operation_name = NULL, browser_operation_child_pid = NULL,
               browser_operation_command_pid = NULL, updated_at = ?
           WHERE id = ? AND browser_operation_token = ?`,
        )
        .run(now, taskId, token);
      if (result.changes !== 1) {
        throw new StateError('TASK_OPERATION_NOT_OWNED', `task browser lease is not owned by this process: ${taskId}`);
      }
    });
  }

  /**
   * Marks a browser-start failure without deleting task evidence.
   *
   * @param taskId Task identifier.
   * @returns The updated task record.
   * @throws {StateError} If the task does not exist or is already closed.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  failTask(taskId: string): TaskRecord {
    return this.#transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'closed') {
        throw new StateError('TASK_NOT_ACTIVE', `task is closed: ${taskId}`);
      }
      const now = new Date().toISOString();
      this.#database.prepare("UPDATE task SET status = 'failed', updated_at = ? WHERE id = ?").run(now, taskId);
      return this.requireTask(taskId);
    });
  }

  /**
   * Reserves the only unfinished turn allowed for one active task together with its send operation.
   *
   * @param taskId Owning task identifier.
   * @param turnId Collision-resistant turn identifier.
   * @param promptPath Absolute host prompt path retained for audit.
   * @param attachmentPaths Ordered absolute attachment paths retained for audit.
   * @param operationId Collision-resistant operation identifier.
   * @returns The inserted `sending` turn and its prepared send operation.
   * @throws {StateError} If the task is inactive, a turn conflicts, another turn is unfinished,
   *   or the task already has an uncommitted operation.
   * @throws {Error} If SQLite cannot commit the reservation.
   */
  beginSendTurn(
    taskId: string,
    turnId: string,
    promptPath: string,
    attachmentPaths: readonly string[],
    operationId: string,
  ): { readonly turn: TurnRecord; readonly operation: OperationRecord } {
    return this.#transaction(() => {
      const turn = this.#insertTurn(taskId, turnId, promptPath, attachmentPaths);
      const operation = this.#insertOperation({
        id: operationId,
        kind: 'send',
        step: 'draft',
        taskId,
        turnId,
        sessionName: this.requireTask(taskId).playwrightSession,
      });
      return { turn, operation };
    });
  }

  /**
   * Advances a send operation to the submit step and marks the release boundary atomically.
   *
   * @param operationId Send operation identifier.
   * @param evidence Evidence observed before command release.
   * @returns The submit-step effect-unknown operation.
   * @throws {StateError} If the operation is not at the prepared draft step.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  advanceSendToSubmitEffectUnknown(operationId: string, evidence?: OperationEvidence): OperationRecord {
    return this.#transaction(() => {
      const operation = this.requireOperation(operationId);
      if (operation.kind !== 'send' || operation.step !== 'draft' || operation.phase !== 'prepared') {
        throw new StateError('OPERATION_PHASE_CONFLICT', `operation is not at the prepared draft step`);
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE operation
           SET step = 'submit', phase = 'effect-unknown', progress = 1,
               evidence_json = ?, error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(evidence ?? null), now, operationId);
      return this.requireOperation(operationId);
    });
  }

  /**
   * Binds a proven submission and commits its send operation in one transaction.
   *
   * @param taskId Owning task identifier.
   * @param turnId Submission-attempt turn identifier.
   * @param conversationId Canonical ChatGPT conversation identifier.
   * @param conversationUrl Canonical `/c/<id>` URL observed after submission.
   * @param userTurnIdentity Exact DOM identity of the submitted user turn.
   * @param operationId Send operation identifier.
   * @param evidence Observed submission evidence.
   * @param resolutionSource Provenance of the resolution evidence.
   * @returns The updated pending turn.
   * @throws {StateError} If the lifecycle transition, identity, or operation is inconsistent.
   * @throws {Error} If SQLite cannot commit the complete transition.
   */
  commitSubmittedTurn(
    taskId: string,
    turnId: string,
    conversationId: string,
    conversationUrl: string,
    userTurnIdentity: string,
    operationId: string,
    evidence?: OperationEvidence,
    resolutionSource: ResolutionSource = 'automatic',
  ): TurnRecord {
    return this.#transaction(() => {
      const task = this.requireActiveTask(taskId);
      const turn = this.requireTurn(taskId, turnId);
      if (turn.status !== 'sending' && turn.status !== 'unknown-submission') {
        throw new StateError(
          'TURN_STATE_CONFLICT',
          `turn is ${turn.status}, expected sending or unknown-submission: ${turnId}`,
        );
      }
      if (
        task.conversationId !== null &&
        (task.conversationId !== conversationId ||
          conversationIdOf(task.conversationUrl) !== conversationIdOf(conversationUrl))
      ) {
        throw new StateError('CONVERSATION_MISMATCH', `task is already bound to a different conversation: ${taskId}`);
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE task
           SET conversation_id = ?, conversation_url = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(conversationId, conversationUrl, now, taskId);
      try {
        this.#database
          .prepare(
            `UPDATE turn
             SET status = 'pending', user_turn_identity = ?, error = NULL, updated_at = ?
             WHERE task_id = ? AND id = ?`,
          )
          .run(userTurnIdentity, now, taskId, turnId);
      } catch (error) {
        if (!isSqliteConstraint(error)) {
          throw error;
        }
        throw new StateError(
          'USER_TURN_IDENTITY_CONFLICT',
          `user turn identity already belongs to another turn: ${userTurnIdentity}`,
        );
      }
      this.#commitOperationRow(operationId, resolutionSource, evidence);
      return this.requireTurn(taskId, turnId);
    });
  }

  /**
   * Fails a proven non-submission and commits its send operation in one transaction.
   *
   * @param taskId Owning task identifier.
   * @param turnId Sending or unknown-submission turn identifier.
   * @param operationId Send operation identifier.
   * @param reason Concrete failed operation and cause.
   * @param evidence Observed non-submission evidence.
   * @param resolutionSource Provenance of the resolution.
   * @returns The updated failed turn.
   * @throws {StateError} If the turn or operation is in an unexpected state.
   * @throws {Error} If SQLite cannot commit the complete transition.
   */
  failSubmissionAndCommit(
    taskId: string,
    turnId: string,
    operationId: string,
    reason: string,
    evidence?: OperationEvidence,
    resolutionSource: ResolutionSource = 'automatic',
  ): TurnRecord {
    return this.#transaction(() => {
      const turn = this.requireTurn(taskId, turnId);
      if (turn.status === 'sending') {
        this.#finishSendingTurnRow(taskId, turnId, 'failed', reason);
      } else if (turn.status === 'unknown-submission') {
        this.#finishUnknownSubmissionTurnRow(taskId, turnId, 'failed', reason);
      } else {
        throw new StateError('TURN_STATE_CONFLICT', `turn is ${turn.status}, expected sending or unknown-submission`);
      }
      this.#commitOperationRow(operationId, resolutionSource, evidence, reason);
      return this.requireTurn(taskId, turnId);
    });
  }

  /**
   * Records the submission ambiguity and needs-decision operation in one transaction.
   *
   * @param taskId Owning task identifier.
   * @param turnId Sending turn identifier.
   * @param operationId Send operation identifier.
   * @param reason Concrete ambiguity at the submission boundary.
   * @param evidence Observed insufficient evidence.
   * @returns The updated unknown-submission turn.
   * @throws {StateError} If the turn or operation is in an unexpected state.
   * @throws {Error} If SQLite cannot commit the complete transition.
   */
  markSubmissionUnknownAndNeedsDecision(
    taskId: string,
    turnId: string,
    operationId: string,
    reason: string,
    evidence?: OperationEvidence,
  ): TurnRecord {
    return this.#transaction(() => {
      const turn = this.requireTurn(taskId, turnId);
      if (turn.status !== 'sending') {
        throw new StateError('TURN_STATE_CONFLICT', `turn is ${turn.status}, expected sending: ${turnId}`);
      }
      const now = new Date().toISOString();
      this.#database
        .prepare('UPDATE turn SET status = ?, error = ?, updated_at = ? WHERE task_id = ? AND id = ?')
        .run('unknown-submission', reason, now, taskId, turnId);
      const operation = this.requireOperation(operationId);
      if (operation.kind !== 'send' || operation.step !== 'submit' || operation.phase !== 'effect-unknown') {
        throw new StateError(
          'OPERATION_PHASE_CONFLICT',
          `only send: submit effect-unknown can enter needs-decision: ${operationId}`,
        );
      }
      this.#database
        .prepare(
          `UPDATE operation
           SET phase = 'needs-decision', evidence_json = ?, error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(evidence ?? null), reason, now, operationId);
      return this.requireTurn(taskId, turnId);
    });
  }

  /**
   * Reserves the only unfinished turn allowed for one active task.
   *
   * @param taskId Owning task identifier.
   * @param turnId Collision-resistant turn identifier.
   * @param promptPath Absolute host prompt path retained for audit.
   * @param attachmentPaths Ordered absolute attachment paths retained for audit.
   * @returns The inserted `sending` turn.
   * @throws {StateError} If the task is inactive, a turn conflicts, or another turn is unfinished.
   * @throws {Error} If SQLite cannot commit the reservation.
   */
  beginTurn(taskId: string, turnId: string, promptPath: string, attachmentPaths: readonly string[]): TurnRecord {
    return this.#transaction(() => {
      return this.#insertTurn(taskId, turnId, promptPath, attachmentPaths);
    });
  }

  /**
   * Commits a confirmed browser submission and binds the task's conversation and user turn identity.
   *
   * @param taskId Owning task identifier.
   * @param turnId Submission-attempt turn identifier.
   * @param conversationId Canonical ChatGPT conversation identifier.
   * @param conversationUrl Canonical `/c/<id>` URL observed after submission.
   * @param userTurnIdentity Exact DOM identity of the submitted user turn.
   * @returns The updated pending turn.
   * @throws {StateError} If the lifecycle transition or conversation identity is inconsistent.
   * @throws {Error} If SQLite cannot commit both updates atomically.
   */
  markTurnPending(
    taskId: string,
    turnId: string,
    conversationId: string,
    conversationUrl: string,
    userTurnIdentity: string,
  ): TurnRecord {
    return this.#transaction(() => {
      const task = this.requireActiveTask(taskId);
      const turn = this.requireTurn(taskId, turnId);
      if (turn.status !== 'unknown-submission' && turn.status !== 'sending') {
        throw new StateError(
          'TURN_STATE_CONFLICT',
          `turn is ${turn.status}, expected sending or unknown-submission: ${turnId}`,
        );
      }
      if (
        task.conversationId !== null &&
        (task.conversationId !== conversationId ||
          conversationIdOf(task.conversationUrl) !== conversationIdOf(conversationUrl))
      ) {
        throw new StateError('CONVERSATION_MISMATCH', `task is already bound to a different conversation: ${taskId}`);
      }

      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE task
           SET conversation_id = ?, conversation_url = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(conversationId, conversationUrl, now, taskId);
      try {
        this.#database
          .prepare(
            `UPDATE turn
             SET status = 'pending', user_turn_identity = ?, error = NULL, updated_at = ?
             WHERE task_id = ? AND id = ?`,
          )
          .run(userTurnIdentity, now, taskId, turnId);
      } catch (error) {
        if (!isSqliteConstraint(error)) {
          throw error;
        }
        throw new StateError(
          'USER_TURN_IDENTITY_CONFLICT',
          `user turn identity already belongs to another turn: ${userTurnIdentity}`,
        );
      }
      return this.requireTurn(taskId, turnId);
    });
  }

  /**
   * Records a known pre-submission failure while preserving the prompt transcript.
   *
   * @param taskId Owning task identifier.
   * @param turnId Sending turn identifier.
   * @param reason Concrete failed operation and cause.
   * @returns The updated failed turn.
   * @throws {StateError} If the turn is not currently `sending`.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  failSendingTurn(taskId: string, turnId: string, reason: string): TurnRecord {
    return this.#transaction(() => {
      return this.#finishSendingTurnRow(taskId, turnId, 'failed', reason);
    });
  }

  /**
   * Persists the conservative interruption state before any browser submission side effect.
   *
   * @param taskId Owning task identifier.
   * @param turnId Sending turn identifier.
   * @returns The turn protected against an orphaned CLI parent.
   * @throws {StateError} If the turn is not currently `sending`.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  markSubmissionAttempting(taskId: string, turnId: string): TurnRecord {
    return this.#finishSendingTurn(
      taskId,
      turnId,
      'unknown-submission',
      'browser submission attempt started but has not been reconciled',
    );
  }

  /**
   * Reclassifies a persisted submission attempt after the browser proves no message was submitted.
   *
   * @param taskId Owning task identifier.
   * @param turnId Ambiguous turn identifier.
   * @param reason Concrete pre-submission failure.
   * @returns The updated failed turn.
   * @throws {StateError} If the turn is not currently `unknown-submission`.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  failSubmissionAttempt(taskId: string, turnId: string, reason: string): TurnRecord {
    return this.#finishUnknownSubmissionTurn(taskId, turnId, 'failed', reason);
  }

  /**
   * Records a browser submission whose side effect cannot be proven either way.
   *
   * @param taskId Owning task identifier.
   * @param turnId Submission-attempt turn identifier.
   * @param reason Concrete ambiguity at the submission boundary.
   * @returns The updated unknown-submission turn.
   * @throws {StateError} If the turn is not currently `unknown-submission`.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  markUnknownSubmission(taskId: string, turnId: string, reason: string): TurnRecord {
    return this.#finishUnknownSubmissionTurn(taskId, turnId, 'unknown-submission', reason);
  }

  /**
   * Atomically freezes the response path and complete ordered artifact set before file publication.
   *
   * @param taskId Owning task identifier.
   * @param turnId Pending turn whose complete browser capture was obtained.
   * @param responsePath Deterministic immutable response transcript path.
   * @param artifacts Ordered unique logical artifact targets.
   * @returns The updated capturing turn after all rows commit together.
   * @throws {StateError} If the turn is not pending or artifact sources are duplicated.
   * @throws {Error} If SQLite cannot commit the complete capture boundary.
   */
  freezeCapture(
    taskId: string,
    turnId: string,
    responsePath: string,
    artifacts: readonly ArtifactDescription[],
  ): TurnRecord {
    return this.#transaction(() => {
      const turn = this.requireTurn(taskId, turnId);
      if (turn.status !== 'pending') {
        throw new StateError('TURN_STATE_CONFLICT', `turn is ${turn.status}, expected pending: ${turnId}`);
      }
      const sourceUrls = artifacts.map((artifact) => {
        return artifact.sourceUrl;
      });
      if (new Set(sourceUrls).size !== sourceUrls.length) {
        throw new StateError('ARTIFACT_CONFLICT', `artifact source URLs must be unique: ${turnId}`);
      }
      const existing = this.listArtifacts(taskId, turnId);
      if (turn.responsePath !== null || turn.artifactSetRecorded || existing.length !== 0) {
        throw new StateError('ARTIFACT_SET_INCONSISTENT', `pending turn has a partial capture boundary: ${turnId}`);
      }

      const now = new Date().toISOString();
      const insert = this.#database.prepare(
        `INSERT INTO artifact (
          task_id, turn_id, ordinal, source_url, label, filename,
          local_path, status, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?)`,
      );
      for (const [index, artifact] of artifacts.entries()) {
        insert.run(taskId, turnId, index + 1, artifact.sourceUrl, artifact.label, now, now);
      }
      this.#database
        .prepare(
          `UPDATE turn
           SET status = 'capturing', response_path = ?, artifact_set_recorded = 1,
               error = NULL, updated_at = ?
           WHERE task_id = ? AND id = ?`,
        )
        .run(responsePath, now, taskId, turnId);
      return this.requireTurn(taskId, turnId);
    });
  }

  /**
   * Verifies a recaptured ordered artifact set against the frozen capture boundary.
   *
   * @param taskId Owning task identifier.
   * @param turnId Capturing turn identifier.
   * @param artifacts Ordered unique logical artifact targets recaptured from the page.
   * @returns The unchanged stable ordered artifact rows.
   * @throws {StateError} If the turn is not fully frozen or the source order changed.
   * @throws {Error} If SQLite cannot read the capture boundary.
   */
  verifyArtifactSet(
    taskId: string,
    turnId: string,
    artifacts: readonly ArtifactDescription[],
  ): readonly ArtifactRecord[] {
    const turn = this.requireTurn(taskId, turnId);
    if (turn.status !== 'capturing' || turn.responsePath === null || !turn.artifactSetRecorded) {
      throw new StateError('TURN_STATE_CONFLICT', `turn has no complete capture boundary: ${turnId}`);
    }
    const existing = this.listArtifacts(taskId, turnId);
    if (
      existing.length !== artifacts.length ||
      existing.some((artifact, index) => {
        return artifact.sourceUrl !== artifacts[index]?.sourceUrl;
      })
    ) {
      throw new StateError('ARTIFACT_SET_INCONSISTENT', `artifact set changed while capturing: ${turnId}`);
    }
    return existing;
  }

  /**
   * Records the immutable destination selected after a browser download reports its suggested name.
   *
   * @param taskId Owning task identifier.
   * @param turnId Capturing turn identifier.
   * @param ordinal One-based artifact order.
   * @param filename Browser-suggested original filename.
   * @param localPath Deterministic final path inside the artifact ordinal directory.
   * @returns The updated pending artifact.
   * @throws {StateError} If the turn or artifact is not in a writable capture state.
   * @throws {Error} If SQLite cannot commit the destination.
   */
  setArtifactDestination(
    taskId: string,
    turnId: string,
    ordinal: number,
    filename: string,
    localPath: string,
  ): ArtifactRecord {
    return this.#transaction(() => {
      const turn = this.requireTurn(taskId, turnId);
      if (turn.status !== 'capturing') {
        throw new StateError('TURN_STATE_CONFLICT', `turn is ${turn.status}, expected capturing: ${turnId}`);
      }
      const artifact = this.requireArtifact(taskId, turnId, ordinal);
      if (artifact.status !== 'pending') {
        throw new StateError('ARTIFACT_STATE_CONFLICT', `artifact is ${artifact.status}: ${ordinal}`);
      }
      if (
        (artifact.filename !== null && artifact.filename !== filename) ||
        (artifact.localPath !== null && artifact.localPath !== localPath)
      ) {
        throw new StateError('ARTIFACT_INCONSISTENT', `artifact destination changed: ${ordinal}`);
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE artifact
           SET filename = ?, local_path = ?, error = NULL, updated_at = ?
           WHERE task_id = ? AND turn_id = ? AND ordinal = ?`,
        )
        .run(filename, localPath, now, taskId, turnId, ordinal);
      return this.requireArtifact(taskId, turnId, ordinal);
    });
  }

  /**
   * Retains a concrete retryable artifact failure without ending the capture.
   *
   * @param taskId Owning task identifier.
   * @param turnId Capturing turn identifier.
   * @param ordinal One-based artifact order.
   * @param reason Concrete browser, download, or publication failure.
   * @returns The still-pending artifact with updated diagnostic state.
   * @throws {StateError} If the artifact is not pending.
   * @throws {Error} If SQLite cannot commit the diagnostic.
   */
  recordArtifactError(taskId: string, turnId: string, ordinal: number, reason: string): ArtifactRecord {
    return this.#transaction(() => {
      const artifact = this.requireArtifact(taskId, turnId, ordinal);
      if (artifact.status !== 'pending') {
        throw new StateError('ARTIFACT_STATE_CONFLICT', `artifact is ${artifact.status}: ${ordinal}`);
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE artifact SET error = ?, updated_at = ?
           WHERE task_id = ? AND turn_id = ? AND ordinal = ?`,
        )
        .run(reason, now, taskId, turnId, ordinal);
      return this.requireArtifact(taskId, turnId, ordinal);
    });
  }

  /**
   * Marks one artifact complete only after its recorded final file is visible.
   *
   * @param taskId Owning task identifier.
   * @param turnId Capturing turn identifier.
   * @param ordinal One-based artifact order.
   * @returns The completed artifact.
   * @throws {StateError} If its destination is missing, unreadable, or in another state.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  completeArtifact(taskId: string, turnId: string, ordinal: number): ArtifactRecord {
    const artifact = this.requireArtifact(taskId, turnId, ordinal);
    if (artifact.filename === null || artifact.localPath === null || !isRegularFile(artifact.localPath)) {
      throw new StateError('ARTIFACT_MISSING', `artifact must exist before completion: ${ordinal}`);
    }
    return this.#transaction(() => {
      const current = this.requireArtifact(taskId, turnId, ordinal);
      if (current.status !== 'pending') {
        throw new StateError('ARTIFACT_STATE_CONFLICT', `artifact is ${current.status}: ${ordinal}`);
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE artifact SET status = 'completed', error = NULL, updated_at = ?
           WHERE task_id = ? AND turn_id = ? AND ordinal = ?`,
        )
        .run(now, taskId, turnId, ordinal);
      return this.requireArtifact(taskId, turnId, ordinal);
    });
  }

  /**
   * Marks a capturing turn completed only after its response and every artifact are visible.
   *
   * @param taskId Owning task identifier.
   * @param turnId Capturing turn identifier.
   * @param responsePath Immutable response transcript path.
   * @returns The updated completed turn.
   * @throws {StateError} If the capture is incomplete, inconsistent, or missing a file.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  completeTurn(taskId: string, turnId: string, responsePath: string): TurnRecord {
    if (!isRegularFile(responsePath)) {
      throw new StateError('RESPONSE_MISSING', `response must exist before completion: ${responsePath}`);
    }
    return this.#transaction(() => {
      const turn = this.requireTurn(taskId, turnId);
      if (turn.status !== 'capturing') {
        throw new StateError('TURN_STATE_CONFLICT', `turn is ${turn.status}, expected capturing: ${turnId}`);
      }
      if (turn.responsePath !== responsePath) {
        throw new StateError('TRANSCRIPT_INCONSISTENT', `response path changed while capturing: ${turnId}`);
      }
      if (!turn.artifactSetRecorded) {
        throw new StateError('ARTIFACT_INCOMPLETE', `artifact set was not recorded: ${turnId}`);
      }
      const artifacts = this.listArtifacts(taskId, turnId);
      for (const artifact of artifacts) {
        if (artifact.status !== 'completed' || artifact.localPath === null || !isRegularFile(artifact.localPath)) {
          throw new StateError('ARTIFACT_INCOMPLETE', `artifact is not complete and readable: ${artifact.ordinal}`);
        }
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE turn
           SET status = 'completed', error = NULL, updated_at = ?
           WHERE task_id = ? AND id = ?`,
        )
        .run(now, taskId, turnId);
      return this.requireTurn(taskId, turnId);
    });
  }

  /**
   * Inserts one sending turn row inside the caller's immediate transaction.
   *
   * @param taskId Owning task identifier.
   * @param turnId Collision-resistant turn identifier.
   * @param promptPath Absolute host prompt path retained for audit.
   * @param attachmentPaths Ordered absolute attachment paths retained for audit.
   * @returns The inserted `sending` turn.
   * @throws {StateError} If the task is inactive, a turn conflicts, or another turn is unfinished.
   * @throws {Error} If SQLite cannot commit the reservation.
   */
  #insertTurn(taskId: string, turnId: string, promptPath: string, attachmentPaths: readonly string[]): TurnRecord {
    this.requireActiveTask(taskId);
    const unfinished = this.#database
      .prepare(
        `SELECT id FROM turn
         WHERE task_id = ? AND status IN ('sending', 'pending', 'capturing', 'unknown-submission')
         LIMIT 1`,
      )
      .get(taskId);
    if (unfinished !== undefined) {
      throw new StateError('TURN_IN_PROGRESS', `task already has an unfinished turn: ${taskId}`);
    }

    const now = new Date().toISOString();
    try {
      this.#database
        .prepare(
          `INSERT INTO turn (
            task_id, id, status, prompt_path, attachments_json,
            response_path, error, created_at, updated_at
          ) VALUES (?, ?, 'sending', ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(taskId, turnId, promptPath, JSON.stringify(attachmentPaths), now, now);
    } catch (error) {
      if (!isSqliteConstraint(error)) {
        throw error;
      }
      throw new StateError('TURN_CONFLICT', `turn already exists: ${errorMessage(error)}`);
    }
    return this.requireTurn(taskId, turnId);
  }

  /**
   * Loads one turn regardless of lifecycle status.
   *
   * @param taskId Owning task identifier.
   * @param turnId Turn identifier.
   * @returns The turn record, or `null` when it does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  getTurn(taskId: string, turnId: string): TurnRecord | null {
    const row = this.#database.prepare('SELECT * FROM turn WHERE task_id = ? AND id = ?').get(taskId, turnId);
    return row === undefined ? null : decodeTurn(row);
  }

  /**
   * Loads one turn and rejects unknown identifiers.
   *
   * @param taskId Owning task identifier.
   * @param turnId Turn identifier.
   * @returns The turn record.
   * @throws {StateError} If the turn does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  requireTurn(taskId: string, turnId: string): TurnRecord {
    const turn = this.getTurn(taskId, turnId);
    if (turn === null) {
      throw new StateError('TURN_NOT_FOUND', `turn does not exist for task ${taskId}: ${turnId}`);
    }
    return turn;
  }

  /**
   * Lists a task's turns in durable creation order for transcript audit.
   *
   * @param taskId Owning task identifier.
   * @returns All decoded turns ordered by creation time and identifier.
   * @throws {StateError} If the task does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  listTurns(taskId: string): readonly TurnRecord[] {
    this.requireTask(taskId);
    return this.#database
      .prepare('SELECT * FROM turn WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId)
      .map(decodeTurn);
  }

  /**
   * Lists one turn's artifacts in stable response order.
   *
   * @param taskId Owning task identifier.
   * @param turnId Owning turn identifier.
   * @returns Decoded artifact rows ordered by one-based ordinal.
   * @throws {StateError} If the turn does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  listArtifacts(taskId: string, turnId: string): readonly ArtifactRecord[] {
    this.requireTurn(taskId, turnId);
    return this.#database
      .prepare('SELECT * FROM artifact WHERE task_id = ? AND turn_id = ? ORDER BY ordinal')
      .all(taskId, turnId)
      .map(decodeArtifact);
  }

  /**
   * Loads one artifact and rejects unknown ordinals.
   *
   * @param taskId Owning task identifier.
   * @param turnId Owning turn identifier.
   * @param ordinal One-based response order.
   * @returns The artifact record.
   * @throws {StateError} If the artifact does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  requireArtifact(taskId: string, turnId: string, ordinal: number): ArtifactRecord {
    const row = this.#database
      .prepare('SELECT * FROM artifact WHERE task_id = ? AND turn_id = ? AND ordinal = ?')
      .get(taskId, turnId, ordinal);
    if (row === undefined) {
      throw new StateError('ARTIFACT_NOT_FOUND', `artifact does not exist for turn ${turnId}: ${ordinal}`);
    }
    return decodeArtifact(row);
  }

  /**
   * Records successful local browser cleanup while preserving all task and turn rows.
   *
   * @param taskId Task identifier.
   * @returns The closed task; repeated calls return the existing closed record.
   * @throws {StateError} If the task does not exist.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  closeTask(taskId: string): TaskRecord {
    return this.#transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'closed') {
        return task;
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE task
           SET status = 'closed', updated_at = ?, closed_at = ?
           WHERE id = ?`,
        )
        .run(now, now, taskId);
      return this.requireTask(taskId);
    });
  }

  /**
   * Persists the close intent before any browser termination side effect.
   *
   * @param taskId Task whose browser will be terminated.
   * @returns The closing task record.
   * @throws {StateError} If the task is unknown or already closed.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  markTaskClosing(taskId: string): TaskRecord {
    return this.#transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'closed') {
        throw new StateError('TASK_NOT_ACTIVE', `task is closed: ${taskId}`);
      }
      const now = new Date().toISOString();
      this.#database.prepare("UPDATE task SET status = 'closing', updated_at = ? WHERE id = ?").run(now, taskId);
      return this.requireTask(taskId);
    });
  }

  /**
   * Marks a successfully resumed starting task active.
   *
   * @param taskId Task identifier.
   * @returns The active task record.
   * @throws {StateError} If the task is not currently starting.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  activateTask(taskId: string): TaskRecord {
    return this.#transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status !== 'starting') {
        throw new StateError('TASK_STATE_CONFLICT', `task is ${task.status}, expected starting: ${taskId}`);
      }
      const now = new Date().toISOString();
      this.#database.prepare("UPDATE task SET status = 'active', updated_at = ? WHERE id = ?").run(now, taskId);
      return this.requireTask(taskId);
    });
  }

  /**
   * Inserts one operation journal row and enforces the uncommitted constraints.
   *
   * @param insert Kind, step, optional task and turn, session, and initial evidence.
   * @returns The prepared operation.
   * @throws {StateError} If the step is invalid for the kind, a task already has an
   *   uncommitted operation, or an uncommitted setup operation already exists.
   * @throws {Error} If SQLite rejects the insert or referenced rows are absent.
   */
  createOperation(insert: OperationInsert): OperationRecord {
    return this.#transaction(() => {
      return this.#insertOperation(insert);
    });
  }

  /**
   * Inserts one operation row inside the caller's immediate transaction.
   *
   * @param insert Kind, step, optional task and turn, session, and initial evidence.
   * @returns The prepared operation.
   * @throws {StateError} If the step is invalid or an uncommitted constraint fires.
   * @throws {Error} If SQLite rejects the insert or referenced rows are absent.
   */
  #insertOperation(insert: OperationInsert): OperationRecord {
    const steps = OPERATION_STEPS[insert.kind];
    if (!steps.includes(insert.step)) {
      throw new StateError('OPERATION_STEP_INVALID', `step ${insert.step} is invalid for ${insert.kind}`);
    }
    const now = new Date().toISOString();
    const progress = steps.indexOf(insert.step);
    try {
      this.#database
        .prepare(
          `INSERT INTO operation (
            id, kind, step, phase, progress, task_id, turn_id, session_name,
            evidence_json, resolution_source, error, created_at, updated_at, committed_at
          ) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          insert.id,
          insert.kind,
          insert.step,
          progress,
          insert.taskId,
          insert.turnId,
          insert.sessionName,
          JSON.stringify(insert.evidence ?? null),
          now,
          now,
        );
    } catch (error) {
      if (!isSqliteConstraint(error)) {
        throw error;
      }
      if (insert.kind === 'setup') {
        throw new StateError('SETUP_OPERATION_IN_PROGRESS', 'an uncommitted setup operation already exists');
      }
      throw new StateError('OPERATION_IN_PROGRESS', 'task already has an uncommitted operation');
    }
    return this.requireOperation(insert.id);
  }

  /**
   * Advances a prepared or effect-unknown operation to the next verified step.
   *
   * @param operationId Journal row identifier.
   * @param nextStep Step whose postcondition has just been verified.
   * @param evidence Observed page evidence for the advanced step.
   * @returns The advanced prepared operation.
   * @throws {StateError} If the operation is committed or the step order is invalid.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  advanceOperationStep(operationId: string, nextStep: OperationStep, evidence?: OperationEvidence): OperationRecord {
    return this.#transaction(() => {
      const operation = this.requireOperation(operationId);
      if (operation.phase === 'committed') {
        throw new StateError('OPERATION_COMMITTED', `operation is already committed: ${operationId}`);
      }
      const steps = OPERATION_STEPS[operation.kind];
      const currentIndex = steps.indexOf(operation.step);
      const nextIndex = steps.indexOf(nextStep);
      if (nextIndex !== currentIndex + 1) {
        throw new StateError('OPERATION_STEP_INVALID', `cannot advance to ${nextStep} after ${operation.step}`);
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE operation
           SET step = ?, phase = 'prepared', progress = ?, evidence_json = ?, error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextStep, nextIndex, JSON.stringify(evidence ?? null), now, operationId);
      return this.requireOperation(operationId);
    });
  }

  /**
   * Persists the effect-unknown boundary immediately before a browser command is released.
   *
   * @param operationId Journal row identifier.
   * @param evidence Evidence observed before release, when available.
   * @param error Optional concrete ambiguity diagnostic.
   * @returns The effect-unknown operation.
   * @throws {StateError} If the operation is not prepared or already committed.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  markOperationEffectUnknown(operationId: string, evidence?: OperationEvidence, error?: string): OperationRecord {
    return this.#transaction(() => {
      const operation = this.requireOperation(operationId);
      if (operation.phase !== 'prepared') {
        throw new StateError('OPERATION_PHASE_CONFLICT', `operation is ${operation.phase}, expected prepared`);
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE operation
           SET phase = 'effect-unknown', evidence_json = ?, error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(evidence ?? null), error ?? null, now, operationId);
      return this.requireOperation(operationId);
    });
  }

  /**
   * Marks the only human-decisionable submission state after automatic proof is impossible.
   *
   * @param operationId Journal row identifier.
   * @param evidence Observed page evidence that was insufficient.
   * @param error Concrete ambiguity reason.
   * @returns The needs-decision operation.
   * @throws {StateError} If the operation is not `send: submit` in effect-unknown.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  markOperationNeedsDecision(operationId: string, evidence?: OperationEvidence, error?: string): OperationRecord {
    return this.#transaction(() => {
      const operation = this.requireOperation(operationId);
      if (operation.kind !== 'send' || operation.step !== 'submit' || operation.phase !== 'effect-unknown') {
        throw new StateError(
          'OPERATION_PHASE_CONFLICT',
          `only send: submit effect-unknown can enter needs-decision: ${operationId}`,
        );
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE operation
           SET phase = 'needs-decision', evidence_json = ?, error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(evidence ?? null), error ?? null, now, operationId);
      return this.requireOperation(operationId);
    });
  }

  /**
   * Commits an operation after its task or turn state transition was persisted.
   *
   * @param operationId Journal row identifier.
   * @param resolutionSource Provenance of the resolution evidence.
   * @param evidence Final observed postcondition evidence.
   * @param error Optional terminal failure recorded with the commit.
   * @returns The committed operation.
   * @throws {StateError} If the operation is already committed.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  commitOperation(
    operationId: string,
    resolutionSource: ResolutionSource,
    evidence?: OperationEvidence,
    error?: string,
  ): OperationRecord {
    return this.#transaction(() => {
      return this.#commitOperationRow(operationId, resolutionSource, evidence, error);
    });
  }

  /**
   * Commits one operation row inside the caller's immediate transaction.
   *
   * @param operationId Journal row identifier.
   * @param resolutionSource Provenance of the resolution evidence.
   * @param evidence Final observed postcondition evidence.
   * @param error Optional terminal failure recorded with the commit.
   * @returns The committed operation.
   * @throws {StateError} If the operation is already committed.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  #commitOperationRow(
    operationId: string,
    resolutionSource: ResolutionSource,
    evidence?: OperationEvidence,
    error?: string,
  ): OperationRecord {
    const operation = this.requireOperation(operationId);
    if (operation.phase === 'committed') {
      throw new StateError('OPERATION_COMMITTED', `operation is already committed: ${operationId}`);
    }
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `UPDATE operation
         SET phase = 'committed', evidence_json = ?, resolution_source = ?, error = ?,
             committed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(evidence ?? null), resolutionSource, error ?? null, now, now, operationId);
    return this.requireOperation(operationId);
  }

  /**
   * Loads one operation regardless of phase.
   *
   * @param operationId Journal row identifier.
   * @returns The operation record, or `null` when it does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  getOperation(operationId: string): OperationRecord | null {
    const row = this.#database.prepare('SELECT * FROM operation WHERE id = ?').get(operationId);
    return row === undefined ? null : decodeOperation(row);
  }

  /**
   * Loads one operation and rejects unknown identifiers.
   *
   * @param operationId Journal row identifier.
   * @returns The operation record.
   * @throws {StateError} If the operation does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  requireOperation(operationId: string): OperationRecord {
    const operation = this.getOperation(operationId);
    if (operation === null) {
      throw new StateError('OPERATION_NOT_FOUND', `operation does not exist: ${operationId}`);
    }
    return operation;
  }

  /**
   * Returns the single uncommitted operation of a task, or null.
   *
   * @param taskId Task whose journal is queried.
   * @returns The uncommitted operation, or `null` when none exists.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  getUncommittedTaskOperation(taskId: string): OperationRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM operation WHERE task_id = ? AND phase != 'committed' ORDER BY created_at LIMIT 1")
      .get(taskId);
    return row === undefined ? null : decodeOperation(row);
  }

  /**
   * Returns the global uncommitted setup operation, or null.
   *
   * @returns The uncommitted setup operation, or `null` when none exists.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  getUncommittedSetupOperation(): OperationRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM operation WHERE kind = 'setup' AND phase != 'committed' ORDER BY created_at LIMIT 1")
      .get();
    return row === undefined ? null : decodeOperation(row);
  }

  /**
   * Lists one task's journal rows in creation order for audit.
   *
   * @param taskId Task whose journal is queried; omit to list all journal rows.
   * @returns All operation rows matching the filter.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  listOperations(taskId?: string): readonly OperationRecord[] {
    if (taskId === undefined) {
      return this.#database.prepare('SELECT * FROM operation ORDER BY created_at, rowid').all().map(decodeOperation);
    }
    return this.#database
      .prepare('SELECT * FROM operation WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId)
      .map(decodeOperation);
  }

  /**
   * Returns the read-only status snapshot with the caller's browser availability probe.
   *
   * @param taskId Task identifier.
   * @param browserStatus Availability probe result for the recorded session name.
   * @returns Task, turn, operation, evidence, error, and the single safe next action.
   * @throws {StateError} If the task does not exist.
   * @throws {Error} If SQLite cannot execute or decode the query.
   */
  getStatus(taskId: string, browserStatus: BrowserStatus): StatusRecord {
    const task = this.requireTask(taskId);
    const turns = this.listTurns(taskId);
    const unfinished = turns.filter((turn) => {
      return turn.status === 'sending' || turn.status === 'pending' || turn.status === 'capturing';
    });
    const unresolved = turns.find((turn) => {
      return turn.status === 'unknown-submission';
    });
    const turn = unresolved ?? unfinished.at(-1) ?? null;
    const operation = this.getUncommittedTaskOperation(taskId);
    return {
      taskId,
      taskStatus: task.status,
      turnId: turn?.id ?? null,
      turnStatus: turn?.status ?? null,
      browserStatus,
      operationKind: operation?.kind ?? null,
      operationStep: operation?.step ?? null,
      operationPhase: operation?.phase ?? null,
      operationProgress: operation?.progress ?? null,
      evidence: operation?.evidence ?? null,
      error: turn?.error ?? operation?.error ?? null,
      nextAction: computeNextAction(task, turn, operation, browserStatus),
    };
  }

  /**
   * Acquires a browser-operation lease inside the caller's immediate transaction.
   *
   * @param taskId Existing task whose browser will be operated.
   * @param operation Human-readable operation name retained for conflict diagnostics.
   * @param token Collision-resistant owner token for release authorization.
   * @param ownerPid Process holding the lease.
   * @returns Nothing after the lease and any orphan recovery are written.
   * @throws {StateError} If another live process owns the task browser.
   * @throws {Error} If SQLite cannot read process state or write the lease.
   */
  #acquireTaskOperation(taskId: string, operation: string, token: string, ownerPid: number): void {
    const value = this.#database
      .prepare(
        `SELECT browser_operation_token, browser_operation_pid, browser_operation_name,
                browser_operation_child_pid, browser_operation_command_pid
         FROM task WHERE id = ?`,
      )
      .get(taskId);
    const row = record(value);
    const existingToken = nullableText(row.browser_operation_token, 'task.browser_operation_token');
    const existingPid = nullableInteger(row.browser_operation_pid, 'task.browser_operation_pid');
    const existingOperation = nullableText(row.browser_operation_name, 'task.browser_operation_name');
    const existingChildPid = nullableInteger(row.browser_operation_child_pid, 'task.browser_operation_child_pid');
    const existingCommandPid = nullableInteger(row.browser_operation_command_pid, 'task.browser_operation_command_pid');
    if (
      existingToken !== null &&
      ((existingPid !== null && isProcessAlive(existingPid)) ||
        (existingChildPid !== null && isProcessAlive(existingChildPid)) ||
        (existingCommandPid !== null && isProcessAlive(existingCommandPid)))
    ) {
      throw new StateError(
        'TASK_OPERATION_IN_PROGRESS',
        `task browser is busy with ${existingOperation ?? 'another operation'}: ${taskId}`,
      );
    }
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `UPDATE task
         SET browser_operation_token = ?, browser_operation_pid = ?, browser_operation_name = ?,
             browser_operation_child_pid = NULL, browser_operation_command_pid = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(token, ownerPid, operation, now, taskId);
  }

  /**
   * Completes the only legal transition out of `sending` after a failed browser boundary.
   *
   * @param taskId Owning task identifier.
   * @param turnId Sending turn identifier.
   * @param status Failure classification.
   * @param reason Concrete operation and cause.
   * @returns The updated turn.
   * @throws {StateError} If the turn is not `sending`.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  #finishSendingTurn(
    taskId: string,
    turnId: string,
    status: 'failed' | 'unknown-submission',
    reason: string,
  ): TurnRecord {
    return this.#transaction(() => {
      return this.#finishSendingTurnRow(taskId, turnId, status, reason);
    });
  }

  /**
   * Completes one sending-turn row transition inside the caller's immediate transaction.
   *
   * @param taskId Owning task identifier.
   * @param turnId Sending turn identifier.
   * @param status Failure classification.
   * @param reason Concrete operation and cause.
   * @returns The updated turn.
   * @throws {StateError} If the turn is not `sending`.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  #finishSendingTurnRow(
    taskId: string,
    turnId: string,
    status: 'failed' | 'unknown-submission',
    reason: string,
  ): TurnRecord {
    const turn = this.requireTurn(taskId, turnId);
    if (turn.status !== 'sending') {
      throw new StateError('TURN_STATE_CONFLICT', `turn is ${turn.status}, expected sending: ${turnId}`);
    }
    const now = new Date().toISOString();
    this.#database
      .prepare('UPDATE turn SET status = ?, error = ?, updated_at = ? WHERE task_id = ? AND id = ?')
      .run(status, reason, now, taskId, turnId);
    return this.requireTurn(taskId, turnId);
  }

  /**
   * Reconciles the durable ambiguity marker after a browser submission attempt returns.
   *
   * @param taskId Owning task identifier.
   * @param turnId Unknown-submission turn identifier.
   * @param status Reconciled terminal classification.
   * @param reason Concrete browser result.
   * @returns The updated turn.
   * @throws {StateError} If the turn is not `unknown-submission`.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  #finishUnknownSubmissionTurn(
    taskId: string,
    turnId: string,
    status: 'failed' | 'unknown-submission',
    reason: string,
  ): TurnRecord {
    return this.#transaction(() => {
      return this.#finishUnknownSubmissionTurnRow(taskId, turnId, status, reason);
    });
  }

  /**
   * Completes one unknown-submission row transition inside the caller's immediate transaction.
   *
   * @param taskId Owning task identifier.
   * @param turnId Unknown-submission turn identifier.
   * @param status Reconciled terminal classification.
   * @param reason Concrete browser result.
   * @returns The updated turn.
   * @throws {StateError} If the turn is not `unknown-submission`.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  #finishUnknownSubmissionTurnRow(
    taskId: string,
    turnId: string,
    status: 'failed' | 'unknown-submission',
    reason: string,
  ): TurnRecord {
    const turn = this.requireTurn(taskId, turnId);
    if (turn.status !== 'unknown-submission') {
      throw new StateError('TURN_STATE_CONFLICT', `turn is ${turn.status}, expected unknown-submission: ${turnId}`);
    }
    const now = new Date().toISOString();
    this.#database
      .prepare('UPDATE turn SET status = ?, error = ?, updated_at = ? WHERE task_id = ? AND id = ?')
      .run(status, reason, now, taskId, turnId);
    return this.requireTurn(taskId, turnId);
  }

  /**
   * Serializes a state gate and rolls back every thrown transition.
   *
   * @param operation Synchronous SQLite work that must commit as one unit.
   * @returns The operation result after `COMMIT` succeeds.
   * @throws {Error} Re-throws the operation or SQLite transaction failure.
   */
  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // Preserve the root transition failure when SQLite already ended the transaction.
      }
      throw error;
    }
  }
}

/**
 * Extracts the canonical conversation identity from a plain or project-scoped canonical URL.
 *
 * @param url Canonical conversation URL, plain `/c/<id>` or project-scoped.
 * @returns The trailing conversation identifier, or null when the URL is not canonical.
 * @throws {Error} This pure parser does not throw for string inputs.
 */
function conversationIdOf(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  const match = /\/c\/([^/?#]+)\/?$/u.exec(url);
  return match === null || match[1] === undefined || match[1].startsWith('WEB:') ? null : match[1];
}

/**
 * Decodes one SQLite task row while keeping storage names out of callers.
 *
 * @param value Raw row returned by `node:sqlite`.
 * @returns A typed task record.
 * @throws {TypeError} If required fields are absent or have unexpected types.
 */
function decodeTask(value: unknown): TaskRecord {
  const row = record(value);
  return {
    id: text(row.id, 'task.id'),
    playwrightSession: text(row.playwright_session, 'task.playwright_session'),
    conversationId: nullableText(row.conversation_id, 'task.conversation_id'),
    conversationUrl: nullableText(row.conversation_url, 'task.conversation_url'),
    status: taskStatus(row.status),
    createdAt: text(row.created_at, 'task.created_at'),
    updatedAt: text(row.updated_at, 'task.updated_at'),
    closedAt: nullableText(row.closed_at, 'task.closed_at'),
  };
}

/**
 * Decodes one SQLite turn row and its ordered attachment JSON.
 *
 * @param value Raw row returned by `node:sqlite`.
 * @returns A typed turn record.
 * @throws {TypeError} If required fields or attachment JSON violate the schema contract.
 */
function decodeTurn(value: unknown): TurnRecord {
  const row = record(value);
  const attachments = JSON.parse(text(row.attachments_json, 'turn.attachments_json'));
  if (
    !Array.isArray(attachments) ||
    attachments.some((item) => {
      return typeof item !== 'string';
    })
  ) {
    throw new TypeError('turn.attachments_json must be a string array');
  }
  return {
    taskId: text(row.task_id, 'turn.task_id'),
    id: text(row.id, 'turn.id'),
    status: turnStatus(row.status),
    promptPath: text(row.prompt_path, 'turn.prompt_path'),
    attachmentPaths: attachments,
    userTurnIdentity: nullableText(row.user_turn_identity, 'turn.user_turn_identity'),
    responsePath: nullableText(row.response_path, 'turn.response_path'),
    artifactSetRecorded: booleanInteger(row.artifact_set_recorded, 'turn.artifact_set_recorded'),
    error: nullableText(row.error, 'turn.error'),
    createdAt: text(row.created_at, 'turn.created_at'),
    updatedAt: text(row.updated_at, 'turn.updated_at'),
  };
}

/**
 * Decodes one ordered artifact row.
 *
 * @param value Raw row returned by `node:sqlite`.
 * @returns A typed artifact record.
 * @throws {TypeError} If required fields violate the schema contract.
 */
function decodeArtifact(value: unknown): ArtifactRecord {
  const row = record(value);
  return {
    taskId: text(row.task_id, 'artifact.task_id'),
    turnId: text(row.turn_id, 'artifact.turn_id'),
    ordinal: integer(row.ordinal, 'artifact.ordinal'),
    sourceUrl: text(row.source_url, 'artifact.source_url'),
    label: text(row.label, 'artifact.label'),
    filename: nullableText(row.filename, 'artifact.filename'),
    localPath: nullableText(row.local_path, 'artifact.local_path'),
    status: artifactStatus(row.status),
    error: nullableText(row.error, 'artifact.error'),
    createdAt: text(row.created_at, 'artifact.created_at'),
    updatedAt: text(row.updated_at, 'artifact.updated_at'),
  };
}

/**
 * Narrows an unknown SQLite row to an object.
 *
 * @param value Raw query result.
 * @returns The query result as a record.
 * @throws {TypeError} If the query result is not an object row.
 */
function record(value: unknown): Record<string, SQLInputValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('SQLite row must be an object');
  }
  return value as Record<string, SQLInputValue>;
}

/**
 * Decodes one operation journal row with its stable evidence schema.
 *
 * @param value Raw row returned by `node:sqlite`.
 * @returns A typed operation record.
 * @throws {TypeError} If required fields or evidence JSON violate the schema contract.
 */
function decodeOperation(value: unknown): OperationRecord {
  const row = record(value);
  const evidenceValue = text(row.evidence_json, 'operation.evidence_json');
  return {
    id: text(row.id, 'operation.id'),
    kind: operationKind(row.kind),
    step: operationStep(row.step),
    phase: operationPhase(row.phase),
    progress: nonNegativeInteger(row.progress, 'operation.progress'),
    taskId: nullableText(row.task_id, 'operation.task_id'),
    turnId: nullableText(row.turn_id, 'operation.turn_id'),
    sessionName: text(row.session_name, 'operation.session_name'),
    evidence: decodeOperationEvidence(evidenceValue),
    resolutionSource: nullableResolutionSource(row.resolution_source),
    error: nullableText(row.error, 'operation.error'),
    createdAt: text(row.created_at, 'operation.created_at'),
    updatedAt: text(row.updated_at, 'operation.updated_at'),
    committedAt: nullableText(row.committed_at, 'operation.committed_at'),
  };
}

/**
 * Decodes the stable operation evidence object without copying prompt or attachment bytes.
 *
 * @param value Serialized evidence JSON.
 * @returns The evidence object, or an empty evidence object for a null payload.
 * @throws {TypeError} If the evidence is not an object.
 */
function decodeOperationEvidence(value: string): OperationEvidence {
  if (value === 'null') {
    return { observedAt: '', sessionName: '' };
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('operation.evidence_json must be an object');
  }
  return parsed as OperationEvidence;
}

/**
 * Narrows a required SQLite column to text.
 *
 * @param value Raw column value.
 * @param field Diagnostic field name.
 * @returns The string value.
 * @throws {TypeError} If the column is not text.
 */
function text(value: SQLInputValue | undefined, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be text`);
  }
  return value;
}

/**
 * Narrows a nullable SQLite column to text or null.
 *
 * @param value Raw column value.
 * @param field Diagnostic field name.
 * @returns The string or null value.
 * @throws {TypeError} If the column is neither text nor null.
 */
function nullableText(value: SQLInputValue | undefined, field: string): string | null {
  if (value === null) {
    return null;
  }
  return text(value, field);
}

/**
 * Narrows a nullable SQLite integer column.
 *
 * @param value Raw column value.
 * @param field Diagnostic field name.
 * @returns The integer or null value.
 * @throws {TypeError} If the column is neither an integer nor null.
 */
function nullableInteger(value: SQLInputValue | undefined, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be an integer or null`);
  }
  return value;
}

/**
 * Narrows a required non-negative SQLite integer.
 *
 * @param value Raw column value.
 * @param field Diagnostic field name.
 * @returns The non-negative integer.
 * @throws {TypeError} If the column is not a non-negative integer.
 */
function nonNegativeInteger(value: SQLInputValue | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * Narrows a required positive SQLite integer.
 *
 * @param value Raw column value.
 * @param field Diagnostic field name.
 * @returns The positive integer.
 * @throws {TypeError} If the column is not a positive integer.
 */
function integer(value: SQLInputValue | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

/**
 * Decodes a STRICT SQLite boolean stored as zero or one.
 *
 * @param value Raw column value.
 * @param field Diagnostic field name.
 * @returns The boolean value.
 * @throws {TypeError} If the column is neither zero nor one.
 */
function booleanInteger(value: SQLInputValue | undefined, field: string): boolean {
  if (value === 0) {
    return false;
  }
  if (value === 1) {
    return true;
  }
  throw new TypeError(`${field} must be zero or one`);
}

/**
 * Checks a completed transcript path without following non-file directory entries.
 *
 * @param path Database-recorded absolute file path.
 * @returns True only for an existing regular file.
 * @throws {Error} Ordinary absence is converted to false.
 */
function isRegularFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/**
 * Checks whether a lease-owning process still exists without signaling it.
 *
 * @param pid Operating-system process identifier stored with the lease.
 * @returns True when the process exists or cannot be signaled due to permissions.
 * @throws {Error} This probe converts ordinary process lookup failures to false.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Validates the closed task-status vocabulary.
 *
 * @param value Raw status column.
 * @returns A valid task status.
 * @throws {TypeError} If the database contains an unsupported status.
 */
function taskStatus(value: SQLInputValue | undefined): TaskStatus {
  if (value === 'starting' || value === 'active' || value === 'closing' || value === 'closed' || value === 'failed') {
    return value;
  }
  throw new TypeError(`invalid task status: ${String(value)}`);
}

/**
 * Validates the closed turn-status vocabulary.
 *
 * @param value Raw status column.
 * @returns A valid turn status.
 * @throws {TypeError} If the database contains an unsupported status.
 */
function turnStatus(value: SQLInputValue | undefined): TurnStatus {
  if (
    value === 'sending' ||
    value === 'pending' ||
    value === 'capturing' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'unknown-submission'
  ) {
    return value;
  }
  throw new TypeError(`invalid turn status: ${String(value)}`);
}

/**
 * Validates the closed artifact-status vocabulary.
 *
 * @param value Raw status column.
 * @returns A valid artifact status.
 * @throws {TypeError} If the database contains an unsupported status.
 */
function artifactStatus(value: SQLInputValue | undefined): ArtifactStatus {
  if (value === 'pending' || value === 'completed') {
    return value;
  }
  throw new TypeError(`invalid artifact status: ${String(value)}`);
}

/**
 * Validates the operation-kind vocabulary.
 *
 * @param value Raw kind column.
 * @returns A valid operation kind.
 * @throws {TypeError} If the database contains an unsupported kind.
 */
function operationKind(value: SQLInputValue | undefined): OperationKind {
  if (value === 'setup' || value === 'start' || value === 'send' || value === 'archive') {
    return value;
  }
  throw new TypeError(`invalid operation kind: ${String(value)}`);
}

/**
 * Validates the operation-step vocabulary.
 *
 * @param value Raw step column.
 * @returns A valid operation step.
 * @throws {TypeError} If the database contains an unsupported step.
 */
function operationStep(value: SQLInputValue | undefined): OperationStep {
  if (
    value === 'login' ||
    value === 'seed' ||
    value === 'cleanup' ||
    value === 'session' ||
    value === 'project' ||
    value === 'configuration' ||
    value === 'draft' ||
    value === 'submit' ||
    value === 'archive' ||
    value === 'restore'
  ) {
    return value;
  }
  throw new TypeError(`invalid operation step: ${String(value)}`);
}

/**
 * Validates the operation-phase vocabulary.
 *
 * @param value Raw phase column.
 * @returns A valid operation phase.
 * @throws {TypeError} If the database contains an unsupported phase.
 */
function operationPhase(value: SQLInputValue | undefined): OperationPhase {
  if (value === 'prepared' || value === 'effect-unknown' || value === 'needs-decision' || value === 'committed') {
    return value;
  }
  throw new TypeError(`invalid operation phase: ${String(value)}`);
}

/**
 * Narrows the nullable resolution-source column.
 *
 * @param value Raw resolution source column.
 * @returns The source, or null when unresolved.
 * @throws {TypeError} If the column is neither null nor a valid source.
 */
function nullableResolutionSource(value: SQLInputValue | undefined): ResolutionSource | null {
  if (value === null) {
    return null;
  }
  if (value === 'automatic' || value === 'human') {
    return value;
  }
  throw new TypeError(`invalid resolution source: ${String(value)}`);
}

/**
 * Computes the single safe next action that continues or unblocks the persistent workflow.
 *
 * @param task Current task row.
 * @param turn Latest unfinished turn, or null.
 * @param operation Uncommitted operation of the task, or null.
 * @param browserStatus Observed named-session availability.
 * @returns One of the contract `nextAction` values.
 * @throws {Error} This pure classifier does not throw for typed inputs.
 */
function computeNextAction(
  task: TaskRecord,
  turn: TurnRecord | null,
  operation: OperationRecord | null,
  browserStatus: BrowserStatus,
): NextAction {
  if (task.status === 'closing') {
    return 'close';
  }
  if (task.status === 'starting') {
    return 'recover';
  }
  if (task.status === 'closed' || task.status === 'failed') {
    return 'none';
  }
  if (operation !== null) {
    if (operation.kind === 'start') {
      return 'recover';
    }
    if (operation.kind === 'send') {
      if (operation.step === 'draft') {
        return 'recover';
      }
      if (operation.phase === 'needs-decision') {
        return 'resolve-submission';
      }
      if (operation.phase === 'effect-unknown') {
        return 'recover';
      }
    }
    if (operation.kind === 'archive') {
      return 'recover';
    }
  }
  if (turn !== null && turn.status === 'unknown-submission') {
    return 'resolve-submission';
  }
  if (turn !== null && (turn.status === 'pending' || turn.status === 'capturing')) {
    return 'wait';
  }
  if (browserStatus === 'missing') {
    return 'recover';
  }
  return 'none';
}

/**
 * Adds the caller-provided user turn identity column and its unique index to an older database.
 *
 * @param database Process-local SQLite connection.
 * @returns Nothing after the column and index exist.
 * @throws {Error} If SQLite cannot alter or index the table.
 */
function migrateTurnIdentity(database: DatabaseSync): void {
  const columns = database
    .prepare('PRAGMA table_info(turn)')
    .all()
    .map((value) => {
      return text(record(value).name, 'turn column name');
    });
  if (!columns.includes('user_turn_identity')) {
    database.exec('ALTER TABLE turn ADD COLUMN user_turn_identity TEXT');
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS turn_task_user_identity ON turn (task_id, user_turn_identity)');
}

/**
 * Rebuilds an older task table whose status check lacks the starting and closing statuses.
 *
 * @param database Process-local SQLite connection.
 * @returns Nothing after the table carries the current check.
 * @throws {Error} If SQLite cannot rebuild or copy the table.
 */
function migrateTaskStatuses(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task'").get();
  const definition = record(row);
  const sql = text(definition.sql, 'task table sql');
  if (sql.includes("'starting'")) {
    return;
  }
  database.exec('PRAGMA foreign_keys = OFF');
  try {
    database.exec(`
      CREATE TABLE task_migrated (
        id TEXT PRIMARY KEY,
        playwright_session TEXT NOT NULL UNIQUE,
        conversation_id TEXT,
        conversation_url TEXT,
        status TEXT NOT NULL CHECK (status IN ('starting', 'active', 'closing', 'closed', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        browser_operation_token TEXT,
        browser_operation_pid INTEGER,
        browser_operation_name TEXT,
        browser_operation_child_pid INTEGER,
        browser_operation_command_pid INTEGER
      ) STRICT;
      INSERT INTO task_migrated SELECT * FROM task;
      DROP TABLE task;
      ALTER TABLE task_migrated RENAME TO task;
    `);
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Extracts a stable message without discarding non-Error failures.
 *
 * @param error Unknown thrown value.
 * @returns A human-readable failure message.
 * @throws {Error} This formatter does not throw for ordinary JavaScript values.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Distinguishes uniqueness failures from unrelated SQLite I/O or lock errors.
 *
 * @param error Unknown value thrown by `node:sqlite`.
 * @returns `true` only for base or extended `SQLITE_CONSTRAINT` codes.
 * @throws {Error} This classifier does not throw for ordinary JavaScript values.
 */
function isSqliteConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) {
    return false;
  }
  const errorCode = error.errcode;
  return typeof errorCode === 'number' && errorCode % 256 === 19;
}

/**
 * Applies the finite SQLite busy window to WAL initialization, whose PRAGMA can bypass
 * SQLite's configured busy handler when another process is changing the journal mode.
 *
 * @param database Process-local SQLite connection.
 * @param sql Initialization statement to execute.
 * @param timeoutMilliseconds Maximum total contention wait.
 * @returns Nothing after the statement succeeds.
 * @throws {Error} Immediately for non-busy failures, or after the busy deadline expires.
 */
function executeWithBusyRetry(database: DatabaseSync, sql: string, timeoutMilliseconds: number): void {
  const deadline = Date.now() + timeoutMilliseconds;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (true) {
    try {
      database.exec(sql);
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(waitBuffer, 0, 0, Math.min(25, deadline - Date.now()));
    }
  }
}

/**
 * Identifies base and extended SQLite busy result codes.
 *
 * @param error Unknown value thrown by `node:sqlite`.
 * @returns `true` when the base result code is `SQLITE_BUSY`.
 * @throws {Error} This classifier does not throw for ordinary JavaScript values.
 */
function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) {
    return false;
  }
  const errorCode = error.errcode;
  return typeof errorCode === 'number' && errorCode % 256 === 5;
}
