import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BrowserOperationObserver } from '../skills/chatgpt-pro-collab/scripts/browser.ts';
import { CollabService, runCli, type CliIo, type CollabBrowser } from '../skills/chatgpt-pro-collab/scripts/collab.ts';
import { collabPaths, ensureCollabDirectories } from '../skills/chatgpt-pro-collab/scripts/session.ts';
import { StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';

describe('BEH-001 through BEH-009 CLI orchestration', () => {
  it('supports setup, isolated tasks, multiple turns, idempotent wait, archive, and close', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const firstTask = await fixture.service.start();
    const secondTask = await fixture.service.start();
    expect(firstTask.taskId).not.toBe(secondTask.taskId);
    expect(firstTask.browserPid).not.toBe(secondTask.browserPid);
    expect(firstTask.contextMarker).not.toBe(secondTask.contextMarker);
    expect(firstTask.sessionDirectory).not.toBe(secondTask.sessionDirectory);

    const promptPath = join(fixture.root, 'prompt.md');
    const attachmentPath = join(fixture.root, 'attachment.txt');
    await Promise.all([writeFile(promptPath, 'first prompt'), writeFile(attachmentPath, 'opaque')]);
    const firstTurn = await fixture.service.send(firstTask.taskId, promptPath, [attachmentPath]);
    const waited = await fixture.service.wait(firstTask.taskId, firstTurn.turnId);
    const repeated = await fixture.service.wait(firstTask.taskId, firstTurn.turnId);
    expect(repeated.responsePath).toBe(waited.responsePath);
    expect(await readFile(waited.responsePath, 'utf8')).toBe(`response for ${firstTask.taskId}`);

    await writeFile(promptPath, 'second prompt');
    const secondTurn = await fixture.service.send(firstTask.taskId, promptPath, []);
    await fixture.service.wait(firstTask.taskId, secondTurn.turnId);
    expect(fixture.browser.expectedConversationIds).toEqual([null, `conversation-${firstTask.taskId}`]);
    const store = new StateStore(fixture.paths.database);
    const turns = store.listTurns(firstTask.taskId);
    expect(turns).toHaveLength(2);
    expect(
      await readFile(
        join(fixture.paths.sessionsDirectory, firstTask.taskId, 'turns', firstTurn.turnId, 'prompt.md'),
        'utf8',
      ),
    ).toBe('first prompt');
    expect(
      await readFile(
        join(fixture.paths.sessionsDirectory, firstTask.taskId, 'turns', secondTurn.turnId, 'prompt.md'),
        'utf8',
      ),
    ).toBe('second prompt');
    expect(turns[0]?.attachmentPaths).toEqual([attachmentPath]);
    store.close();

    await expect(fixture.service.archive(firstTask.taskId)).resolves.toMatchObject({ taskId: firstTask.taskId });
    expect(fixture.browser.archived).toEqual([firstTask.taskId]);
    await expect(fixture.service.close(firstTask.taskId)).resolves.toMatchObject({ alreadyClosed: false });
    await expect(fixture.service.close(firstTask.taskId)).resolves.toMatchObject({ alreadyClosed: true });
    expect(fixture.browser.closed).toEqual([firstTask.taskId]);
    expect(fixture.browser.observedOperations).toBe(6);
    await expect(fixture.service.wait(firstTask.taskId, firstTurn.turnId)).resolves.toEqual(repeated);
    await expect(fixture.service.archive(firstTask.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_ACTIVE' });
  });

  it('records submission ambiguity and blocks an automatic resend', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.service.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'ambiguous');
    fixture.browser.nextSendStatus = 'unknown-submission';

    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'SUBMISSION_UNKNOWN',
    });
    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'TURN_IN_PROGRESS',
    });
  });

  it('fails the task when an unsubmitted attachment draft cannot be cleared safely', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.service.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'unsafe cleanup');
    fixture.browser.nextSendStatus = 'unsafe-not-submitted';

    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'SUBMISSION_FAILED',
    });
    const store = new StateStore(fixture.paths.database);
    expect(store.requireTask(task.taskId).status).toBe('failed');
    store.close();
    await expect(fixture.service.send(task.taskId, promptPath, [])).rejects.toMatchObject({
      code: 'TASK_NOT_ACTIVE',
    });
  });

  it('rejects a concurrent same-task browser operation', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.service.start();
    const owner = new StateStore(fixture.paths.database);
    owner.acquireTaskOperation(task.taskId, 'wait', 'external-owner');

    await expect(fixture.service.close(task.taskId)).rejects.toMatchObject({
      code: 'TASK_OPERATION_IN_PROGRESS',
    });
    owner.releaseTaskOperation(task.taskId, 'external-owner');
    owner.close();
    await expect(fixture.service.close(task.taskId)).resolves.toMatchObject({ alreadyClosed: false });
  });

  it('re-reads archive lifecycle state after acquiring the task lease', async () => {
    const fixture = await serviceFixture();
    await fixture.service.setup();
    const task = await fixture.service.start();
    const promptPath = join(fixture.root, 'prompt.md');
    await writeFile(promptPath, 'establish conversation');
    await fixture.service.send(task.taskId, promptPath, []);
    const service = new CollabService(
      fixture.paths,
      fixture.browser,
      () => {
        return new FailTaskAfterArchiveLeaseStore(fixture.paths.database, 'require-existing');
      },
      () => {
        return 'unused-id';
      },
    );

    await expect(service.archive(task.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_ACTIVE' });
    expect(fixture.browser.archived).toEqual([]);
  });

  it('rejects a pre-existing seed when no Collab state marker proves setup provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-unmarked-seed-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    await writeFile(paths.seedState, '{"legacy":true}');
    const browser = new FakeBrowser(paths);
    const service = new CollabService(paths, browser, () => {
      return new StateStore(paths.database, 'require-existing');
    });

    await expect(service.start()).rejects.toMatchObject({ code: 'STATE_NOT_INITIALIZED' });
    expect(browser.startCount).toBe(0);
    await expect(access(paths.database)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not certify a pre-existing seed when interactive setup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-failed-setup-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    await writeFile(paths.seedState, '{"legacy":true}');
    const browser = new FakeBrowser(paths);
    browser.failSetup = true;
    const service = new CollabService(paths, browser, () => {
      return new StateStore(paths.database, 'require-existing');
    });

    await expect(service.setup()).rejects.toThrowError(/injected setup failure/);
    await expect(service.start()).rejects.toMatchObject({ code: 'STATE_NOT_INITIALIZED' });
    expect(await readFile(paths.seedState, 'utf8')).toBe('{"legacy":true}');
    await expect(access(paths.database)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prints stable help and JSON usage errors', async () => {
    const fixture = await serviceFixture();
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIo = {
      writeOutput(value) {
        output.push(value);
      },
      writeError(value) {
        errors.push(value);
      },
    };

    await expect(runCli(['--', 'help'], fixture.service, io)).resolves.toBe(0);
    expect(output.join('')).toContain('pnpm collab -- send <taskId> <promptPath>');
    await expect(runCli(['wait', 'only-task'], fixture.service, io)).resolves.toBe(1);
    expect(JSON.parse(errors.at(-1) ?? '{}')).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });
});

class FailTaskAfterArchiveLeaseStore extends StateStore {
  /**
   * Simulates a lifecycle transition committed at the lease-acquisition boundary.
   *
   * @param taskId Task whose browser lease is acquired.
   * @param operation Browser operation name.
   * @param token Unique lease token.
   * @param ownerPid Lease owner process identifier.
   * @returns Nothing after acquisition and the injected archive transition.
   * @throws {Error} If acquisition or the injected transition fails.
   */
  override acquireTaskOperation(
    taskId: string,
    operation: string,
    token: string,
    ownerPid: number = process.pid,
  ): void {
    super.acquireTaskOperation(taskId, operation, token, ownerPid);
    if (operation === 'archive') {
      this.failTask(taskId);
    }
  }
}

class FakeBrowser implements CollabBrowser {
  readonly paths: ReturnType<typeof collabPaths>;
  readonly conversations = new Map<string, string>();
  readonly closed: string[] = [];
  readonly archived: string[] = [];
  readonly expectedConversationIds: Array<string | null> = [];
  observedOperations = 0;
  nextSendStatus: 'submitted' | 'unknown-submission' | 'unsafe-not-submitted' = 'submitted';
  failSetup = false;
  startCount = 0;
  nextChildPid = 20_000;

  /**
   * Creates a deterministic browser boundary rooted in the test data directory.
   *
   * @param paths Test Collab paths.
   * @throws {Error} This constructor does not perform I/O.
   */
  constructor(paths: ReturnType<typeof collabPaths>) {
    this.paths = paths;
  }

  /**
   * Writes the fake shared authentication seed.
   *
   * @returns The fake seed path.
   * @throws {Error} If the test file cannot be written.
   */
  async setup(): Promise<string> {
    if (this.failSetup) {
      throw new Error('injected setup failure');
    }
    await writeFile(this.paths.seedState, '{}');
    return this.paths.seedState;
  }

  /**
   * Returns stable isolation evidence for one fake task.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param _seedStatePath Unused shared seed.
   * @returns Fake process and context identity.
   * @throws {Error} This fake start does not throw.
   */
  startTask(taskId: string, _sessionName: string, _seedStatePath: string) {
    this.startCount += 1;
    return Promise.resolve({
      pid: 10_000 + this.startCount,
      url: 'https://chatgpt.com/',
      contextMarker: `context-${taskId}`,
      persistent: false as const,
    });
  }

  /**
   * Returns a task-stable conversation or an injected ambiguous result.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param expectedConversationId Database-bound conversation, or null for a first turn.
   * @param _prompt Exact prompt under test.
   * @param _attachmentPaths Ordered attachment paths under test.
   * @param observer Task-lease child-process observer.
   * @returns Confirmed or ambiguous fake submission.
   * @throws {Error} This fake send does not throw.
   */
  send(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string | null,
    _prompt: string,
    _attachmentPaths: readonly string[],
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    this.expectedConversationIds.push(expectedConversationId);
    if (this.nextSendStatus === 'unknown-submission') {
      this.nextSendStatus = 'submitted';
      return Promise.resolve({ status: 'unknown-submission' as const, error: 'transport ended after click' });
    }
    if (this.nextSendStatus === 'unsafe-not-submitted') {
      this.nextSendStatus = 'submitted';
      return Promise.resolve({ status: 'unsafe-not-submitted' as const, error: 'attachment cleanup failed' });
    }
    const conversationId = this.conversations.get(taskId) ?? `conversation-${taskId}`;
    this.conversations.set(taskId, conversationId);
    return Promise.resolve({
      status: 'submitted' as const,
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    });
  }

  /**
   * Returns one task-specific fake response.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param expectedConversationId Database-bound identity.
   * @param observer Task-lease child-process observer.
   * @returns Fake copied response and unchanged conversation.
   * @throws {Error} This fake wait does not throw.
   */
  waitForResponse(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string,
    observer?: BrowserOperationObserver,
  ) {
    this.observe(observer);
    return Promise.resolve({
      response: `response for ${taskId}`,
      conversationId: expectedConversationId,
      conversationUrl: `https://chatgpt.com/c/${expectedConversationId}`,
    });
  }

  /**
   * Records one fake local browser close.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param observer Task-lease child-process observer.
   * @returns An open-session cleanup result.
   * @throws {Error} This fake close does not throw.
   */
  closeTask(taskId: string, _sessionName: string, observer?: BrowserOperationObserver) {
    this.observe(observer);
    this.closed.push(taskId);
    return Promise.resolve({ wasOpen: true });
  }

  /**
   * Records one fake Web archive without closing the task.
   *
   * @param taskId Task identifier.
   * @param _sessionName Unused named session.
   * @param conversationId Database-bound identity.
   * @param observer Task-lease child-process observer.
   * @returns The same conversation identity.
   * @throws {Error} This fake archive does not throw.
   */
  archive(taskId: string, _sessionName: string, conversationId: string, observer?: BrowserOperationObserver) {
    this.observe(observer);
    this.archived.push(taskId);
    return Promise.resolve({ conversationId });
  }

  /**
   * Simulates one complete spawned browser command under the service lease.
   *
   * @param observer Observer passed through the production service boundary.
   * @returns Nothing after the fake child is attached and detached.
   * @throws {Error} If the service omitted the required operation observer.
   */
  observe(observer: BrowserOperationObserver | undefined): void {
    if (observer === undefined) {
      throw new Error('task operation observer was not supplied');
    }
    const pid = this.nextChildPid;
    this.nextChildPid += 1;
    observer.childSpawned(pid);
    observer.childExited(pid);
    this.observedOperations += 1;
  }
}

/**
 * Creates an isolated service with deterministic IDs and a fake browser.
 *
 * @returns Test root, paths, browser, and service.
 * @throws {Error} If the temporary directory or state setup fails.
 */
async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'collab-service-'));
  const paths = collabPaths(root);
  await ensureCollabDirectories(paths);
  const browser = new FakeBrowser(paths);
  let id = 0;
  const service = new CollabService(
    paths,
    browser,
    () => {
      return new StateStore(paths.database, 'require-existing');
    },
    () => {
      id += 1;
      return `id-${id}`;
    },
  );
  return { root, paths, browser, service };
}
