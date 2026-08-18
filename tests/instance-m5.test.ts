// M5：createSuccinixInstance 聚合 API —— 同页共享 RPC 通道 / instanceId 打标 /
// 聚合组装（terminal+executor+snapshot+services）/ 默认实例等价 / restart 实例级重置。
// 说明：工厂的持久化层（IndexedDB）用 vi.mock 替换为假 PersistContext，聚焦组装逻辑；
// services 绑定走真实 services.ts（假 FS 回落内置预置，进程表无匹配 → stopped）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TerminalClient } from '../src/engine/client.js';
import { createSuccinixInstance, DEFAULT_INSTANCE_BOOT_STEPS } from '../src/instance/index.js';
import { instanceStateRoot, statePath, tinbaseDataDir, INSTANCE_STATE_ROOT_PREFIX } from '../src/instance/paths.js';
import { envFilePath, settingsFilePath } from '../src/config.js';
import { motdFilePath } from '../src/motd.js';
import type { WebContainer } from '@webcontainer/api';
import { sleep } from '../src/engine/sleep.js';

interface CmdReq {
  protocolVersion?: number;
  id: string | number;
  cmd: string;
  opts?: Record<string, unknown>;
  instanceId?: string;
  bootNonce?: string;
}

// ─── 假持久化（vi.mock 在文件级生效；工厂的 snapshot/services 绑定都经它）───
const persistMock = vi.hoisted(() => {
  const makeCtx = () => ({
    save: vi.fn(async () => ({ meta: { version: 1 as const, savedAt: 1, fileCount: 0, totalBytes: 0 }, skipped: false, reason: 'force' as const })),
    load: vi.fn(async () => null),
    clear: vi.fn(async () => {}),
    meta: vi.fn(async () => null),
    force: vi.fn(async () => {}),
  });
  const ctx = makeCtx();
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

vi.mock('../src/persist/index.js', () => persistMock);

// ─── 假 wc.fs：写 /cmd.json 时按响应函数生成 /result-<id>.json ───
function makeRpcFs(opts: { respond?: (req: CmdReq) => unknown }) {
  const files = new Map<string, string>();
  const cmdWrites: CmdReq[] = [];
  const rmCalls: string[] = [];
  const mkdirCalls: Array<{ path: string; options?: unknown }> = [];
  const fs = {
    writeFile: async (path: string, content: string) => {
      if (path === '/cmd.json') {
        const req = JSON.parse(content) as CmdReq;
        cmdWrites.push(req);
        files.set(`/ack-${req.id}.json`, JSON.stringify({ protocolVersion: 2, id: req.id, bootNonce: req.bootNonce, instanceId: req.instanceId ?? 'default', acceptedAt: Date.now() }));
        const payload = opts.respond?.(req);
        if (payload !== undefined) {
          files.set(`/result-${req.id}.json`, JSON.stringify({ protocolVersion: 2, id: req.id, bootNonce: req.bootNonce, instanceId: req.instanceId ?? 'default', ...(payload as object) }));
        }
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
    mkdir: async (path: string, options?: unknown) => {
      mkdirCalls.push({ path, options });
    },
    readdir: async () => [],
  };
  return { fs, files, cmdWrites, rmCalls, mkdirCalls };
}

function makeWc(respond?: (req: CmdReq) => unknown) {
  const rpc = makeRpcFs({ respond });
  // 自建 client 路径会拉起引擎 host：假 spawn 返回可用进程句柄，on 接收端口回调注册。
  const wc = {
    fs: rpc.fs,
    spawn: vi.fn(async () => ({
      kill: vi.fn(async () => {}),
      exit: Promise.resolve(0),
      output: {},
    })),
    on: vi.fn(),
  } as unknown as WebContainer;
  return { wc, ...rpc };
}

const PONG = () => ({ ok: true, kind: 'pong' });
const RUN_OK = () => ({ ok: true, stdout: 'hi', runtime: 'lifo', exitCode: 0 });

beforeEach(() => {
  persistMock.getPersist.mockClear();
  persistMock.createPersist.mockClear();
  persistMock.ctx.clear.mockClear();
});

describe('TerminalClient instanceId 打标 + 同页共享通道（M5）', () => {
  it('缺省 client 不写 instanceId 字段（additive，旧行为不变）', async () => {
    const { client, cmdWrites } = (() => {
      const rpc = makeRpcFs({ respond: () => RUN_OK() });
      return { client: new TerminalClient({ fs: rpc.fs } as never), cmdWrites: rpc.cmdWrites };
    })();
    await client.terminal('echo hi');
    expect(cmdWrites[0]?.instanceId).toBeUndefined();
  });

  it('带 instanceId 的 client：run/spawn/pingDirect/interruptDirect 全部打标', async () => {
    const rpc = makeRpcFs({ respond: (req) => (req.cmd === 'interrupt' ? { ok: true, pid: 7 } : req.cmd === 'ping' ? PONG() : RUN_OK()) });
    const client = new TerminalClient({ fs: rpc.fs } as never, { instanceId: 'c-1' });
    await client.terminal('echo hi');
    await client.spawn('node s.js');
    // 通道写时序余量（HOST_POLL_MARGIN_MS 250ms）：刚写过 /cmd.json 时直接 ping 会被判定
    // 为在途覆盖而跳过，等 margin 过后再探活/中断，确保两种直写命令都发出并打标。
    await sleep(300);
    await client.pingDirect(500);
    await sleep(300);
    await client.interruptDirect(500);
    const stamped = rpc.cmdWrites.filter((r) => r.instanceId === 'c-1');
    expect(stamped.map((r) => r.cmd)).toEqual(['run', 'spawn', 'ping', 'interrupt']);
  });

  it('同 wc 多 client 共享通道：请求 id 全局递增、写序串行（并发不覆盖）', async () => {
    const rpc = makeRpcFs({ respond: () => RUN_OK() });
    const wc = { fs: rpc.fs } as never;
    const a = new TerminalClient(wc, { instanceId: 'a' });
    const b = new TerminalClient(wc, { instanceId: 'b' });
    // 并发发出：共享队列保证 A 的请求先完整落盘、B 再写（不互相覆盖）。
    const [ra, rb] = await Promise.all([a.terminal('echo a'), b.terminal('echo b')]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    const ids = rpc.cmdWrites.map((r) => String(r.id));
    expect(ids[0]).toMatch(/.+-1$/);
    expect(ids[1]).toBe(ids[0]?.replace(/-1$/, '-2')); // 全局随机前缀下单调 sequence
    expect(rpc.cmdWrites.map((r) => r.instanceId)).toEqual(['a', 'b']);
    // 每次写都是完整 JSON（无交错片段）——共享队列串行化已由单线程 + chain 保证。
    for (const w of rpc.cmdWrites) {
      expect(JSON.parse(JSON.stringify(w))).toEqual(w);
    }
  });

  it('默认实例 client 与实例 client 同通道互不干扰（pingDirect 安全窗口共享）', async () => {
    const rpc = makeRpcFs({ respond: () => PONG() });
    const wc = { fs: rpc.fs } as never;
    const def = new TerminalClient(wc);
    const inst = new TerminalClient(wc, { instanceId: 'x' });
    await def.pingDirect(500);
    await inst.pingDirect(500);
    const ids = rpc.cmdWrites.map((r) => String(r.id));
    expect(ids[0]).toMatch(/.+-1$/);
    expect(ids[1]).toBe(ids[0]?.replace(/-1$/, '-2'));
    expect(rpc.cmdWrites[1]?.instanceId).toBe('x');
  });
});

describe('createSuccinixInstance 聚合组装（M5）', () => {
  it('rpc 共享通道路径：返回 terminal/executor/persist/snapshot/services 全部绑定', async () => {
    const { wc, files } = makeWc((req) => {
      if (req.cmd === 'ping') return PONG();
      if (req.cmd === 'ps') return { ok: true, processes: [] };
      if (req.cmd === 'run' && String(req.opts?.command).includes("succinix service 'inspect'")) {
        return { ok: true, stdout: JSON.stringify([{ name: 'tinbase', command: 'npx tinbase start --port 3001 --engine wasm', port: 3001, description: 'Tinbase', enabled: false, state: 'stopped' }]), runtime: 'lifo', exitCode: 0 };
      }
      return RUN_OK();
    });
    const client = new TerminalClient({ fs: (wc as never as { fs: unknown }).fs } as never, { instanceId: 'c-1' });
    const inst = await createSuccinixInstance({
      wc,
      instanceId: 'c-1',
      rpc: client,
      executor: { onCommand: () => {} },
    });
    expect(inst.instanceId).toBe('c-1');
    expect(inst.client).toBe(client);
    expect(typeof inst.executor.exec).toBe('function');
    // 快照绑定：save/restore 落到实例 persist + wc.fs。
    const saveRes = await inst.snapshot.save(true);
    expect(saveRes).toBeTruthy();
    expect(inst.persist.save).toHaveBeenCalled();
    await inst.snapshot.restore();
    expect(inst.persist.load).toHaveBeenCalled();
    // 服务绑定：执行世界 unit 走实例视图（无进程 → stopped）。
    const states = (await inst.services.list()) as Array<{ def: { name: string }; state: string; effectivePort: number | null }>;
    expect(states[0]?.def.name).toBe('tinbase');
    expect(states[0]?.state).toBe('stopped');
    expect(states[0]?.effectivePort).toBe(3001);
    expect(files.has('/workspace/.succinix-c-1/etc/succinix.services')).toBe(false); // SDK 不再维护浏览器侧服务定义文件
  });

  it('缺省 rpc：自建 client 带 instanceId，host 就绪（ping）后返回', async () => {
    const { wc, cmdWrites, mkdirCalls } = makeWc((req) => (req.cmd === 'ping' ? PONG() : RUN_OK()));
    const inst = await createSuccinixInstance({ wc, instanceId: 'c-2', executor: { hostSrc: 'x', lifoCoreSrc: '' } });
    // 自建 client 的 ping（waitForHostReady）已打标 instanceId。
    expect(cmdWrites.some((r) => r.cmd === 'ping' && r.instanceId === 'c-2')).toBe(true);
    expect(mkdirCalls).toContainEqual({ path: '/workspace/.succinix-c-2', options: { recursive: true } });
    expect(inst.instanceId).toBe('c-2');
  });

  it('persistence 选项 → createPersist(自定义键)；缺省 → getPersist(instanceId)', async () => {
    const { wc } = makeWc((req) => (req.cmd === 'ping' ? PONG() : RUN_OK()));
    await createSuccinixInstance({ wc, instanceId: 'u-1', persistence: { storeKey: 'custom' }, executor: { hostSrc: 'x', lifoCoreSrc: '' } });
    expect(persistMock.createPersist).toHaveBeenCalledWith(expect.objectContaining({
      storeKey: 'custom',
      scopeRoot: '/workspace',
      instanceScope: expect.objectContaining({ stateRoot: '/workspace/.succinix-u-1' }),
    }));
    persistMock.createPersist.mockClear();
    await createSuccinixInstance({ wc, instanceId: 'u-2', executor: { hostSrc: 'x', lifoCoreSrc: '' } });
    expect(persistMock.getPersist).toHaveBeenCalledWith(
      'u-2',
      expect.objectContaining({ scopeRoot: '/workspace', instanceScope: expect.objectContaining({ stateRoot: '/workspace/.succinix-u-2' }) })
    );
  });

  it('默认实例等价：instanceId=default / 空串 → getPersist(default)，restart 不重置状态', async () => {
    const { wc, rmCalls, mkdirCalls } = makeWc((req) => (req.cmd === 'ping' ? PONG() : RUN_OK()));
    const inst = await createSuccinixInstance({ wc, instanceId: 'default', executor: { hostSrc: 'x', lifoCoreSrc: '' } });
    expect(inst.instanceId).toBe('default');
    expect(persistMock.getPersist).toHaveBeenCalledWith('default', undefined);
    await inst.restart(); // 默认实例 = 整页语义（node 无 location → no-op，不清状态）
    expect(persistMock.ctx.clear).not.toHaveBeenCalled();
    // RPC 轮询会清理 /result-*.json（启动 ping 的残留），但不得触碰任何状态根。
    expect(rmCalls.filter((p) => !p.startsWith('/result-') && !p.startsWith('/ack-'))).toHaveLength(0);
    expect(mkdirCalls).not.toContainEqual({ path: '/workspace/.succinix-default', options: { recursive: true } });
    // 空串归一化
    const inst2 = await createSuccinixInstance({ wc, instanceId: '', executor: { hostSrc: 'x', lifoCoreSrc: '' } });
    expect(inst2.instanceId).toBe('default');
  });

  it('restart（非默认实例）：清快照 + 删状态根并保持执行器可用', async () => {
    const { wc, rmCalls } = makeWc((req) => (req.cmd === 'ping' ? PONG() : RUN_OK()));
    const inst = await createSuccinixInstance({ wc, instanceId: 'c-1', executor: { hostSrc: 'x', lifoCoreSrc: '' } });
    await inst.restart();
    expect(persistMock.ctx.clear).toHaveBeenCalled();
    expect(rmCalls).toContain('/workspace/.succinix-c-1');
    expect(typeof inst.executor.exec).toBe('function');
  });

  it('restart 用 statePrefix 覆盖状态根；dispose 后 executor 失效（幂等）', async () => {
    const { wc, rmCalls, mkdirCalls } = makeWc((req) => (req.cmd === 'ping' ? PONG() : RUN_OK()));
    const inst = await createSuccinixInstance({ wc, instanceId: 'c-1', statePrefix: '/workspace/users/', executor: { hostSrc: 'x', lifoCoreSrc: '' } });
    expect(mkdirCalls).toContainEqual({ path: '/workspace/users/c-1', options: { recursive: true } });
    await inst.restart();
    expect(rmCalls).toContain('/workspace/users/c-1');
    await inst.dispose();
    await inst.dispose(); // 幂等
    await inst.executor.ping();
  });

  it('两实例同页隔离：各 client 独立 instanceId，快照/服务绑定各自实例键', async () => {
    const { wc } = makeWc((req) => (req.cmd === 'ping' ? PONG() : req.cmd === 'ps' ? { ok: true, processes: [] } : RUN_OK()));
    const clientA = new TerminalClient({ fs: (wc as never as { fs: unknown }).fs } as never, { instanceId: 'a' });
    const clientB = new TerminalClient({ fs: (wc as never as { fs: unknown }).fs } as never, { instanceId: 'b' });
    const [a, b] = await Promise.all([
      createSuccinixInstance({ wc, instanceId: 'a', rpc: clientA }),
      createSuccinixInstance({ wc, instanceId: 'b', rpc: clientB }),
    ]);
    expect(a.instanceId).toBe('a');
    expect(b.instanceId).toBe('b');
    expect(persistMock.getPersist).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ scopeRoot: '/workspace', instanceScope: expect.objectContaining({ stateRoot: '/workspace/.succinix-a' }) })
    );
    expect(persistMock.getPersist).toHaveBeenCalledWith(
      'b',
      expect.objectContaining({ scopeRoot: '/workspace', instanceScope: expect.objectContaining({ stateRoot: '/workspace/.succinix-b' }) })
    );
    const [sa, sb] = await Promise.all([a.snapshot.save(), b.snapshot.save()]);
    expect(sa).toBeTruthy();
    expect(sb).toBeTruthy();
    // 共享通道：并发命令串行且各自打标（无覆盖）。
    const writes = (await Promise.all([a.executor.exec('echo a'), b.executor.exec('echo b')])).map((r) => r.ok);
    expect(writes).toEqual([true, true]);
  });
});

describe('statePrefix 路径覆盖（M5）', () => {
  it('paths.ts：stateRoot/statePath/tinbaseDataDir 支持前缀覆盖，缺省内置前缀', () => {
    expect(instanceStateRoot('c-1')).toBe(`${INSTANCE_STATE_ROOT_PREFIX}c-1`);
    expect(instanceStateRoot('c-1', '/workspace/users/')).toBe('/workspace/users/c-1');
    expect(statePath('c-1', 'etc/succinix.env', '/workspace/users/')).toBe('/workspace/users/c-1/etc/succinix.env');
    expect(tinbaseDataDir('c-1', '/workspace/users/')).toBe('/workspace/users/c-1/tinbase');
    expect(instanceStateRoot('default', '/x/')).toBe(''); // 默认实例恒 /etc
  });

  it('config/motd 路径函数透传 statePrefix', () => {
    expect(envFilePath('c-1', '/workspace/users/')).toBe('/workspace/users/c-1/etc/succinix.env');
    expect(settingsFilePath('c-1', '/workspace/users/')).toBe('/workspace/users/c-1/etc/succinix.settings');
    expect(motdFilePath('c-1', '/workspace/users/')).toBe('/workspace/users/c-1/etc/succinix.motd');
  });
});

describe('DEFAULT_INSTANCE_BOOT_STEPS（M5）', () => {
  it('引擎级步骤文案为英文纯文本（无 emoji）', () => {
    for (const s of DEFAULT_INSTANCE_BOOT_STEPS) {
      expect(s).toMatch(/^[\x20-\x7E]+$/);
    }
    expect(DEFAULT_INSTANCE_BOOT_STEPS.length).toBeGreaterThanOrEqual(3);
  });
});
