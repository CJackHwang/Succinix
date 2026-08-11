// commands.ts 纯函数单测（P3-11）：表格构建 / 端口匹配 / uname / workspace / 分发 smoke。
// commands.ts 是最大的文件（1400+ 行），命令处理器大多需要真实容器，这里覆盖已导出的纯逻辑
// + 用 capture shim 冒烟若干无副作用的浏览器侧命令。uname 运行时版本在 vitest 回落空串。
import { describe, it, expect, beforeEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { FakeFS, FakeClient } from './helpers/fakes.js';
import type { FileSystemAPI, WebContainer } from '@webcontainer/api';
import { instancePorts } from '../src/instance/ports.js';
import { clearDbActivePorts } from '../src/services/index.js';
import {
  fmtUnit,
  buildWorkspaceList,
  workspaceCreate,
  workspaceSwitch,
  workspaceRemove,
  getCurrentWorkspace,
  listWorkspaces,
  commandMentionsPort,
  processLabel,
  buildNetstatRows,
  buildUnameLine,
  buildUnameAllLine,
  unameRuntimeVersion,
  detectUnameArch,
  tryHandleLocalCommand,
  type CommandContext,
} from '../src/commands.js';

beforeEach(() => {
  instancePorts.clear();
  clearDbActivePorts('c-1');
});

function captureTerm(): Terminal & { lines: string[] } {
  const lines: string[] = [];
  const term = {
    lines,
    writeln: (l: unknown) => void lines.push(String(l)),
    write: (d: unknown) => void lines.push(String(d)),
    clear: () => {},
  } as unknown as Terminal & { lines: string[] };
  return term;
}

function ctxOf(overrides: Partial<CommandContext> = {}): CommandContext {
  const fs = new FakeFS() as unknown as WebContainer;
  return {
    wc: fs,
    client: new FakeClient() as unknown as CommandContext['client'],
    ports: new Map<number, string>(),
    term: captureTerm() as unknown as Terminal,
    fit: () => {},
    ...overrides,
  };
}

describe('fmtUnit', () => {
  it('二进制换算，整数尾数去 .0', () => {
    expect(fmtUnit(1024 * 1024, 'MB')).toBe('1 MB');
    expect(fmtUnit(1.5 * 1024 * 1024, 'MB')).toBe('1.5 MB');
    expect(fmtUnit(1024 ** 3, 'GB')).toBe('1 GB');
    expect(fmtUnit(2.5 * 1024 ** 3, 'GB')).toBe('2.5 GB');
  });
});

describe('buildWorkspaceList', () => {
  it('当前工作区置顶，其余按名字排序，列对齐', () => {
    const lines = buildWorkspaceList('beta', ['alpha', 'beta', 'gamma']);
    expect(lines[0]).toBe('Workspaces');
    expect(lines[1]).toContain('beta');
    expect(lines[1]).toContain('(current)');
    expect(lines[2]).toContain('alpha');
    expect(lines[3]).toContain('gamma');
    expect(lines[1]).not.toContain('(current) '); // 对齐标记不会多余
  });

  it('无工作区 → (none)', () => {
    expect(buildWorkspaceList(null, [])).toEqual(['Workspaces', '  (none)']);
  });

  it('current 不在列表时只按名字排', () => {
    const lines = buildWorkspaceList('ghost', ['b', 'a']);
    expect(lines[1]).toContain('a');
    expect(lines[1]).not.toContain('(current)');
  });
});

describe('workspace create / switch / remove', () => {
  it('create → list 可见；重名报错', async () => {
    const fs = new FakeFS() as unknown as FileSystemAPI;
    const r = await workspaceCreate(fs, 'dev');
    expect(r.ok).toBe(true);
    expect(await listWorkspaces(fs)).toContain('dev');
    const dup = await workspaceCreate(fs, 'dev');
    expect(dup.ok).toBe(false);
    expect(dup.message).toContain('already exists');
  });

  it('非法名 / 空名拒绝', async () => {
    const fs = new FakeFS() as unknown as FileSystemAPI;
    expect((await workspaceCreate(fs, 'a/b')).ok).toBe(false);
    expect((await workspaceCreate(fs, '')).ok).toBe(false);
    expect((await workspaceCreate(fs, '.hidden')).ok).toBe(false);
  });

  it('switch 更新 .current；不存在报错', async () => {
    const fs = new FakeFS() as unknown as FileSystemAPI;
    await workspaceCreate(fs, 'main');
    await workspaceCreate(fs, 'test');
    const r = await workspaceSwitch(fs, 'test');
    expect(r.ok).toBe(true);
    expect(await getCurrentWorkspace(fs)).toBe('test');
    expect((await workspaceSwitch(fs, 'nope')).ok).toBe(false);
  });

  it('rm 需 --yes；禁止删当前与 main', async () => {
    const fs = new FakeFS() as unknown as FileSystemAPI;
    await workspaceCreate(fs, 'main');
    await workspaceCreate(fs, 'old');
    const current = await getCurrentWorkspace(fs);
    expect((await workspaceRemove(fs, 'old', current, false)).ok).toBe(false); // 需 --yes
    expect((await workspaceRemove(fs, 'main', current, true)).ok).toBe(false); // 禁删 main
    const r = await workspaceRemove(fs, 'old', current, true);
    expect(r.ok).toBe(true);
    expect(await listWorkspaces(fs)).not.toContain('old');
  });
});

describe('commandMentionsPort', () => {
  it('拒绝子串误关联（3001 ↔ 300/30010）', () => {
    expect(commandMentionsPort('node x --port 3001', 3001)).toBe(true);
    expect(commandMentionsPort('node x --port=3001', 3001)).toBe(true);
    expect(commandMentionsPort('node x --port:3001', 3001)).toBe(true);
    expect(commandMentionsPort('listen(3001)', 3001)).toBe(true);
    expect(commandMentionsPort('node x 3001', 3001)).toBe(true); // 裸 token
    expect(commandMentionsPort('node x --port 300', 3001)).toBe(false);
    expect(commandMentionsPort('node x --port 30010', 3001)).toBe(false);
    expect(commandMentionsPort('echo 3001extra', 3001)).toBe(false); // 无词边界
  });
});

describe('processLabel', () => {
  it('npx <pkg> → <pkg>；跳过前置 flag', () => {
    expect(processLabel('npx tinbase start')).toBe('tinbase');
    expect(processLabel('npx --yes tinbase')).toBe('tinbase');
    expect(processLabel('npx')).toBe('npx');
  });

  it('node 脚本 → node <script>.js；http server 特判', () => {
    expect(processLabel('node server.js --port 3001')).toBe('node server.js');
    expect(processLabel('node -e "http.createServer()"')).toBe('node http server');
    expect(processLabel('node')).toBe('node');
  });

  it('其余命令取首词', () => {
    expect(processLabel('python app.py')).toBe('python');
    expect(processLabel('npm run build')).toBe('npm');
  });
});

describe('db start statePrefix (D6)', () => {
  it('custom statePrefix flows into tinbase --data-dir', async () => {
    const client = new FakeClient();
    client.whenTerminal('test -d /workspace/node_modules/tinbase', { ok: true }); // 已安装，跳过 npm install
    const ctx = ctxOf({
      client: client as unknown as CommandContext['client'],
      instanceId: 'c-1',
      statePrefix: '/var/succinix/',
      ports: new Map([[3001, 'http://localhost:3001']]), // 预置就绪端口：spawn 后立即命中，不等 30s
    });
    const handled = await tryHandleLocalCommand(ctx, 'db start');
    expect(handled).toBe(true);
    expect(client.spawnCalls.length).toBe(1);
    expect(client.spawnCalls[0].command).toContain('--engine wasm');
    expect(client.spawnCalls[0].command).toContain('--data-dir /var/succinix/c-1/tinbase');
  });

  it('default instance keeps legacy data dir (no --data-dir flag)', async () => {
    const client = new FakeClient();
    client.whenTerminal('test -d /workspace/node_modules/tinbase', { ok: true });
    const ctx = ctxOf({
      client: client as unknown as CommandContext['client'],
      ports: new Map([[3001, 'http://localhost:3001']]),
    });
    const handled = await tryHandleLocalCommand(ctx, 'db start');
    expect(handled).toBe(true);
    expect(client.spawnCalls[0].command).not.toContain('--data-dir');
  });
});

describe('buildNetstatRows', () => {
  it('-p 关联进程；无匹配显示 -；无 -p 时 process 为空串', async () => {
    const ports = new Map<number, string>([[3001, 'http://x']]);
    const client = new FakeClient({
      terminal: () => ({
        ok: true,
        processes: [{ pid: 9, status: 'running', cmd: 'node server.js --port 3001' }],
      }),
    });
    const rows = await buildNetstatRows(ports, client as never, true);
    expect(rows[0]).toMatchObject({ proto: 'tcp', state: 'LISTEN', localAddress: '127.0.0.1:3001' });
    expect(rows[0].process).toBe('node server.js (pid 9)');

    const rows2 = await buildNetstatRows(ports, client as never, false);
    expect(rows2[0].process).toBe('');
  });

  it('进程表不可达 → 全部按 - 显示', async () => {
    const ports = new Map<number, string>([[3001, 'http://x']]);
    const client = new FakeClient({
      terminal: () => {
        throw new Error('host down');
      },
    });
    const rows = await buildNetstatRows(ports, client as never, true);
    expect(rows[0].process).toBe('-');
  });
});

describe('uname 纯函数', () => {
  it('buildUnameLine 结构：系统名 版本 内核 运行时 架构', () => {
    const line = buildUnameLine();
    expect(line.startsWith('Succinix ')).toBe(true);
    expect(/^Succinix \d+\.\d+\.\d+ js-runtime\+webcontainer /.test(line)).toBe(true);
  });

  it('buildUnameAllLine 含主机名与操作系统', () => {
    const line = buildUnameAllLine();
    expect(line).toContain(' succinix ');
    expect(line.endsWith(' browser-native')).toBe(true);
  });

  it('unameRuntimeVersion 是运行时版本字段（vitest 回落空串）', () => {
    expect(typeof unameRuntimeVersion()).toBe('string');
  });

  it('detectUnameArch 从 UA 提取或回落 unknown', () => {
    const arch = detectUnameArch();
    expect(['x86_64', 'arm64', 'unknown']).toContain(arch);
  });
});

describe('tryHandleLocalCommand 冒烟（无副作用命令）', () => {
  it('version / whoami / ports / clear 浏览器侧直接处理', async () => {
    const term = captureTerm();
    const ctx = ctxOf({ term: term as unknown as Terminal });
    expect(await tryHandleLocalCommand(ctx, 'version')).toBe(true);
    expect(term.lines[0]).toMatch(/^Succinix \d+\.\d+\.\d+ /);
    expect(await tryHandleLocalCommand(ctx, 'whoami')).toBe(true);
    expect(term.lines.at(-1)).toBe('guest');
    expect(await tryHandleLocalCommand(ctx, 'ports')).toBe(true);
    expect(await tryHandleLocalCommand(ctx, 'clear')).toBe(true);
  });

  it('host 命令不拦截（返回 false 交由 TerminalExecutor 路由）', async () => {
    const ctx = ctxOf();
    expect(await tryHandleLocalCommand(ctx, 'ls -la')).toBe(false);
    expect(await tryHandleLocalCommand(ctx, 'node x.js')).toBe(false);
  });

  it('uname -a 走命令分发路径且不抛错', async () => {
    const term = captureTerm();
    const ctx = ctxOf({ term: term as unknown as Terminal });
    expect(await tryHandleLocalCommand(ctx, 'uname -a')).toBe(true);
    expect(term.lines.length).toBe(1);
    expect(term.lines[0]).toMatch(/^Succinix /);
  });
});
