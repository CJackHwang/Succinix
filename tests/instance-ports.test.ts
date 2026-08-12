// D2：同页端口事件分发 —— server-ready / port(close) 经页面级 registry（pagePorts）登记，
// 按实例期望归属分发到实例视图；无法归属的端口只留在页面级。覆盖 rpc 共享路径（页面宿主
// 已 boot host，工厂只订阅）与自建 host 路径（bootEngineHost 内部 bind + 订阅）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bootEngineHost, pagePorts } from '../src/engine/index.js';
import { TerminalClient } from '../src/engine/client.js';
import { createSuccinixInstance } from '../src/instance/index.js';
import { instancePorts } from '../src/instance/ports.js';
import { DEFAULT_INSTANCE_ID } from '../src/instance/paths.js';
import type { WebContainer } from '@webcontainer/api';
import type { TerminalOutput } from '../src/terminal/index.js';

// 假持久化（同 instance-m5.test.ts）：聚焦端口分发组装逻辑。
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
  const fs = {
    writeFile: async (path: string, content: string) => {
      if (path === '/cmd.json') {
        const req = JSON.parse(content) as CmdReq;
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
    },
    mkdir: async () => {},
    readdir: async () => [],
  };
  return { fs, files };
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
const RUN_OK = () => ({ ok: true, stdout: 'hi', runtime: 'lifo', exitCode: 0 });
const silentOutput: TerminalOutput = { write: () => {}, clear: () => {} };

// 从假 wc 取出已注册的 wc.on 处理器（bootEngineHost/pagePorts.bind 注册）。
function eventHandlers(wc: WebContainer): { serverReady: (port: number, url: string) => void; portClose: (port: number) => void } {
  const on = (wc as unknown as { on: ReturnType<typeof vi.fn> }).on;
  const ready = on.mock.calls.find(([ev]) => ev === 'server-ready')?.[1] as (port: number, url: string) => void;
  const port = on.mock.calls.find(([ev]) => ev === 'port')?.[1] as (port: number, type: string) => void;
  return {
    serverReady: ready,
    portClose: (portNumber) => port(portNumber, 'close'),
  };
}

beforeEach(() => {
  pagePorts.reset();
  instancePorts.clear();
  persistMock.getPersist.mockClear();
  persistMock.createPersist.mockClear();
});

describe('D2 同页端口事件分发', () => {
  it('rpc 共享路径：default instance sees every page-level ready port', async () => {
    const { wc } = makeWc((req) => (req.cmd === 'ping' ? PONG() : RUN_OK()));
    const hostClient = new TerminalClient({ fs: (wc as unknown as { fs: unknown }).fs } as never);
    await bootEngineHost(wc, hostClient, { hostSrc: '// host.js' });
    const { serverReady } = eventHandlers(wc);

    const inst = await createSuccinixInstance({
      wc,
      instanceId: DEFAULT_INSTANCE_ID,
      rpc: hostClient,
      output: silentOutput,
    });

    serverReady(4321, 'https://4321-preview');
    expect(inst.ports.get(4321)).toBe('https://4321-preview');
    expect(pagePorts.readyPorts().get(4321)).toBe('https://4321-preview');
  });

  it('rpc 共享路径：server-ready 按实例期望归属，无法归属的端口只进页面级 registry', async () => {
    const { wc } = makeWc((req) => (req.cmd === 'ping' ? PONG() : RUN_OK()));
    const hostClient = new TerminalClient({ fs: (wc as unknown as { fs: unknown }).fs } as never);
    // 页面宿主先 boot 引擎（bind wc 事件；单 host 不变量）；宿主自身带端口回调。
    const hostReady = vi.fn();
    const hostClosed = vi.fn();
    await bootEngineHost(wc, hostClient, { hostSrc: '// host.js', onServerReady: hostReady, onServerClosed: hostClosed });
    const { serverReady, portClose } = eventHandlers(wc);

    const inst = await createSuccinixInstance({ wc, instanceId: 'c-1', rpc: hostClient, output: silentOutput });

    // 本实例期望 8080：事件归属到实例视图（宿主回调也收到）。
    instancePorts.expect('c-1', 8080);
    serverReady(8080, 'https://8080-preview');
    expect(inst.ports.get(8080)).toBe('https://8080-preview');
    expect(hostReady).toHaveBeenCalledWith(8080, 'https://8080-preview');
    expect(pagePorts.readyPorts().get(8080)).toBe('https://8080-preview');

    // 无归属端口 9999：不进实例视图，但页面级 registry 有（宿主回调如实收到）。
    serverReady(9999, 'https://9999-preview');
    expect(inst.ports.has(9999)).toBe(false);
    expect(pagePorts.readyPorts().get(9999)).toBe('https://9999-preview');
    expect(hostReady).toHaveBeenCalledWith(9999, 'https://9999-preview');

    // port close：从实例视图与页面级 registry 移除。
    portClose(8080);
    expect(inst.ports.has(8080)).toBe(false);
    expect(pagePorts.readyPorts().has(8080)).toBe(false);
    expect(hostClosed).toHaveBeenCalledWith(8080);
  });

  it('自建 host 路径：同页第二个实例经页面级分发收到 server-ready（不再只有首个监听器）', async () => {
    const { wc } = makeWc((req) => (req.cmd === 'ping' ? PONG() : RUN_OK()));
    const inst = await createSuccinixInstance({
      wc,
      instanceId: 'c-2',
      output: silentOutput,
      executor: { hostSrc: 'x', lifoCoreSrc: '' },
    });
    const { serverReady } = eventHandlers(wc);

    instancePorts.expect('c-2', 8080);
    serverReady(8080, 'https://8080-preview');
    expect(inst.ports.get(8080)).toBe('https://8080-preview');

    // 其他实例（c-9）的端口不进本实例视图。
    serverReady(9000, 'https://9000-preview');
    expect(inst.ports.has(9000)).toBe(false);
  });

  it('dispose 退订：实例释放后不再收到端口事件（共享 host 不受影响）', async () => {
    const { wc } = makeWc((req) => (req.cmd === 'ping' ? PONG() : RUN_OK()));
    const hostClient = new TerminalClient({ fs: (wc as unknown as { fs: unknown }).fs } as never);
    await bootEngineHost(wc, hostClient, { hostSrc: '// host.js' });
    const { serverReady } = eventHandlers(wc);

    const inst = await createSuccinixInstance({ wc, instanceId: 'c-3', rpc: hostClient, output: silentOutput });
    instancePorts.expect('c-3', 8080);
    serverReady(8080, 'https://8080-preview');
    expect(inst.ports.get(8080)).toBe('https://8080-preview');

    await inst.dispose();
    serverReady(8080, 'https://8080-new');
    expect(inst.ports.get(8080)).toBe('https://8080-preview'); // 已退订：不再更新
  });
});
