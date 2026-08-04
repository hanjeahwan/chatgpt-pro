import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'invalidated' | 'cancelled';

type Readiness = 'basic' | 'ready' | 'final';

export interface SpecSnapshot {
  specDigest: string;
  contextDigest: string;
  sourceDigests: Record<string, string>;
}

export interface TaskEvidence {
  commits: string[];
  checks: string[];
  reviews: string[];
}

export interface ImplementationTask {
  id: string;
  title: string;
  status: TaskStatus;
  covers: string[];
  verifies: string[];
  dependsOn: string[];
  scope: string[];
  evidence: TaskEvidence;
}

export interface TaskLedger {
  spec: string;
  specDigest: string;
  contextDigest: string;
  sourceDigests: Record<string, string>;
  baseSha: string;
  tasks: ImplementationTask[];
}

export interface ValidationOptions {
  expectedSpec: string;
  readiness?: Readiness;
}

export interface SpecDifference {
  specChanged: boolean;
  contextChanged: boolean;
  added: string[];
  changed: string[];
  removed: string[];
  impactedTasks: string[];
}

const TASK_STATUSES = new Set<TaskStatus>(['pending', 'in_progress', 'blocked', 'done', 'invalidated', 'cancelled']);

/**
 * Parses stable BEH and VER section headings from a product Spec.
 *
 * @param content Complete Markdown Spec content.
 * @returns Digests for the complete Spec, non-BEH/VER context, and every BEH/VER definition.
 * @throws When the Spec contains duplicate definitions or no BEH/VER definitions.
 */
export function parseSpec(content: string): SpecSnapshot {
  const normalizedContent = content.replace(/\r\n?/g, '\n');
  const lines = normalizedContent.split('\n');
  const sourceDigests = new Map<string, string>();
  const definitionLines = new Set<number>();

  for (let index = 0; index < lines.length; index += 1) {
    const definitionMatch = /^###\s+((?:BEH|VER)-\d{3,})\b/.exec(lines[index].trimEnd());
    if (definitionMatch) {
      let end = index + 1;
      while (end < lines.length && !/^#{1,3}\s+/.test(lines[end])) {
        end += 1;
      }
      for (let definitionLine = index; definitionLine < end; definitionLine += 1) {
        definitionLines.add(definitionLine);
      }
      const canonicalBlock = lines
        .slice(index, end)
        .map((line) => {
          return line.trimEnd();
        })
        .join('\n')
        .trimEnd();
      addDefinition(sourceDigests, definitionMatch[1], canonicalBlock);
    }
  }

  if (sourceDigests.size === 0) {
    throw new Error('Spec does not define any BEH or VER items');
  }

  return {
    specDigest: digest(normalizedContent),
    contextDigest: digest(
      lines
        .filter((_line, index) => {
          return !definitionLines.has(index);
        })
        .map((line) => {
          return line.trimEnd();
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd(),
    ),
    sourceDigests: Object.fromEntries(
      [...sourceDigests.entries()].sort(([left], [right]) => {
        return left.localeCompare(right);
      }),
    ),
  };
}

/**
 * Compares the current Spec snapshot with the snapshot stored in a task ledger.
 *
 * @param snapshot Current parsed Spec snapshot.
 * @param ledger Existing task ledger.
 * @returns Added, changed, removed, context-change, and impacted-task signals.
 */
export function compareSpec(snapshot: SpecSnapshot, ledger: TaskLedger): SpecDifference {
  const currentIds = new Set(Object.keys(snapshot.sourceDigests));
  const storedIds = new Set(Object.keys(ledger.sourceDigests));
  const added = [...currentIds]
    .filter((id) => {
      return !storedIds.has(id);
    })
    .sort();
  const removed = [...storedIds]
    .filter((id) => {
      return !currentIds.has(id);
    })
    .sort();
  const changed = [...currentIds]
    .filter((id) => {
      return storedIds.has(id) && snapshot.sourceDigests[id] !== ledger.sourceDigests[id];
    })
    .sort();
  const specChanged = snapshot.specDigest !== ledger.specDigest;
  const changedOrRemoved = new Set([...changed, ...removed]);
  const impactedTasks = ledger.tasks
    .filter((task) => {
      return [...task.covers, ...task.verifies].some((id) => {
        return changedOrRemoved.has(id);
      });
    })
    .map((task) => {
      return task.id;
    })
    .sort();

  return {
    specChanged,
    contextChanged: snapshot.contextDigest !== ledger.contextDigest,
    added,
    changed,
    removed,
    impactedTasks,
  };
}

/**
 * Validates ledger shape, current Spec identity, coverage, dependencies, and evidence.
 *
 * @param snapshot Current parsed Spec snapshot.
 * @param value Parsed JSON value for the ledger.
 * @param options Expected repository-relative Spec path and readiness gate.
 * @returns All validation errors; an empty array means the selected gate passed.
 */
export function validateLedger(snapshot: SpecSnapshot, value: unknown, options: ValidationOptions): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ['ledger must be a JSON object'];
  }

  const ledger = value;
  requireString(ledger, 'spec', errors);
  requireString(ledger, 'specDigest', errors);
  requireString(ledger, 'contextDigest', errors);
  requireString(ledger, 'baseSha', errors);
  if (ledger.spec !== options.expectedSpec) {
    errors.push(`ledger.spec must equal ${options.expectedSpec}`);
  }
  if (ledger.specDigest !== snapshot.specDigest) {
    errors.push('ledger.specDigest is stale; run diff and reconcile the ledger');
  }
  if (ledger.contextDigest !== snapshot.contextDigest) {
    errors.push('ledger.contextDigest is stale; review non-BEH/VER Spec changes');
  }
  if (typeof ledger.baseSha === 'string' && !/^[0-9a-f]{40}$/.test(ledger.baseSha)) {
    errors.push('ledger.baseSha must be a complete 40-character lowercase Git SHA');
  }

  const storedDigests = readStringRecord(ledger.sourceDigests, 'sourceDigests', errors);
  if (storedDigests) {
    for (const id of Object.keys(snapshot.sourceDigests)) {
      if (!(id in storedDigests)) {
        errors.push(`sourceDigests is missing ${id}`);
      } else if (storedDigests[id] !== snapshot.sourceDigests[id]) {
        errors.push(`sourceDigests.${id} is stale`);
      }
    }
    for (const id of Object.keys(storedDigests)) {
      if (!(id in snapshot.sourceDigests)) {
        errors.push(`sourceDigests contains removed item ${id}`);
      }
    }
  }

  if (!Array.isArray(ledger.tasks)) {
    errors.push('tasks must be an array');
    return errors;
  }

  const tasks: ImplementationTask[] = [];
  const taskIds = new Set<string>();
  let previousTaskNumber = 0;
  for (const [index, taskValue] of ledger.tasks.entries()) {
    const task = readTask(taskValue, index, errors);
    if (!task) {
      continue;
    }
    tasks.push(task);
    if (taskIds.has(task.id)) {
      errors.push(`duplicate task id ${task.id}`);
    }
    taskIds.add(task.id);
    const taskNumber = Number(task.id.slice(4));
    if (taskNumber <= previousTaskNumber) {
      errors.push('tasks must be ordered by ascending IMP number');
    }
    previousTaskNumber = taskNumber;
  }

  const behaviorOwners = new Map<string, string[]>();
  const verificationOwners = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.status === 'cancelled') {
      if (task.covers.length > 0 || task.verifies.length > 0 || task.dependsOn.length > 0) {
        errors.push(`${task.id} is cancelled and must not retain targets or dependencies`);
      }
      continue;
    }
    if (task.covers.length === 0 && task.verifies.length === 0) {
      errors.push(`${task.id} must cover a BEH or own a VER`);
    }
    if (task.scope.length === 0) {
      errors.push(`${task.id}.scope must name at least one component boundary`);
    }
    for (const behaviorId of task.covers) {
      if (!behaviorId.startsWith('BEH-') || !(behaviorId in snapshot.sourceDigests)) {
        errors.push(`${task.id}.covers contains unknown behavior ${behaviorId}`);
      } else {
        appendOwner(behaviorOwners, behaviorId, task.id);
      }
    }
    for (const verificationId of task.verifies) {
      if (!verificationId.startsWith('VER-') || !(verificationId in snapshot.sourceDigests)) {
        errors.push(`${task.id}.verifies contains unknown verification ${verificationId}`);
      } else {
        appendOwner(verificationOwners, verificationId, task.id);
      }
    }
    if (task.status === 'done') {
      for (const evidenceType of ['commits', 'checks', 'reviews'] as const) {
        if (task.evidence[evidenceType].length === 0) {
          errors.push(`${task.id} is done but evidence.${evidenceType} is empty`);
        }
      }
    }
  }

  const tasksById = new Map(
    tasks.map((task) => {
      return [task.id, task];
    }),
  );
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      const dependency = tasksById.get(dependencyId);
      if (!dependency) {
        errors.push(`${task.id} depends on unknown task ${dependencyId}`);
      } else if (dependency.status === 'cancelled') {
        errors.push(`${task.id} depends on cancelled task ${dependencyId}`);
      } else if ((task.status === 'in_progress' || task.status === 'done') && dependency.status !== 'done') {
        errors.push(`${task.id} is ${task.status} before dependency ${dependencyId} is done`);
      }
      if (dependencyId === task.id) {
        errors.push(`${task.id} cannot depend on itself`);
      }
    }
  }

  for (const id of Object.keys(snapshot.sourceDigests)) {
    if (id.startsWith('BEH-') && !behaviorOwners.has(id)) {
      errors.push(`${id} is not covered by an active task`);
    }
    if (id.startsWith('VER-')) {
      const owners = verificationOwners.get(id) ?? [];
      if (owners.length === 0) {
        errors.push(`${id} has no active evidence owner`);
      } else if (owners.length > 1) {
        errors.push(`${id} has multiple evidence owners: ${owners.join(', ')}`);
      }
    }
  }

  detectDependencyCycles(tasks, errors);
  const readiness = options.readiness ?? 'basic';
  if (readiness === 'ready') {
    for (const task of tasks) {
      if (task.status === 'blocked' || task.status === 'invalidated') {
        errors.push(`${task.id} is ${task.status} and cannot enter implementation`);
      }
    }
  }
  if (readiness === 'final') {
    for (const task of tasks) {
      if (task.status !== 'done' && task.status !== 'cancelled') {
        errors.push(`${task.id} must be done or cancelled for final delivery`);
      }
    }
  }

  return errors;
}

function addDefinition(definitions: Map<string, string>, id: string, value: string): void {
  if (definitions.has(id)) {
    throw new Error(`Spec defines ${id} more than once`);
  }
  definitions.set(id, digest(value));
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof record[key] !== 'string' || record[key].length === 0) {
    errors.push(`${key} must be a non-empty string`);
  }
}

function readStringRecord(value: unknown, label: string, errors: string[]): Record<string, string> | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object of string values`);
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      errors.push(`${label}.${key} must be a string`);
    } else {
      result[key] = entry;
    }
  }
  return result;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string[] | undefined {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.some((entry) => {
      return typeof entry !== 'string' || !entry;
    })
  ) {
    errors.push(`${label}.${key} must be an array of non-empty strings`);
    return undefined;
  }
  if (new Set(value).size !== value.length) {
    errors.push(`${label}.${key} must not contain duplicates`);
  }
  return value as string[];
}

function readTask(value: unknown, index: number, errors: string[]): ImplementationTask | undefined {
  const label = `tasks[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  const id = value.id;
  const title = value.title;
  const status = value.status;
  if (typeof id !== 'string' || !/^IMP-\d{3,}$/.test(id)) {
    errors.push(`${label}.id must match IMP-NNN`);
  }
  if (typeof title !== 'string' || !title.trim()) {
    errors.push(`${label}.title must be a non-empty string`);
  }
  if (typeof status !== 'string' || !TASK_STATUSES.has(status as TaskStatus)) {
    errors.push(`${label}.status is invalid`);
  }
  const covers = readStringArray(value, 'covers', label, errors);
  const verifies = readStringArray(value, 'verifies', label, errors);
  const dependsOn = readStringArray(value, 'dependsOn', label, errors);
  const scope = readStringArray(value, 'scope', label, errors);
  if (!isRecord(value.evidence)) {
    errors.push(`${label}.evidence must be an object`);
    return undefined;
  }
  const commits = readStringArray(value.evidence, 'commits', `${label}.evidence`, errors);
  const checks = readStringArray(value.evidence, 'checks', `${label}.evidence`, errors);
  const reviews = readStringArray(value.evidence, 'reviews', `${label}.evidence`, errors);
  if (
    typeof id !== 'string' ||
    !/^IMP-\d{3,}$/.test(id) ||
    typeof title !== 'string' ||
    !title.trim() ||
    typeof status !== 'string' ||
    !TASK_STATUSES.has(status as TaskStatus) ||
    !covers ||
    !verifies ||
    !dependsOn ||
    !scope ||
    !commits ||
    !checks ||
    !reviews
  ) {
    return undefined;
  }
  return {
    id,
    title,
    status: status as TaskStatus,
    covers,
    verifies,
    dependsOn,
    scope,
    evidence: { commits, checks, reviews },
  };
}

function appendOwner(owners: Map<string, string[]>, itemId: string, taskId: string): void {
  const current = owners.get(itemId) ?? [];
  current.push(taskId);
  owners.set(itemId, current);
}

function detectDependencyCycles(tasks: ImplementationTask[], errors: string[]): void {
  const activeTasks = new Map(
    tasks
      .filter((task) => {
        return task.status !== 'cancelled';
      })
      .map((task) => {
        return [task.id, task];
      }),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string, path: string[]): void => {
    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      errors.push(`task dependency cycle: ${[...path.slice(cycleStart), taskId].join(' -> ')}`);
      return;
    }
    if (visited.has(taskId)) {
      return;
    }
    const task = activeTasks.get(taskId);
    if (!task) {
      return;
    }
    visiting.add(taskId);
    for (const dependencyId of task.dependsOn) {
      visit(dependencyId, [...path, taskId]);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const taskId of activeTasks.keys()) {
    visit(taskId, []);
  }
}

function repositoryRelativePath(path: string): string {
  const result = relative(process.cwd(), resolve(path));
  if (!result || result === '..' || result.startsWith(`..${sep}`)) {
    throw new Error('--spec must point to a file inside the current repository');
  }
  return result.split(sep).join('/');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function asLedger(value: unknown): TaskLedger {
  if (!isRecord(value) || !isRecord(value.sourceDigests)) {
    throw new Error('ledger must contain specDigest, contextDigest, and sourceDigests');
  }
  if (typeof value.specDigest !== 'string') {
    throw new Error('ledger.specDigest must be a string');
  }
  if (typeof value.contextDigest !== 'string') {
    throw new Error('ledger.contextDigest must be a string');
  }
  const sourceDigests: Record<string, string> = {};
  for (const [id, entry] of Object.entries(value.sourceDigests)) {
    if (typeof entry !== 'string') {
      throw new Error(`ledger.sourceDigests.${id} must be a string`);
    }
    sourceDigests[id] = entry;
  }
  return { ...value, sourceDigests } as unknown as TaskLedger;
}

function parseArguments(argv: string[]): {
  command: string;
  spec?: string;
  ledger?: string;
  readiness: Readiness;
} {
  const command = argv[0] ?? 'help';
  let spec: string | undefined;
  let ledger: string | undefined;
  let readiness: Readiness = 'basic';
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--ready') {
      readiness = 'ready';
    } else if (argument === '--final') {
      readiness = 'final';
    } else if (argument === '--spec' || argument === '--ledger') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a path`);
      }
      if (argument === '--spec') {
        spec = value;
      } else {
        ledger = value;
      }
      index += 1;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return { command, spec, ledger, readiness };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  spec-tasks.ts snapshot --spec <spec.md>
  spec-tasks.ts diff --spec <spec.md> --ledger <tasks.json>
  spec-tasks.ts check [--ready|--final] --spec <spec.md> --ledger <tasks.json>
`);
}

function main(argv: string[]): void {
  const { command, spec, ledger, readiness } = parseArguments(argv);
  if (command === 'help' || command === '--help') {
    printHelp();
    return;
  }
  if (!spec) {
    throw new Error('--spec is required');
  }
  const specLabel = repositoryRelativePath(spec);
  const snapshot = parseSpec(readFileSync(spec, 'utf8'));
  if (command === 'snapshot') {
    process.stdout.write(`${JSON.stringify({ spec: specLabel, ...snapshot }, null, 2)}\n`);
    return;
  }
  if (!ledger) {
    throw new Error('--ledger is required');
  }
  const ledgerValue = readJson(ledger);
  if (command === 'diff') {
    process.stdout.write(`${JSON.stringify(compareSpec(snapshot, asLedger(ledgerValue)), null, 2)}\n`);
    return;
  }
  if (command === 'check') {
    const errors = validateLedger(snapshot, ledgerValue, {
      expectedSpec: specLabel,
      readiness,
    });
    if (errors.length > 0) {
      process.stderr.write(`${JSON.stringify({ ok: false, errors }, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    const taskCount = isRecord(ledgerValue) && Array.isArray(ledgerValue.tasks) ? ledgerValue.tasks.length : 0;
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        readiness,
        behaviors: Object.keys(snapshot.sourceDigests).filter((id) => {
          return id.startsWith('BEH-');
        }).length,
        verifications: Object.keys(snapshot.sourceDigests).filter((id) => {
          return id.startsWith('VER-');
        }).length,
        tasks: taskCount,
      })}\n`,
    );
    return;
  }
  throw new Error(`unknown command ${command}`);
}

const currentScript = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (currentScript === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, errors: [message] }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
