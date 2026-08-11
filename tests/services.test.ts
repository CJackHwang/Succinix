// src/services.ts 单元测试：解析 / 端口渲染 / needle 匹配 / 生命周期（mock FS + fake client + fake IDB）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeFS, installFakeIDB, FakeClient } from './helpers/fakes.js';
import type { FileSystemAPI } from '@webcontainer/api';
import type { TerminalClient } from '../src/engine/index.js';
import {
  DEFAULT_SERVICES_TEXT,
  ensureServicesFiles,
  parseServices,
  readServices,
  writeServicesText,
  addServiceDef,
  removeServiceDef,
  readAutostart,
  enableAutostart,
  disableAutostart,
  resolvePreviewPort,
  renderCommand,
  getServiceState,
  listServiceStates,
  startService,
  stopService,
  type ServiceContext,
} from '../src/services/index.js';
import { instancePorts } from '../src/instance/ports.js';
import { clearSnapshot } from '../src/persist.js';

const fs = () => new FakeFS() as unknown as FileSystemAPI;

function makeCtx(fake: FakeClient, f: FileSystemAPI, ports?: Map<number, string>): ServiceContext {
  return {
    wc: { fs: f as unknown as FileSystemAPI } as unknown as ServiceContext['wc'],
    client: fake as unknown as TerminalClient,
    ports: ports ?? new Map(),
  };
}

beforeEach(async () => {
  vi.stubGlobal('indexedDB', installFakeIDB().indexedDB);
  await clearSnapshot();
  return () => vi.unstubAllGlobals();
});

describe('services parse', () => {
  it('parseServices skips blank lines and # comments', () => {
    const defs = parseServices('# header\n\ntinbase|npx tinbase start --port 3001 --engine wasm|3001\n\n');
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({ name: 'tinbase', command: 'npx tinbase start --port 3001 --engine wasm', port: 3001 });
  });

  it('parseServices treats missing/invalid port as null', () => {
    const defs = parseServices('a|echo hi|\nb|echo hi|abc\nc|echo hi|0\nd|echo hi|99999\n');
    expect(defs.every((d) => d.port === null)).toBe(true);
  });

  it('parseServices drops lines missing name or command', () => {
    const defs = parseServices('onlyname\n|echo hi|3001\n');
    expect(defs).toHaveLength(0);
  });

  it('parseServices keeps the last definition on duplicate names', () => {
    const defs = parseServices('srv|echo one|3001\nsrv|echo two|3002\n');
    expect(defs).toHaveLength(1);
    expect(defs[0].command).toBe('echo two');
    expect(defs[0].port).toBe(3002);
  });

  it('readServices falls back to defaults when the file is missing', async () => {
    expect(await readServices(fs())).toEqual(parseServices(DEFAULT_SERVICES_TEXT));
  });

  it('writeServicesText then readServices roundtrips', async () => {
    const f = fs();
    await writeServicesText(f, 'a|echo hi|3001\n');
    const defs = await readServices(f);
    expect(defs[0]).toEqual({ name: 'a', command: 'echo hi', port: 3001 });
  });

  it('ensureServicesFiles writes defaults when missing', async () => {
    const f = fs();
    await ensureServicesFiles(f);
    const defs = await readServices(f);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('addServiceDef appends and removeServiceDef removes by name', async () => {
    const f = fs();
    await addServiceDef(f, 'probe', 'node server.js', 3456);
    let defs = await readServices(f);
    expect(defs.some((d) => d.name === 'probe' && d.port === 3456)).toBe(true);

    expect(await removeServiceDef(f, 'probe')).toBe(true);
    defs = await readServices(f);
    expect(defs.some((d) => d.name === 'probe')).toBe(false);
    expect(await removeServiceDef(f, 'probe')).toBe(false);
  });
});

describe('services autostart', () => {
  it('readAutostart returns empty for missing file and dedups lines', async () => {
    const f = fs();
    expect(await readAutostart(f)).toEqual([]);
    await writeServicesText(f, '');
    // 直接写自启文件（用 enableAutostart 会触发 forcePersist，分开测）
    const raw = f as unknown as FakeFS;
    await raw.writeFile('/etc/succinix.autostart', 'tinbase\ntinbase\nother\n');
    expect(await readAutostart(f)).toEqual(['tinbase', 'other']);
  });

  it('enableAutostart adds once and returns whether it was new', async () => {
    const f = fs();
    expect(await enableAutostart(f, 'tinbase')).toBe(true);
    expect(await enableAutostart(f, 'tinbase')).toBe(false);
    expect(await readAutostart(f)).toEqual(['tinbase']);
  });

  it('disableAutostart removes and reports whether it existed', async () => {
    const f = fs();
    await enableAutostart(f, 'tinbase');
    expect(await disableAutostart(f, 'tinbase')).toBe(true);
    expect(await readAutostart(f)).toEqual([]);
    expect(await disableAutostart(f, 'tinbase')).toBe(false);
  });
});

describe('services port rendering', () => {
  it('resolvePreviewPort defaults to 3001', async () => {
    expect(await resolvePreviewPort(fs())).toBe(3001);
  });

  it('resolvePreviewPort reads a custom preview-port setting', async () => {
    const f = fs();
    await writeServicesText(f, ''); // ensure /etc dir exists? no—use settings
    const raw = f as unknown as FakeFS;
    await raw.writeFile('/etc/succinix.settings', 'preview-port=4100\n');
    expect(await resolvePreviewPort(f)).toBe(4100);
  });

  it('renderCommand substitutes ${PORT} with the effective preview port', async () => {
    const f = fs();
    const def = parseServices('tinbase|npx tinbase start --port ${PORT} --engine wasm|3001')[0];
    expect(await renderCommand(f, def)).toBe('npx tinbase start --port 3001 --engine wasm');
  });

  it('renderCommand leaves commands without ${PORT} untouched', async () => {
    const f = fs();
    const def = parseServices('svc|node server.js|3456')[0];
    expect(await renderCommand(f, def)).toBe('node server.js');
  });
});

describe('services state (needle matching)', () => {
  it('reports running when a process matches and the port registry is ready', async () => {
    const fake = new FakeClient({
      terminal: () => ({
        ok: true,
        processes: [{ pid: 7, cmd: 'npx tinbase start --port 3001 --engine wasm', status: 'running' }],
      }),
    });
    const f = fs();
    const ctx = makeCtx(fake, f, new Map([[3001, 'https://x.preview']]));
    const defs = await readServices(f);
    const state = await getServiceState(ctx, defs[0]);
    expect(state.state).toBe('running');
    expect(state.pid).toBe(7);
    expect(state.url).toBe('https://x.preview');
  });

  it('reports stopped when the process matches but the port is not ready', async () => {
    const fake = new FakeClient({
      terminal: () => ({
        ok: true,
        processes: [{ pid: 7, cmd: 'npx tinbase start --port 3001 --engine wasm', status: 'running' }],
      }),
    });
    const f = fs();
    const ctx = makeCtx(fake, f); // ports 空 → 端口未就绪
    const defs = await readServices(f);
    const state = await getServiceState(ctx, defs[0]);
    expect(state.state).toBe('stopped');
  });

  it('reports stopped when no process matches', async () => {
    const fake = new FakeClient({
      terminal: () => ({ ok: true, processes: [] }),
    });
    const f = fs();
    const ctx = makeCtx(fake, f, new Map([[3001, 'https://x.preview']]));
    const defs = await readServices(f);
    const state = await getServiceState(ctx, defs[0]);
    expect(state.state).toBe('stopped');
  });

  it('reports stopped when the process table is unreachable', async () => {
    const fake = new FakeClient({
      terminal: () => {
        throw new Error('rpc down');
      },
    });
    const f = fs();
    const ctx = makeCtx(fake, f);
    const defs = await readServices(f);
    const state = await getServiceState(ctx, defs[0]);
    expect(state.state).toBe('stopped');
  });

  it('listServiceStates maps all definitions to states', async () => {
    const fake = new FakeClient({
      terminal: () => ({ ok: true, processes: [] }),
    });
    const f = fs();
    await addServiceDef(f, 'extra', 'node x.js', null);
    const states = await listServiceStates(makeCtx(fake, f));
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states.every((s) => s.state === 'stopped')).toBe(true);
  });
});

describe('services start/stop lifecycle', () => {
  it('startService installs a missing npx package then spawns and waits for the port', async () => {
    const f = fs();
    const fake = new FakeClient();
    fake.whenTerminal('ps', { ok: true, processes: [] });
    // ensureNpxPackage 的探测命令带单引号（`test -d '/workspace/node_modules/<pkg>'`）。
    fake.whenTerminal("test -d '/workspace/node_modules/tinbase'", { ok: false, exitCode: 1 });
    fake.whenTerminal('npm install tinbase --no-audit --no-fund', { ok: true, stdout: 'added' });
    fake.spawnHandler = () => ({ ok: true, pid: 42, runtime: 'node' });

    const ctx = makeCtx(fake, f, new Map([[3001, 'https://x.preview']]));
    const res = await startService(ctx, 'tinbase');
    expect(res.ok).toBe(true);
    expect(res.pid).toBe(42);
    // 确认触发了一次 npm install（缺包探测绝对路径）
    expect(fake.terminalCalls.some((c) => c.command === 'npm install tinbase --no-audit --no-fund')).toBe(true);
  });

  it('startService skips npm install when the package probe succeeds', async () => {
    const f = fs();
    const fake = new FakeClient();
    fake.whenTerminal('ps', { ok: true, processes: [] });
    fake.whenTerminal("test -d '/workspace/node_modules/tinbase'", { ok: true });
    fake.spawnHandler = () => ({ ok: true, pid: 43, runtime: 'node' });

    const ctx = makeCtx(fake, f, new Map([[3001, 'https://x.preview']]));
    const res = await startService(ctx, 'tinbase');
    expect(res.ok).toBe(true);
    expect(fake.terminalCalls.some((c) => c.command.startsWith('npm install'))).toBe(false);
  });

  it('startService reports unknown service', async () => {
    const f = fs();
    const fake = new FakeClient();
    const res = await startService(makeCtx(fake, f), 'nope');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('unknown service');
  });

  it('startService is idempotent when the process is already running', async () => {
    const f = fs();
    const fake = new FakeClient({
      terminal: () => ({
        ok: true,
        processes: [{ pid: 7, cmd: 'npx tinbase start --port 3001 --engine wasm', status: 'running' }],
      }),
    });
    const ctx = makeCtx(fake, f);
    const res = await startService(ctx, 'tinbase');
    expect(res.ok).toBe(true);
    expect(res.pid).toBe(7);
    expect(fake.spawnCalls).toHaveLength(0);
  });

  it('startService fails when spawn returns failure', async () => {
    const f = fs();
    const fake = new FakeClient();
    fake.whenTerminal('ps', { ok: true, processes: [] });
    fake.spawnHandler = () => ({ ok: false, error: 'spawn exploded' });
    const res = await startService(makeCtx(fake, f, new Map([[3001, 'x']])), 'tinbase');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('failed to start');
  });

  it('startService registers the instance port expectation before spawn and releases it on spawn failure', async () => {
    const f = fs();
    const fake = new FakeClient();
    fake.whenTerminal('ps', { ok: true, processes: [] });
    let sawExpectationAtSpawn = false;
    fake.spawnHandler = () => {
      // 期望登记必须先于 spawn：server-ready 事件到达时按期望归属实例视图，
      // 快速绑定的服务若先 spawn 后 expect，端口会永远进不了实例视图。
      sawExpectationAtSpawn = instancePorts.expects('c-2', 3001);
      return { ok: false, error: 'spawn exploded' };
    };
    const ctx = { ...makeCtx(fake, f, new Map([[3001, 'https://c-2.preview']])), instanceId: 'c-2' };
    const res = await startService(ctx, 'tinbase');
    expect(res.ok).toBe(false);
    expect(sawExpectationAtSpawn).toBe(true);
    // spawn 失败必须释放期望，避免残留期望让后续无关端口误归本实例。
    expect(instancePorts.expectedFor('c-2')).toEqual([]);
  });

  it('startService on a non-default instance sees a port that becomes ready after spawn', async () => {
    const f = fs();
    const ports = new Map<number, string>();
    let spawned = false;
    const fake = new FakeClient({
      terminal: (cmd) => {
        if (cmd === 'ps') {
          // 进程表在 spawn 后返回该实例的 running 服务进程（端口就绪前的存活判定）。
          return spawned
            ? {
                ok: true,
                processes: [
                  { pid: 42, cmd: 'npx tinbase start --port 3001 --engine wasm', status: 'running', containerId: '.succinix-c-2' },
                ],
              }
            : { ok: true, processes: [] };
        }
        return { ok: true };
      },
    });
    fake.spawnHandler = () => {
      spawned = true;
      // 端口在 spawn 之后才就绪（server-ready 晚于 spawn 返回的真实时序）。
      setTimeout(() => ports.set(3001, 'https://c-2.preview'), 600);
      return { ok: true, pid: 42, runtime: 'node' };
    };
    instancePorts.clear();
    const ctx = { ...makeCtx(fake, f, ports), instanceId: 'c-2' };
    const res = await startService(ctx, 'tinbase');
    expect(res.ok).toBe(true);
    expect(res.pid).toBe(42);
    // 成功路径下期望保留（服务停止 / 端口关闭时才释放）。
    expect(instancePorts.expectedFor('c-2')).toContain(3001);
  });

  it('stopService kills the matched process and reports success', async () => {
    const f = fs();
    // 状态机：kill 后 ps 不再返回该 running 进程（否则 stopService 的退出等待会轮询到超时）。
    let killed = false;
    const fake = new FakeClient({
      terminal: (cmd) => {
        if (cmd === 'kill 7') {
          killed = true;
          return { ok: true, killed: true };
        }
        if (cmd === 'ps') {
          return killed
            ? { ok: true, processes: [] }
            : { ok: true, processes: [{ pid: 7, cmd: 'npx tinbase start --port 3001 --engine wasm', status: 'running' }] };
        }
        return { ok: true, stdout: '' };
      },
    });
    const ctx = makeCtx(fake, f);
    const res = await stopService(ctx, 'tinbase');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('stopped');
  });

  it('stopService reports unknown service and not-running service', async () => {
    const f = fs();
    const fake = new FakeClient({ terminal: () => ({ ok: true, processes: [] }) });
    const unknown = await stopService(makeCtx(fake, f), 'nope');
    expect(unknown.ok).toBe(false);
    const notRunning = await stopService(makeCtx(fake, f), 'tinbase');
    expect(notRunning.ok).toBe(false);
    expect(notRunning.message).toContain('not running');
  });

  it('stopService reports failure when kill did not confirm', async () => {
    const f = fs();
    const fake = new FakeClient({
      terminal: (cmd) =>
        cmd === 'kill 7'
          ? { ok: true, killed: false, message: 'no such process' }
          : { ok: true, processes: [{ pid: 7, cmd: 'npx tinbase start --port 3001 --engine wasm', status: 'running' }] },
    });
    const res = await stopService(makeCtx(fake, f), 'tinbase');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('failed to stop');
  });

  it('stopService degrades gracefully when the RPC throws', async () => {
    const f = fs();
    const fake = new FakeClient({
      terminal: (cmd) => {
        if (cmd === 'kill 7') throw new Error('rpc down');
        return { ok: true, processes: [{ pid: 7, cmd: 'npx tinbase start --port 3001 --engine wasm', status: 'running' }] };
      },
    });
    const res = await stopService(makeCtx(fake, f), 'tinbase');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('failed to stop');
  });
});
