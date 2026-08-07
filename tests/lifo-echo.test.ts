// V1 审计 H1-1 回归测试：Lifo 混合链 `echo > file` 落盘必须是 POSIX LF（\n），不得含 CR（\r\n）。
// 背景：审计曾怀疑 Lifo echo 重定向落盘为 CRLF（文件每行多 1 字节，破坏校验和/diff/verification）。
// 实测 @lifo-sh/core 0.10.8：echo 输出本就是 LF（`echo shared-agent-file >` 落盘 = 17 字符 + LF = 18 B）。
// 本测试把该语义锁进单测，防止未来 Lifo 升级回退成 CRLF。真实 Sandbox + 真实 fs 挂载，
// 与被测链路（host.ts getSandbox 的 mounts 配置）一致，而非 mock 猜测。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sandbox } from '@lifo-sh/core';

let hostPath = '';
let sandbox: Awaited<ReturnType<typeof Sandbox.create>>;

beforeAll(async () => {
  hostPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lifo-echo-test-'));
  sandbox = await Sandbox.create({
    cwd: '/workspace',
    mounts: [{ virtualPath: '/workspace', hostPath, fsModule: fs }],
  });
});

afterAll(() => {
  fs.rmSync(hostPath, { recursive: true, force: true });
});

function readBytes(relative: string): Buffer {
  return fs.readFileSync(path.join(hostPath, relative));
}

describe('Lifo echo redirection — POSIX LF, no CR', () => {
  it('echo hi > file writes "hi\\n" (3 bytes) — LF, never CRLF', async () => {
    const r = await sandbox.commands.run('echo hi > simple.txt');
    expect(r.exitCode).toBe(0);
    const buf = readBytes('simple.txt');
    expect(buf.toString('utf8')).toBe('hi\n');
    expect(buf.toString('utf8')).not.toContain('\r');
    expect(buf.length).toBe(3); // 'h' 'i' '\n'，无 CR
    expect(buf.toString('hex')).toBe('68690a');
  });

  it('echo shared-agent-file > file writes 17 chars + LF (18 bytes) with no CR', async () => {
    const r = await sandbox.commands.run('echo shared-agent-file > shared.txt');
    expect(r.exitCode).toBe(0);
    const buf = readBytes('shared.txt');
    const text = buf.toString('utf8');
    expect(text).toBe('shared-agent-file\n');
    expect(text).not.toContain('\r');
    expect(buf.length).toBe(18); // "shared-agent-file" 17 字符 + LF
  });

  it('echo inside a cd && chain (mixed Lifo shell chain) still writes LF', async () => {
    const r = await sandbox.commands.run('cd /workspace && echo chain > chain.txt');
    expect(r.exitCode).toBe(0);
    const buf = readBytes('chain.txt');
    expect(buf.toString('utf8')).toBe('chain\n');
    expect(buf.toString('utf8')).not.toContain('\r');
    expect(buf.length).toBe(6);
  });

  it('redirect through a real node segment keeps POSIX LF (no \r\n injection)', async () => {
    // node 段经 registerRealBinaryCommands 转发；输出写进 Lifo ctx 流，再经 Lifo 重定向落盘。
    const r = await sandbox.commands.run('node -e "process.stdout.write(\'from-node\\n\')" > node-out.txt');
    expect(r.exitCode).toBe(0);
    const buf = readBytes('node-out.txt');
    expect(buf.toString('utf8')).toBe('from-node\n');
    expect(buf.toString('utf8')).not.toContain('\r');
    expect(buf.length).toBe(10); // 'from-node' 9 字符 + LF
  });
});
