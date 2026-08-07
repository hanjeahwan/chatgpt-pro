import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map((part) => {
  return Number(part);
});

function runNode(scriptPath: string, args: readonly string[], cwd: string): string {
  return execFileSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' });
}

describe('VER-010 deterministic implementation checks', () => {
  it('prints a stable help synopsis with every documented command form', () => {
    const help = runNode(
      fileURLToPath(new URL('../skills/chatgpt-pro-collab/scripts/collab.ts', import.meta.url)),
      ['help'],
      process.cwd(),
    );
    expect(help).toContain('start <taskId>');
    expect(help).toContain('wait <taskId> <turnId> <observationWindowMs> <captureTimeoutMs>');
    expect(help).toContain('status <taskId>');
    expect(help).toContain('recover <taskId>');
    expect(help).toContain('resolve-submission <taskId> <turnId> submitted <conversationUrl>');
    expect(help).toContain('resolve-submission <taskId> <turnId> not-submitted');
    expect(help).toContain('archive <taskId>');
    expect(help).toContain('close <taskId>');
  });

  it('runs the CLI help from a temporary host directory without a package.json', async () => {
    const host = await mkdtemp(join(tmpdir(), 'collab-no-manifest-'));
    const cliPath = fileURLToPath(new URL('../skills/chatgpt-pro-collab/scripts/collab.ts', import.meta.url));
    const help = runNode(cliPath, ['--help'], host);
    expect(help).toContain('start <taskId>');
    expect(help).toContain('wait <taskId> <turnId> <observationWindowMs> <captureTimeoutMs>');
    expect(help).toContain('resolve-submission <taskId> <turnId> submitted <conversationUrl>');
  });
});

describe('VER-012 runtime prerequisites', () => {
  it('runs on the supported Node version range', () => {
    expect(nodeMajor).toBeGreaterThanOrEqual(22);
    if (nodeMajor === 22) {
      expect(nodeMinor).toBeGreaterThanOrEqual(19);
    }
  });

  it('smoke-tests an in-memory node:sqlite DatabaseSync', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE probe (value TEXT)');
    database.prepare('INSERT INTO probe (value) VALUES (?)').run('ok');
    const row = database.prepare('SELECT value FROM probe').get() as { value: string };
    expect(row.value).toBe('ok');
    database.close();
  });

  it('smoke-tests the minimal TypeScript entry with native type stripping', async () => {
    const host = await mkdtemp(join(tmpdir(), 'collab-ts-smoke-'));
    const entry = join(host, 'smoke.ts');
    await writeFile(entry, 'const probe: string = "ok"; console.log(probe);');
    expect(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim()).toBe('ok');
  });

  it('executes the fixed Playwright CLI help and browser-less raw list', () => {
    const help = execFileSync('npx', ['-y', '@playwright/cli@0.1.17', '--help'], { encoding: 'utf8' });
    expect(help).toContain('playwright-cli');
    const listed = execFileSync('npx', ['-y', '@playwright/cli@0.1.17', '--raw', 'list'], { encoding: 'utf8' });
    expect(listed).toMatch(/\(no browsers\)/u);
  });
});
