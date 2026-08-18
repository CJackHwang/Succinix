import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allocateBrowserPorts, cleanupChrome } from '../scripts/lib/chrome.mjs';

const BROWSER_GATES = [
  'scripts/cordis-app-e2e.mjs',
  'scripts/cordis-poc-check.mjs',
  'scripts/instance-routing.mjs',
  'scripts/lang-verify.mjs',
  'scripts/scenarios.mjs',
  'scripts/verify-bootgate.mjs',
  'scripts/verify-deploy.mjs',
];

describe('浏览器诊断生命周期', () => {
  it('为 preview 与 DevTools 分配不同的 localhost 端口', async () => {
    const ports = await allocateBrowserPorts();
    expect(ports.previewPort).toBeGreaterThan(0);
    expect(ports.debugPort).toBeGreaterThan(0);
    expect(ports.previewPort).not.toBe(ports.debugPort);
  });

  it('等待子进程退出后删除临时 profile', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'succinix-chrome-cleanup-test-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    const cleanup = await cleanupChrome(child, profileDir, { timeoutMs: 2_000 });
    expect(cleanup.exited).toBe(true);
    expect(cleanup.profileRemoved).toBe(true);
    expect(existsSync(profileDir)).toBe(false);
  });

  it('在根进程先退出而后代忽略 SIGTERM 时，等待 SIGKILL 清空进程组后再删除 profile', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'succinix-chrome-group-cleanup-test-'));
    const root = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(child.pid));
      setInterval(() => {}, 1000);
    `], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let childPid: number | null = null;
    try {
      childPid = await readChildPid(root);
      const cleanup = await cleanupChrome(root, profileDir, { timeoutMs: 2_000 });
      expect(cleanup.exited).toBe(true);
      expect(cleanup.processGroupAfter).toEqual([]);
      expect(cleanup.profileRemoved).toBe(true);
      expect(isRunning(childPid)).toBe(false);
    } finally {
      if (root.pid && process.platform !== 'win32') {
        try { process.kill(-root.pid, 'SIGKILL'); } catch { /* test cleanup */ }
      }
      if (childPid !== null) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* test cleanup */ }
      }
    }
  });

  it('所有浏览器门禁都会等待 Chrome 清理完成', () => {
    for (const file of BROWSER_GATES) {
      expect(readFileSync(join(process.cwd(), file), 'utf8')).toMatch(/await cleanupChrome\(/);
    }
  });
});

function readChildPid(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not report its pid')), 2_000);
    child.stdout?.once('data', (value: Buffer) => {
      clearTimeout(timer);
      resolve(Number(value.toString()));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const stat = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    return stat.length > 0 && !stat.startsWith('Z');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
