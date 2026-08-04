import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('BEH-010 host archive guidance', () => {
  it('keeps archive selection with the host and documents metadata-free member checks', async () => {
    const skillPath = fileURLToPath(new URL('../skills/chatgpt-pro-collab/SKILL.md', import.meta.url));
    const skill = await readFile(skillPath, 'utf8');

    expect(skill).toContain('COPYFILE_DISABLE=1 tar --no-xattrs -czf <archive.tar.gz> <selected-path>...');
    expect(skill).toContain('tar -tzf <archive.tar.gz>');
    expect(skill).toContain('zip -X <archive.zip> <selected-path>...');
    expect(skill).toContain('unzip -Z1 <archive.zip>');
    expect(skill).toContain('生成后必须列出成员并与本轮选择结果核对');
    expect(skill).toContain('Collab 运行时不得扫描、打包或自动补充仓库文件');
  });

  it('routes one finite wait call without host-side page polling', async () => {
    const skillPath = fileURLToPath(new URL('../skills/chatgpt-pro-collab/SKILL.md', import.meta.url));
    const skill = await readFile(skillPath, 'utf8');

    expect(skill).toContain('wait <taskId> <turnId> <observationWindowMs> <captureTimeoutMs>');
    expect(skill).toContain('每个观察窗口只调用一次 `wait`');
    expect(skill).toContain('结果为 `pending` 时，远端生成与本地任务保持活动');
    expect(skill).toContain('捕获超时会返回错误');
  });
});
