// D3：实例级 restart 语义 —— 停掉该实例仍运行的进程（host 侧 reset-instance 按归属 kill）、
// 清端口期望与活动端口记录、清 host 侧实例缓存（会话 cwd / currentRun）、清快照与状态根、
// 重建会话并重跑应用级 bootsteps（宿主注入）。单测覆盖浏览器侧编排 + host 侧归属/缓存清理
// 的纯逻辑（host.ts 的 dispatch 实现在容器内，经协议命令由本测试的假 client 驱动断言）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TerminalClient } from '../src/engine/client.js';
import { createSuccinixInstance, type SuccinixRestartContext } from '../src/instance/index.js';
import { instancePorts } from '../src/instance/ports.js';
import { instanceStateRoot } from '../src/instance/paths.js';
import { dbActivePortFor, setDbActivePort } from '../src/services.js';
import { processesOwnedByInstance, CurrentRunRegistry } from '../src/engine/host-route.js';
import type { WebContainer } from '@webcontainer/api';
import type { TerminalOutput } from '../src/terminal/index.js';

// 假持久化（同 instance-m5.test.ts）：断言 restart 清快照。
const persistMock = vi.hoisted(() => {
  const ctx = {
    save: vi.fn(async () => ({ meta: { version: 1 as const, savedAt: 1, fileCount: 0, totalBytes: 0 }, skipped: false, reason: 'force' as const })),
    load: vi.fn(async () => null),
    clear: vi.fn(async () => {}),
    meta: vi.fn(async () => null),
    force: vi.fn(async () => {}),
  };
  return {
    ctx,
    createPersist: vi.fn(() => ctx),
    getPersist: vi.fn(() => ctx),
    instancePersistKey: vi.fn((id: string) => (id === 'default' ? 'current' : `instance:${id}`)),
    saveSnapshot: vi.fn(async () => ({ meta: { version: 1 as const, savedAt: 1, fileCount: 0, totalBytes: 0 }, skipped: false, reason: 'dedup' as const })),
    loadSnapshot: vi.fn(async () => null),
    clearSnapshot: vi.fn(async () => {}),
    getSnapshotMeta: vi.fn(async () => null),
    forcePersist: vi.fn(async () => {}),
    AUTO_SNAPSHOT_FORCE_INTERVAL_MS: 30000,
    isAgeForced: vi.fn(() => false),
  };
});

vi.mock('../src/persist.js', () => persistMock);

interface CmdReq {
  protocol?: number;
  id: number;
  cmd: string;
  opts?: Record<string, unknown>;
  instanceId?: string;
}

function makeRpcFs(opts: { respond?: (req: CmdReq) => unknown }) {
  const files = new Map<string, string>();
  const cmdWrites: CmdReq[] = [];
  const rmCalls: string[] = [];
  const fs = {
    writeFile: async (path: string, content: string) => {
      if (path === '/cmd.json') {
        const req = JSON.parse(content) as CmdReq;
        cmdWrites.push(req);
        const payload = opts.respond?.(req);
        if (payload !== undefined) files.set(`/result-${req.id}.json`, JSON.stringify({ id: req.id, ...(payload as object) }));
        return;
      }
      files.set(path, content);
    },
    readFile: async (path: string) => {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    rm: async (path: string) => {
      files.delete(path);
      rmCalls.push(path);
    },
    mkdir: async () => {},
    readdir: async () => [],
  };
  return { fs, files, cmdWrites, rmCalls };
}

function makeWc(respond?: (req: CmdReq) => unknown) {
  const rpc = makeRpcFs({ respond });
  const wc = {
    fs: rpc.fs,
    spawn: vi.fn(async () => ({ kill: vi.fn(async () => {}), exit: Promise.resolve(0), output: {} })),
    on: vi.fn(),
  } as unknown as WebContainer;
  return { wc, ...rpc };
}

const PONG = () => ({ ok: true, kind: 'pong' });
const RESET = () => ({ ok: true, kind: 'reset-instance', killed: [42, 43] });
const RUN_OK = () => ({ ok: true, stdout: 'hi', runtime: 'lifo', exitCode: 0 });

beforeEach(() => {
  instancePorts.clear();
  persistMock.getPersist.mockClear();
  persistMock.createPersist.mockClear();
  persistMock.ctx.clear.mockClear();
});

describe('D3 实例级 restart', () => {
  it('restart 全流程：停进程 → 清端口期望/活动端口/快照/状态根 → 重建会话 → 重跑应用级 bootsteps', async () => {
    const written: string[] = [];
    const output: TerminalOutput = {
      write: (d) => void written.push(d),
      clear: () => {},
    };
    const { wc, cmdWrites, rmCalls } = makeWc((req) => (req.cmd === 'ping' ? PONG() : req.cmd === 'reset-instance' ? RESET() : RUN_OK()));
    const hostClient = new TerminalClient({ fs: (wc as unknown as { fs: unknown }).fs } as never, { instanceId: 'c-1' });

    const restartState: { ctx: SuccinixRestartContext | null } = { ctx: null };
    const onRestart = vi.fn(async (ctx: SuccinixRestartContext) => {
      restartState.ctx = ctx;
    });
    const inst = await createSuccinixInstance({ wc, instanceId: 'c-1', rpc: hostClient, output, onRestart });

    // 造出"旧实例在跑"的状态：期望端口、db 活动端口、旧会话。
    instancePorts.expect('c-1', 8080);
    setDbActivePort('c-1', 8080);
    const oldSession = inst.terminal;

    await inst.restart();

    // 1. host 侧收口：reset-instance 已发出（host kill 旧进程 + 清 sessionCwd/currentRun 缓存）。
    expect(cmdWrites.some((r) => r.cmd === 'reset-instance' && r.instanceId === 'c-1')).toBe(true);
    // 2. 端口期望与活动端口记录已清（旧进程 URL/记录不残留）。
    expect(instancePorts.expectedFor('c-1')).toEqual([]);
    expect(dbActivePortFor('c-1')).toBeNull();
    expect(inst.ports.size).toBe(0);
    // 3. 快照与状态根已清。
    expect(persistMock.ctx.clear).toHaveBeenCalled();
    expect(rmCalls).toContain(instanceStateRoot('c-1'));
    // 4. 会话已重建（新会话对象 ≠ 旧会话）。
    expect(inst.terminal).not.toBe(oldSession);
    // 5. 应用级 bootsteps 钩子已跑，拿到新会话 + 引擎级产物。
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(restartState.ctx?.terminal).toBe(inst.terminal);
    expect(restartState.ctx?.wc).toBe(wc);
    expect(restartState.ctx?.client).toBe(hostClient);
    // 新会话已 boot（输出提示符）。
    expect(written.some((d) => d.includes('$'))).toBe(true);
  });

  it('host 侧归属收集：只收集本实例非 system 进程；默认实例不批量 kill', () => {
    const procs = [
      { pid: 1, scope: 'system' as const },
      { pid: 2, scope: 'container' as const, containerId: 'c-1' },
      { pid: 3, scope: 'container' as const, containerId: '.succinix-c-1' },
      { pid: 4, scope: 'container' as const, containerId: 'c-2' },
      { pid: 5, scope: 'unknown' as const },
    ];
    expect(processesOwnedByInstance(procs, 'c-1').map((p) => p.pid)).toEqual([2, 3]);
    expect(processesOwnedByInstance(procs, 'default')).toEqual([]);
  });

  it('host 侧缓存清理：CurrentRunRegistry.clear 移除该实例的 interrupt 目标', () => {
    const reg = new CurrentRunRegistry();
    reg.register('c-1', 100);
    reg.register('c-2', 200);
    reg.clear('c-1');
    expect(reg.get('c-1')).toBeNull();
    expect(reg.get('c-2')).toBe(200);
  });
});
