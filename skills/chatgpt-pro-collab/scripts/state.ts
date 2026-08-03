import { existsSync, statSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type TaskStatus = 'active' | 'closed' | 'failed';
export type TurnStatus = 'sending' | 'pending' | 'completed' | 'failed' | 'unknown-submission';

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
  readonly responsePath: string | null;
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
   * Opens one process-local SQLite connection and installs the V1 schema.
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
        status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        browser_operation_token TEXT,
        browser_operation_pid INTEGER,
        browser_operation_name TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS turn (
        task_id TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('sending', 'pending', 'completed', 'failed', 'unknown-submission')
        ),
        prompt_path TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        response_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, id),
        FOREIGN KEY (task_id) REFERENCES task(id)
      ) STRICT;
    `);
    ensureTaskOperationColumns(this.#database);
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
   * Records an active task before its browser is started.
   *
   * @param taskId Collision-resistant task identifier.
   * @param playwrightSession Unique Playwright CLI session name.
   * @returns The inserted task record.
   * @throws {StateError} If either identifier already exists.
   * @throws {Error} If SQLite rejects the write.
   */
  createTask(taskId: string, playwrightSession: string): TaskRecord {
    const now = new Date().toISOString();
    try {
      this.#database
        .prepare(
          `INSERT INTO task (
            id, playwright_session, conversation_id, conversation_url,
            status, created_at, updated_at, closed_at
          ) VALUES (?, ?, NULL, NULL, 'active', ?, ?, NULL)`,
        )
        .run(taskId, playwrightSession, now, now);
    } catch (error) {
      if (!isSqliteConstraint(error)) {
        throw error;
      }
      throw new StateError('TASK_CONFLICT', `task or Playwright session already exists: ${errorMessage(error)}`);
    }
    return this.requireTask(taskId);
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
   * Acquires the task-local browser-operation lease, reclaiming only an owner whose process is gone.
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
      const value = this.#database
        .prepare(
          `SELECT browser_operation_token, browser_operation_pid, browser_operation_name
           FROM task WHERE id = ?`,
        )
        .get(taskId);
      const row = record(value);
      const existingToken = nullableText(row.browser_operation_token, 'task.browser_operation_token');
      const existingPid = nullableInteger(row.browser_operation_pid, 'task.browser_operation_pid');
      const existingOperation = nullableText(row.browser_operation_name, 'task.browser_operation_name');
      if (existingToken !== null && existingPid !== null && isProcessAlive(existingPid)) {
        throw new StateError(
          'TASK_OPERATION_IN_PROGRESS',
          `task browser is busy with ${existingOperation ?? 'another operation'}: ${taskId}`,
        );
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE task
           SET browser_operation_token = ?, browser_operation_pid = ?, browser_operation_name = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(token, ownerPid, operation, now, taskId);
    });
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
      const now = new Date().toISOString();
      const result = this.#database
        .prepare(
          `UPDATE task
           SET browser_operation_token = NULL, browser_operation_pid = NULL,
               browser_operation_name = NULL, updated_at = ?
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
      this.requireActiveTask(taskId);
      const unfinished = this.#database
        .prepare(
          `SELECT id FROM turn
           WHERE task_id = ? AND status IN ('sending', 'pending', 'unknown-submission')
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
    });
  }

  /**
   * Commits a confirmed browser submission and binds the task's first conversation.
   *
   * @param taskId Owning task identifier.
   * @param turnId Sending turn identifier.
   * @param conversationId Canonical ChatGPT conversation identifier.
   * @param conversationUrl Canonical `/c/<id>` URL observed after submission.
   * @returns The updated pending turn.
   * @throws {StateError} If the lifecycle transition or conversation identity is inconsistent.
   * @throws {Error} If SQLite cannot commit both updates atomically.
   */
  markTurnPending(taskId: string, turnId: string, conversationId: string, conversationUrl: string): TurnRecord {
    return this.#transaction(() => {
      const task = this.requireActiveTask(taskId);
      const turn = this.requireTurn(taskId, turnId);
      if (turn.status !== 'sending') {
        throw new StateError('TURN_STATE_CONFLICT', `turn is ${turn.status}, expected sending: ${turnId}`);
      }
      if (
        task.conversationId !== null &&
        (task.conversationId !== conversationId || task.conversationUrl !== conversationUrl)
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
      this.#database
        .prepare("UPDATE turn SET status = 'pending', updated_at = ? WHERE task_id = ? AND id = ?")
        .run(now, taskId, turnId);
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
    return this.#finishSendingTurn(taskId, turnId, 'failed', reason);
  }

  /**
   * Records a browser submission whose side effect cannot be proven either way.
   *
   * @param taskId Owning task identifier.
   * @param turnId Sending turn identifier.
   * @param reason Concrete ambiguity at the submission boundary.
   * @returns The updated unknown-submission turn.
   * @throws {StateError} If the turn is not currently `sending`.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  markUnknownSubmission(taskId: string, turnId: string, reason: string): TurnRecord {
    return this.#finishSendingTurn(taskId, turnId, 'unknown-submission', reason);
  }

  /**
   * Marks a pending turn completed only after its response file is visible.
   *
   * @param taskId Owning task identifier.
   * @param turnId Pending turn identifier.
   * @param responsePath Immutable response transcript path.
   * @returns The updated completed turn.
   * @throws {StateError} If the turn is not pending or the response file is missing.
   * @throws {Error} If SQLite cannot commit the transition.
   */
  completeTurn(taskId: string, turnId: string, responsePath: string): TurnRecord {
    if (!existsSync(responsePath) || !statSync(responsePath).isFile()) {
      throw new StateError('RESPONSE_MISSING', `response must exist before completion: ${responsePath}`);
    }
    return this.#transaction(() => {
      const turn = this.requireTurn(taskId, turnId);
      if (turn.status !== 'pending') {
        throw new StateError('TURN_STATE_CONFLICT', `turn is ${turn.status}, expected pending: ${turnId}`);
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE turn
           SET status = 'completed', response_path = ?, error = NULL, updated_at = ?
           WHERE task_id = ? AND id = ?`,
        )
        .run(responsePath, now, taskId, turnId);
      return this.requireTurn(taskId, turnId);
    });
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
      const turn = this.requireTurn(taskId, turnId);
      if (turn.status !== 'sending') {
        throw new StateError('TURN_STATE_CONFLICT', `turn is ${turn.status}, expected sending: ${turnId}`);
      }
      const now = new Date().toISOString();
      this.#database
        .prepare('UPDATE turn SET status = ?, error = ?, updated_at = ? WHERE task_id = ? AND id = ?')
        .run(status, reason, now, taskId, turnId);
      return this.requireTurn(taskId, turnId);
    });
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
 * Adds task-operation lease columns to databases created before the lease existed.
 *
 * @param database Process-local SQLite connection.
 * @returns Nothing after the schema is current.
 * @throws {Error} If SQLite cannot serialize or commit the schema update.
 */
function ensureTaskOperationColumns(database: DatabaseSync): void {
  const required = ['browser_operation_token', 'browser_operation_pid', 'browser_operation_name'] as const;
  const current = taskColumnNames(database);
  if (
    required.every((name) => {
      return current.has(name);
    })
  ) {
    return;
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const columns = taskColumnNames(database);
    const definitions = [
      ['browser_operation_token', 'TEXT'],
      ['browser_operation_pid', 'INTEGER'],
      ['browser_operation_name', 'TEXT'],
    ] as const;
    for (const [name, type] of definitions) {
      if (!columns.has(name)) {
        database.exec(`ALTER TABLE task ADD COLUMN ${name} ${type}`);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the schema-update failure when SQLite already ended the transaction.
    }
    throw error;
  }
}

/**
 * Reads task-table column names for the idempotent schema gate.
 *
 * @param database Process-local SQLite connection.
 * @returns Current task-table column names.
 * @throws {Error} If SQLite cannot inspect or decode the schema.
 */
function taskColumnNames(database: DatabaseSync): Set<string> {
  return new Set(
    database
      .prepare('PRAGMA table_info(task)')
      .all()
      .map((value) => {
        return text(record(value).name, 'pragma_table_info.name');
      }),
  );
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
    responsePath: nullableText(row.response_path, 'turn.response_path'),
    error: nullableText(row.error, 'turn.error'),
    createdAt: text(row.created_at, 'turn.created_at'),
    updatedAt: text(row.updated_at, 'turn.updated_at'),
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
  if (value === 'active' || value === 'closed' || value === 'failed') {
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
    value === 'completed' ||
    value === 'failed' ||
    value === 'unknown-submission'
  ) {
    return value;
  }
  throw new TypeError(`invalid turn status: ${String(value)}`);
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
