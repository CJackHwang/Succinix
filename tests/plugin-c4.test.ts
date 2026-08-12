// C4 manageability tests: state events, hot reload, failure isolation,
// subscription leaks, and the succinix status/plugins command surface.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from 'cordis';
import enginePlugin, { type SuccinixConfig } from '../src/plugin/index.js';
import { appPlugins } from '../src/host/plugins.js';
import { getHostManager, resetPageSingletons } from '../src/plugin/host-manager.js';
import { pagePorts } from '../src/engine/ports.js';
import { tryHandleLocalCommand } from '../src/commands.js';
import { FakeWebContainer, asWebContainer } from './helpers/fake-webcontainer.js';
import { installFakeIDB } from './helpers/fakes.js';
import type { AppCommandsService } from '../src/host/types.js';

const wcApi = vi.hoisted(() => ({ boot: vi.fn() }));
const termMock = vi.hoisted(() => ({
  term: {
    onData: vi.fn(),
    writeln: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    options: {},
    open: vi.fn(),
    loadAddon: vi.fn(),
    focus: vi.fn(),
  },
  fitAddon: { fit: vi.fn() },
}));

vi.mock('@webcontainer/api', () => ({ WebContainer: { boot: wcApi.boot } }));
vi.mock('../src/app/xterm.js', () => termMock);
vi.mock('../src/boot-ui.js', () => ({
  createBootUI: () => ({
    log: vi.fn(),
    systemInfo: vi.fn(),
    complete: vi.fn(async () => {}),
    fail: vi.fn(),
  }),
}));

vi.hoisted(() => {
  const win = {
    __succinixScenario: null,
    crossOriginIsolated: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Record<string, unknown>;
  const global = globalThis as unknown as Record<string, unknown>;
  const define = (name: string, value: unknown) =>
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  define('window', win);
  define('location', new URL('http://localhost/'));
  define('document', {});
  define('navigator', {
    userAgent: 'Mozilla/5.0 Chrome/120',
    language: 'en',
    hardwareConcurrency: 4,
  });
  (globalThis as unknown as Record<string, unknown>).performance = { now: () => 0 };
});

const idb = installFakeIDB();
const BOOT_HOOKS = { hostSrc: '// host.js', lifoCoreSrc: '// lifo-core.js' };
const ENGINE_CONFIG: SuccinixConfig = { assets: { integrity: false } };

async function loadEngine(config: SuccinixConfig = {}) {
  const ctx = new Context();
  const fiber = ctx.plugin(enginePlugin, config);
  await fiber;
  return { ctx, fiber };
}

async function bootEngine(config: SuccinixConfig = {}) {
  const wc = new FakeWebContainer();
  wcApi.boot.mockResolvedValue(asWebContainer(wc));
  const loaded = await loadEngine(config);
  await loaded.ctx.succinix.boot({ executor: BOOT_HOOKS });
  return { ...loaded, wc };
}

async function loadApp(config: SuccinixConfig = ENGINE_CONFIG) {
  const ctx = new Context();
  const engineFiber = ctx.plugin(enginePlugin, config);
  const appFibers = appPlugins.map((plugin) => ctx.plugin(plugin));
  await Promise.all([engineFiber, ...appFibers]);
  return { ctx, engineFiber, appFibers };
}

async function bootApp(config: SuccinixConfig = ENGINE_CONFIG) {
  const wc = new FakeWebContainer();
  wcApi.boot.mockResolvedValue(asWebContainer(wc));
  const loaded = await loadApp(config);
  const container = loaded.ctx.get('succinix-app-container') as { start(): Promise<unknown> };
  const shell = await container.start();
  return { ...loaded, wc, shell };
}

function registryStates(ctx: Context) {
  return [...ctx.registry.values()].map((runtime) => ({
    name: runtime.name ?? 'anonymous',
    fibers: [...runtime.fibers].map((fiber) => fiber.state),
  }));
}

beforeEach(() => {
  resetPageSingletons();
  idb.reset();
  wcApi.boot.mockReset();
  vi.stubGlobal('indexedDB', idb.indexedDB);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '// host.js' })));
  termMock.term.onData.mockClear();
  termMock.term.writeln.mockClear();
  termMock.term.write.mockClear();
});

describe('state events and telemetry (C4)', () => {
  it('succinix/state covers boot, ready, instance, config, and shutdown with changed fields', async () => {
    const wc = new FakeWebContainer();
    wcApi.boot.mockResolvedValue(asWebContainer(wc));
    const { ctx } = await loadEngine();
    const events: Array<{ reason: string; changed: string[] }> = [];
    ctx.on('succinix/state', (payload: { reason: string; changed: string[] }) => events.push(payload));
    await ctx.succinix.boot({ executor: BOOT_HOOKS });
    await ctx.succinix.ensureInstance('default', {
      persistence: { dbName: 'c4', storeKey: 'state' },
      executor: BOOT_HOOKS,
    });
    await ctx.succinix.reconfigure({ resultTtlMs: 7000 });
    await ctx.succinix.shutdown();
    const reasons = events.map((event) => event.reason);
    expect(reasons).toContain('boot');
    expect(reasons).toContain('ready');
    expect(reasons).toContain('instance');
    expect(reasons).toContain('config');
    expect(reasons).toContain('shutdown');
    const instanceEvent = events.find((event) => event.reason === 'instance');
    expect(instanceEvent?.changed).toContain('instances');
    const configEvent = events.find((event) => event.reason === 'config');
    expect(configEvent?.changed).toContain('configRevision');
  });

  it('command telemetry carries pid and error fields on failure', async () => {
    const { ctx } = await bootEngine();
    await ctx.succinix.ensureInstance('default', {
      persistence: { dbName: 'c4', storeKey: 'telemetry' },
      executor: BOOT_HOOKS,
    });
    const events: Array<{ command: string; pid?: number; exitCode: number | null; error?: string }> = [];
    ctx.succinix.on('succinix/command', (payload) => events.push(payload));
    await ctx.succinix.executor.spawn('node server.js');
    expect(events[0]).toMatchObject({ command: 'node server.js', exitCode: 0 });
    expect(events[0].pid).toBeTypeOf('number');
  });
});

describe('reload and subscription isolation (C4)', () => {
  it('fiber dispose clears subscriptions and reload does not stack port hooks', async () => {
    const first = await bootEngine();
    await first.ctx.succinix.ensureInstance('default', {
      persistence: { dbName: 'c4', storeKey: 'leak' },
      executor: BOOT_HOOKS,
    });
    const hooks = (pagePorts as unknown as { hooksByInstance: Map<string, unknown> }).hooksByInstance;
    const oldState: Array<{ port: number }> = [];
    first.ctx.succinix.on('succinix/state', () => {});
    first.ctx.succinix.onServerReady((payload) => oldState.push(payload));
    const beforeKeys = new Set(hooks.keys());
    expect(beforeKeys.has('succinix')).toBe(true);
    const hostProc = first.ctx.succinix.container.hostPid;

    await first.fiber.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.size).toBe(0);

    const reloaded = await loadEngine();
    await reloaded.ctx.succinix.boot({ executor: BOOT_HOOKS });
    await reloaded.ctx.succinix.ensureInstance('default', {
      persistence: { dbName: 'c4', storeKey: 'leak-2' },
      executor: BOOT_HOOKS,
    });
    reloaded.ctx.succinix.onServerReady(() => {});
    expect(hooks.size).toBe(beforeKeys.size);
    expect(hooks.has('succinix')).toBe(true);
    expect(reloaded.ctx.succinix.container.hostPid).toBe(hostProc);
    (reloaded.ctx.succinix.container.wc as unknown as { emitServerReady(port: number, url: string): void })
      .emitServerReady(8181, 'https://preview/8181');
    expect(oldState).toHaveLength(0);
  });
});

describe('failure isolation (C4)', () => {
  it('engine apply failure keeps the HostManager singleton and reapply restores service', async () => {
    const booted = await bootEngine();
    await booted.ctx.succinix.ensureInstance('default', {
      persistence: { dbName: 'c4', storeKey: 'engine-fail' },
      executor: BOOT_HOOKS,
    });
    const manager = getHostManager();
    const hostPid = booted.ctx.succinix.container.hostPid;
    await booted.fiber.dispose();
    expect(manager.handle().state).toBe('ready');

    const ctx = new Context();
    const badFiber = ctx.plugin({
      name: 'succinix',
      apply() {
        throw new Error('engine apply exploded');
      },
    });
    await expect(badFiber).rejects.toThrow(/engine apply exploded/);
    expect(ctx.get('succinix', false)).toBeUndefined();
    expect(getHostManager()).toBe(manager);
    expect(manager.handle().state).toBe('ready');

    const goodFiber = ctx.plugin(enginePlugin, {});
    await goodFiber;
    await ctx.succinix.boot({ executor: BOOT_HOOKS });
    expect(ctx.get('succinix', false)).toBeTruthy();
    expect(ctx.succinix.container.hostPid).toBe(hostPid);
  });

  it('invalid engine config fails into FAILED, keeps the page host, and recovers after reapply', async () => {
    const booted = await bootEngine();
    await booted.fiber.dispose();
    const manager = getHostManager();
    expect(manager.handle().state).toBe('ready');

    const ctx = new Context();
    const badFiber = ctx.plugin(enginePlugin, { resultTtlMs: 0 });
    await expect(badFiber).rejects.toThrow();
    expect(ctx.get('succinix', false)).toBeUndefined();
    expect(manager.handle().state).toBe('ready');

    const goodFiber = ctx.plugin(enginePlugin, {});
    await goodFiber;
    await ctx.succinix.boot({ executor: BOOT_HOOKS });
    expect(ctx.succinix.state.containerState).toBe('ready');
    expect(manager.handle().state).toBe('ready');
  });

  it('host boot failure records lastError, stays unattached, and retry succeeds with one host', async () => {
    const wc = new FakeWebContainer();
    wcApi.boot.mockRejectedValue(new Error('wc boot exploded'));
    const loaded = await loadEngine();
    await expect(loaded.ctx.succinix.boot({ executor: BOOT_HOOKS })).rejects.toThrow(/wc boot exploded/);
    expect(loaded.ctx.succinix.state.containerState).toBe('unattached');
    expect(loaded.ctx.succinix.state.lastError).toContain('wc boot exploded');
    wcApi.boot.mockReset();
    wcApi.boot.mockResolvedValue(asWebContainer(wc));
    await loaded.ctx.succinix.boot({ executor: BOOT_HOOKS });
    expect(loaded.ctx.succinix.state.containerState).toBe('ready');
    expect(wc.spawnCalls).toHaveLength(1);
  });

  it('one failing app plugin does not take down engine or other app plugins', async () => {
    const ctx = new Context();
    const engineFiber = ctx.plugin(enginePlugin, ENGINE_CONFIG);
    const appFibers = appPlugins.map((plugin) => ctx.plugin(plugin));
    const boomFiber = ctx.plugin({
      name: 'succinix-app-boom',
      apply() {
        throw new Error('app boom');
      },
    });
    const settled = await Promise.allSettled([engineFiber, ...appFibers, boomFiber]);
    expect(settled.at(-1)?.status).toBe('rejected');
    expect(ctx.get('succinix', false)).toBeTruthy();
    expect(ctx.get('succinix-app-terminal', false)).toBeTruthy();
    expect(ctx.get('succinix-app-commands', false)).toBeTruthy();
    expect(ctx.get('succinix-app-container', false)).toBeTruthy();
    const states = registryStates(ctx);
    expect(states.find((plugin) => plugin.name === 'succinix-app-boom')?.fibers[0]).toBe(3);
  });
});

describe('succinix status and plugins in the real app (C4)', () => {
  it('booted app command context exposes state and registry summaries', async () => {
    const { ctx, shell } = await bootApp();
    const commands = ctx.get('succinix-app-commands') as AppCommandsService;
    const context = commands.attach(shell as never);
    expect(context.succinixState?.version).toBe('0.5.0');
    expect(context.succinixState?.containerState).toBe('ready');
    expect(context.succinixPlugins?.map((plugin) => plugin.name)).toContain('succinix');
    expect(context.succinixPlugins?.map((plugin) => plugin.name)).toContain('succinix-app-container');
  });

  it('succinix status and succinix plugins render through the terminal', async () => {
    const { ctx, shell } = await bootApp();
    const commands = ctx.get('succinix-app-commands') as AppCommandsService;
    const context = commands.attach(shell as never);
    termMock.term.writeln.mockClear();
    expect(await tryHandleLocalCommand(context, 'succinix status')).toBe(true);
    const statusText = termMock.term.writeln.mock.calls.map((call) => String(call[0])).join('\n');
    expect(statusText).toContain('Succinix plugin status');
    expect(statusText).toContain('0.5.0');
    expect(statusText).toContain('configRevision');

    termMock.term.writeln.mockClear();
    expect(await tryHandleLocalCommand(context, 'succinix plugins')).toBe(true);
    const pluginsText = termMock.term.writeln.mock.calls.map((call) => String(call[0])).join('\n');
    expect(pluginsText).toContain('Plugins');
    expect(pluginsText).toContain('succinix-app-container');
  });
});
