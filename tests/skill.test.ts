import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const skillPath = fileURLToPath(new URL('../skills/chatgpt-pro-collab/SKILL.md', import.meta.url));

describe('BEH-003/BEH-005 first-turn collaboration contract', () => {
  it('requires one combined first message and keeps later turns on conversation context', async () => {
    const skill = await readFile(skillPath, 'utf8');

    expect(skill.match(/你现在处于协作模式/gu)).toHaveLength(1);
    expect(skill).toContain('合成同一个 prompt 文件');
    expect(skill).toContain('不要让 `start` 或额外的 `send` 单独提交启动声明');
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
});
