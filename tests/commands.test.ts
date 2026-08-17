// commands 纯函数单测：表格构建 / 端口匹配 / uname / workspace。
// 人类终端命令由 WebContainer/Lifo 执行，不在浏览器单元测试中模拟第二套分发器。
import { describe, it, expect } from 'vitest';
import { FakeFS, FakeClient } from './helpers/fakes.js';
import type { FileSystemAPI } from '@webcontainer/api';
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
  formatSuccinixStatus,
  formatSuccinixPlugins,
  type SuccinixPluginSummary,
} from '../src/commands/index.js';
import type { SuccinixPluginState } from '../src/plugin/index.js';

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

describe('succinix manageability commands (C4)', () => {
  const state: SuccinixPluginState = {
    version: '0.7.0',
    containerMode: 'internal',
    containerState: 'ready',
    host: { pid: 42, startedAt: 1720000000000 },
    instances: [{ instanceId: 'default', state: 'active' }],
    capabilities: ['terminal.exec', 'fs.read'],
    configRevision: 3,
    lastError: null,
  };

  const plugins: SuccinixPluginSummary[] = [
    { name: 'succinix', fibers: [{ state: 'ACTIVE' }] },
    { name: 'succinix-app-broken', fibers: [{ state: 'FAILED' }] },
  ];

  it('formatSuccinixStatus covers every required state field in ASCII English', () => {
    const lines = formatSuccinixStatus(state, 'ACTIVE');
    const text = lines.join('\n');
    expect(text).toContain('Succinix plugin status');
    expect(text).toContain('0.7.0');
    expect(text).toContain('ACTIVE');
    expect(text).toContain('internal');
    expect(text).toMatch(/READY/);
    expect(text).toContain('42');
    expect(text).toMatch(/default:.*ACTIVE/);
    expect(text).toContain('terminal.exec, fs.read');
    expect(text).toContain('configRevision');
    expect(text).toContain('(none)');
    expect(text).not.toMatch(/✅|❌|🎉|…/);
  });

  it('formatSuccinixPlugins lists runtimes and every fiber state', () => {
    const lines = formatSuccinixPlugins(plugins);
    expect(lines[0]).toBe('Plugins (2)');
    expect(lines.join('\n')).toContain('succinix');
    expect(lines.join('\n')).toContain('ACTIVE');
    expect(lines.join('\n')).toContain('succinix-app-broken');
    expect(lines.join('\n')).toContain('FAILED');
    expect(lines.join('\n')).not.toMatch(/✅|❌|🎉|…/);
  });

});
