import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type {
  BrowserArchiveState,
  BrowserArtifactDownload,
  BrowserAvailability,
  BrowserCaptureResult,
  BrowserObservationResult,
  BrowserOperationObserver,
  BrowserSendResult,
  BrowserSessionInfo,
} from '../skills/chatgpt-pro-collab/scripts/browser.ts';
import { CollabService, runCli, type CliIo, type CollabBrowser } from '../skills/chatgpt-pro-collab/scripts/collab.ts';
import { collabPaths, ensureCollabDirectories } from '../skills/chatgpt-pro-collab/scripts/session.ts';
import { StateStore } from '../skills/chatgpt-pro-collab/scripts/state.ts';

const skillPath = fileURLToPath(new URL('../skills/chatgpt-pro-collab/SKILL.md', import.meta.url));

function seedText(): string {
  return JSON.stringify({
    cookies: [{ name: 'session', domain: '.chatgpt.com', path: '/', value: 'test' }],
    origins: [{ origin: 'https://chatgpt.com', localStorage: [{ name: 'oai-did', value: 'test' }] }],
  });
}

describe('BEH-003/BEH-005 first-turn collaboration contract', () => {
  it('requires one combined first message and keeps later turns on conversation context', async () => {
    const skill = await readFile(skillPath, 'utf8');

    expect(skill.match(/你现在处于协作模式/gu)).toHaveLength(1);
    expect(skill).toContain('在尚未绑定 conversation 时，为首条 user message 发起的每次 `send` 都必须');
    expect(skill).toContain('你作为独立协作者，负责完成“当前任务”声明的有界工作');
    expect(skill).toContain('对于宿主环境和仓库事实');
    expect(skill).toContain('可以使用当前 ChatGPT 会话实际提供的工具');
    expect(skill).toContain('直接处理当前任务，不要只确认协作模式');
    expect(skill).toContain('采用合理假设继续，并说明假设错误会改变什么');
    expect(skill).toContain('不要让 `start` 或额外的 `send` 单独提交启动声明');
    expect(skill).toContain('首次提交前确定失败时，后续显式 `send` 仍须使用完整合同');
    expect(skill).toContain('conversation 绑定后的后续 prompt 依赖已有上下文，不再重复该合同');
    expect(skill).toContain('当前任务：');
  });
});

describe('BEH-010 host archive guidance', () => {
  it('keeps archive selection with the host and documents metadata-free member checks', async () => {
    const skill = await readFile(skillPath, 'utf8');

    expect(skill).toContain('COPYFILE_DISABLE=1 tar --no-xattrs -czf <archive.tar.gz> <selected-path>...');
    expect(skill).toContain('tar -tzf <archive.tar.gz>');
    expect(skill).toContain('zip -X <archive.zip> <selected-path>...');
    expect(skill).toContain('unzip -Z1 <archive.zip>');
    expect(skill).toContain('生成后必须列出成员并与本轮选择结果核对');
    expect(skill).toContain('Collab 运行时不得扫描、打包或自动补充仓库文件');
  });
});

describe('BEH-011/VER-014 one finite wait call per observation window', () => {
  it('documents the single-call wait contract in the Skill', async () => {
    const skill = await readFile(skillPath, 'utf8');
    expect(skill).toContain('wait <taskId> <turnId> <observationWindowMs> <captureTimeoutMs>');
    expect(skill).toContain('每个观察窗口只调用一次 `wait`');
    expect(skill).toContain('结果为 `pending` 时，远端生成与本地任务保持活动');
    expect(skill).toContain('捕获超时会返回错误');
  });

  it('runs the Skill wait command form against the real CLI and yields exactly one terminal JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-skill-'));
    const paths = collabPaths(root);
    await ensureCollabDirectories(paths);
    const browser = new SkillFixtureBrowser(paths);
    const service = new CollabService(paths, browser, () => {
      return new StateStore(paths.database);
    });
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

    expect(await runCli(['setup'], service, io)).toBe(0);
    expect(await runCli(['start', randomUUID()], service, io)).toBe(0);
    const started = JSON.parse(output.at(-1) ?? '{}') as { taskId?: string };
    expect(started.taskId).toBeTypeOf('string');

    const taskId = started.taskId as string;
    const promptPath = join(root, 'prompt.md');
    await writeFile(promptPath, 'host-selected prompt');
    expect(await runCli(['send', taskId, promptPath], service, io)).toBe(0);
    const sent = JSON.parse(output.at(-1) ?? '{}') as { turnId?: string };
    expect(sent.turnId).toBeTypeOf('string');

    output.length = 0;
    expect(await runCli(['wait', taskId, sent.turnId as string, '20000', '20000'], service, io)).toBe(0);
    expect(output).toHaveLength(1);
    expect(errors).toHaveLength(0);
    const waited = JSON.parse(output[0] ?? '{}') as { status?: string; responsePath?: string };
    expect(waited.status).toBe('completed');
    expect(waited.responsePath).toBeTypeOf('string');
    expect(await readFile(waited.responsePath as string, 'utf8')).toBe(`response for ${taskId}`);

    expect(output[0]).toContain('wait');
  });
});

export class SkillFixtureBrowser implements CollabBrowser {
  readonly #paths: ReturnType<typeof collabPaths>;
  readonly #conversations = new Map<string, string>();
  #userTurnOrdinal = 0;
  #nextPid = 10_000;

  /**
   * Creates a deterministic browser boundary rooted in the test data directory.
   *
   * @param paths Test Collab paths.
   * @throws {Error} This constructor does not perform I/O.
   */
  constructor(paths: ReturnType<typeof collabPaths>) {
    this.#paths = paths;
  }

  async setup(): Promise<string> {
    await writeFile(this.#paths.seedState, seedText());
    return this.#paths.seedState;
  }

  async setupOpen(_sessionName: string): Promise<void> {}

  async setupSaveSeed(_sessionName: string, seedStatePath: string): Promise<{ readonly seedValidated: boolean }> {
    await writeFile(seedStatePath, seedText());
    return { seedValidated: true };
  }

  async setupClose(_sessionName: string): Promise<{ readonly sessionClosed: boolean }> {
    return { sessionClosed: true };
  }

  async verifyAuthenticatedSeed(
    _sessionName: string,
    _seedStatePath: string,
  ): Promise<{ readonly authenticated: boolean }> {
    return { authenticated: true };
  }

  async startTask(
    taskId: string,
    _sessionName: string,
    _seedStatePath: string,
    _rebuild?: boolean,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserSessionInfo> {
    this.observe(observer);
    return {
      pid: 42,
      url: 'https://chatgpt.com/g/g-p-123/project',
      contextMarker: `context-${taskId}`,
      projectId: 'g-p-123',
      modelConfirmed: true,
      powerConfirmed: true,
      powerNow: 4,
      powerMin: 0,
      powerMax: 4,
      persistent: false,
    };
  }

  async sessionAvailability(_sessionName: string): Promise<BrowserAvailability> {
    return 'available';
  }

  async recoverConversation(
    taskId: string,
    _sessionName: string,
    conversationUrl: string,
    conversationId: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly conversationId: string; readonly conversationUrl: string }> {
    this.observe(observer);
    return { conversationId, conversationUrl };
  }

  async send(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string | null,
    _prompt: string,
    _attachmentPaths: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<BrowserSendResult> {
    this.observe(observer);
    const conversationId = this.#conversations.get(taskId) ?? `conversation-${taskId}`;
    this.#conversations.set(taskId, conversationId);
    this.#userTurnOrdinal += 1;
    return {
      status: 'submitted',
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      userTurnIdentity: `user-turn-${taskId}-${this.#userTurnOrdinal}`,
    };
  }

  async observeResponse(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string,
    _expectedUserTurnId: string,
    _observationWindowMs: number,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserObservationResult> {
    this.observe(observer);
    return {
      status: 'completed',
      conversationId: expectedConversationId,
      conversationUrl: `https://chatgpt.com/c/${expectedConversationId}`,
      assistantTurnId: `conversation-turn-${taskId}`,
    };
  }

  async captureResponse(
    taskId: string,
    _sessionName: string,
    expectedConversationId: string,
    _expectedAssistantTurnId: string | null,
    _captureTimeoutMs: number,
    _signal: AbortSignal,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserCaptureResult> {
    this.observe(observer);
    return {
      response: `response for ${taskId}`,
      responseHtml: `<p>response for ${taskId}</p>`,
      artifacts: [],
      conversationId: expectedConversationId,
      conversationUrl: `https://chatgpt.com/c/${expectedConversationId}`,
    };
  }

  async downloadArtifact(
    _taskId: string,
    _sessionName: string,
    _expectedConversationId: string,
    _expectedSourceUrls: readonly string[],
    _sourceUrl: string,
    _temporaryPath: string,
    _captureTimeoutMs: number,
    _signal: AbortSignal,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserArtifactDownload> {
    this.observe(observer);
    throw new Error('unused artifact download in the single-turn Skill fixture');
  }

  async closeTask(
    _taskId: string,
    _sessionName: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly wasOpen: boolean }> {
    this.observe(observer);
    return { wasOpen: false };
  }

  async archive(
    _taskId: string,
    _sessionName: string,
    _conversationId: string,
    _conversationUrl: string,
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly conversationId: string }> {
    this.observe(observer);
    throw new Error('unused archive in the single-turn Skill fixture');
  }

  async resolveSubmittedConversation(
    _taskId: string,
    _sessionName: string,
    _canonicalUrl: string,
    _expectedConversationId: string | null,
    _expectedProjectIdentity: string | null,
    _previousUserTurnIdentity: string | null,
    _prompt: string,
    _attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly conversationId: string; readonly conversationUrl: string; readonly userTurnIdentity: string }> {
    this.observe(observer);
    throw new Error('unused submission resolution in the single-turn Skill fixture');
  }

  async verifySafeComposer(
    _taskId: string,
    _sessionName: string,
    _expectedConversationId: string | null,
    _expectedProjectIdentity: string | null,
    _previousUserTurnIdentity: string | null,
    _prompt: string,
    _attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<void> {
    this.observe(observer);
    throw new Error('unused composer verification in the single-turn Skill fixture');
  }

  async cleanSendComposer(
    _taskId: string,
    _sessionName: string,
    _expectedConversationId: string | null,
    _attachmentFileNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<void> {
    this.observe(observer);
    throw new Error('unused composer cleanup in the single-turn Skill fixture');
  }

  async observeArchiveState(
    _taskId: string,
    _sessionName: string,
    _conversationUrl: string,
    _conversationId: string,
    observer?: BrowserOperationObserver,
  ): Promise<BrowserArchiveState> {
    this.observe(observer);
    throw new Error('unused archive observation in the single-turn Skill fixture');
  }

  async autoVerifySubmission(
    _taskId: string,
    _sessionName: string,
    _expectedConversationId: string | null,
    _expectedProjectIdentity: string | null,
    _previousUserTurnIdentity: string | null,
    _prompt: string,
    _attachmentNames: readonly string[],
    observer?: BrowserOperationObserver,
  ): Promise<{ readonly status: 'unresolved'; readonly reason: string }> {
    this.observe(observer);
    return { status: 'unresolved', reason: 'unused submission verification in the single-turn Skill fixture' };
  }

  async resolveFailedTurn(
    _taskId: string,
    _sessionName: string,
    _expectedConversationId: string,
    _expectedUserTurnId: string,
    _conversationUrl: string,
    observer?: BrowserOperationObserver,
  ): Promise<{
    readonly conversationId: string;
    readonly conversationUrl: string;
    readonly userTurnIdentity: string;
    readonly stop: 'absent' | 'stopped';
  }> {
    this.observe(observer);
    throw new Error('unused failed-turn resolution in the single-turn Skill fixture');
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
    const pid = this.#nextPid;
    this.#nextPid += 1;
    observer.childSpawned(pid);
    observer.commandSpawned(pid + 1000);
    observer.childExited(pid);
  }
}
