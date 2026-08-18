// C3 app plugin lifecycle tests: the host app is a Cordis Context composed from
// @succinix/engine and the app plugins, with a single page host and one shell.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import enginePlugin, { type SuccinixConfig } from '../src/plugin/index.js';
import { appPlugins } from '../src/host/plugins.js';
import { resolveInstanceRequest } from '../src/host/bootstrap.js';
import { getHostManager, resetPageSingletons } from '../src/plugin/host-manager.js';
import { FakeWebContainer, asWebContainer } from './helpers/fake-webcontainer.js';
import { hostOf, installFakeIDB } from './helpers/fakes.js';
import type { AppContainerService, AppShellService, AppCommandsService } from '../src/host/types.js';

const wcApi = vi.hoisted(() => ({ boot: vi.fn() }));
const termMock = vi.hoisted(() => {
  const term = {
    onData: vi.fn(),
    writeln: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    options: {},
    open: vi.fn(),
    loadAddon: vi.fn(),
    focus: vi.fn(),
  };
  const fitAddon = { fit: vi.fn() };
  return {
    term,
    fitAddon,
    ensureTerminal: vi.fn(async () => term),
    getTerm: vi.fn(() => term),
    getFitAddon: vi.fn(() => fitAddon),
  };
});

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
  define('location', new URL('http://localhost/?scenario=1'));
  define('document', {});
  define('navigator', {
    userAgent: 'Mozilla/5.0 Chrome/120',
    language: 'en',
    hardwareConcurrency: 4,
  });
  (globalThis as unknown as Record<string, unknown>).performance = { now: () => 0 };
});

const idb = installFakeIDB();
const ENGINE_CONFIG: SuccinixConfig = { assets: { integrity: false } };

async function loadApp(config: SuccinixConfig = ENGINE_CONFIG) {
  const ctx = new Context();
  const engineFiber = ctx.plugin(enginePlugin, config);
  const appFibers = appPlugins.map((plugin) => ctx.plugin(plugin));
  await Promise.all([engineFiber, ...appFibers]);
  const containerFiber = appFibers[appFibers.length - 1]!;
  return { ctx, engineFiber, appFibers, containerFiber };
}

async function bootApp(config: SuccinixConfig = ENGINE_CONFIG) {
  const wc = new FakeWebContainer();
  wcApi.boot.mockResolvedValue(asWebContainer(wc));
  const loaded = await loadApp(config);
  const container = loaded.ctx.get('succinix-app-container') as AppContainerService;
  const shell = await container.start();
  return { ...loaded, wc, container, shell };
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

describe('instance request parsing (C3)', () => {
  it('default, instance, user, and default aliases resolve to the expected mode', () => {
    expect(resolveInstanceRequest(new URLSearchParams(''))).toEqual({ id: null, userMode: false, demo: false });
    expect(resolveInstanceRequest(new URLSearchParams('?instance=c-1'))).toEqual({ id: 'c-1', userMode: false, demo: true });
    expect(resolveInstanceRequest(new URLSearchParams('?user=alice'))).toEqual({ id: 'alice', userMode: true, demo: true });
    expect(resolveInstanceRequest(new URLSearchParams('?instance=default'))).toEqual({ id: null, userMode: false, demo: false });
    expect(resolveInstanceRequest(new URLSearchParams('?user=default'))).toEqual({ id: null, userMode: false, demo: false });
  });

  it('rejects malformed URL instance identifiers before boot', () => {
    expect(() => resolveInstanceRequest(new URLSearchParams('?instance=../other'))).toThrow(/invalid instance id/);
    expect(() => resolveInstanceRequest(new URLSearchParams('?user=with%20space'))).toThrow(/invalid instance id/);
  });
});

describe('Cordis app plugin tree (C3)', () => {
  it('loads the engine and every app plugin in one Context', async () => {
    const { ctx } = await loadApp();
    expect(ctx.get('succinix', false)).toBeTruthy();
    for (const name of [
      'succinix-app-terminal',
      'succinix-app-commands',
      'succinix-app-snapshot',
      'succinix-app-watchdog',
      'succinix-app-selftest',
      'succinix-app-devhooks',
      'succinix-app-container',
      'succinix-app-shell',
    ]) {
      expect(ctx.get(name, false), name).toBeTruthy();
    }
  });

  it('container start boots one WebContainer, one host, and one default instance', async () => {
    const { ctx, wc, shell } = await bootApp();
    expect(hostOf(ctx).state.containerState).toBe('ready');
    expect(hostOf(ctx).state.instances).toHaveLength(1);
    expect(wc.spawnCalls).toEqual([{ prog: 'node', args: ['host.js'] }]);
    expect(shell).not.toBeNull();
  });

  it('shell service is populated and the command context is wired to the instance', async () => {
    const { ctx, shell } = await bootApp();
    const shellService = ctx.get('succinix-app-shell') as AppShellService;
    expect(shellService.getShell()).toBe(shell);
    const commands = ctx.get('succinix-app-commands') as AppCommandsService;
    const context = commands.attach(shell!);
    expect(context.wc).toBe((shell as { wc: unknown }).wc);
    expect(context.persist).toBe((shell as { instance: { persist: unknown } }).instance.persist);
    expect(context.instanceId).toBeUndefined();
    expect(context.onInstanceReset).toBeTypeOf('function');
    expect(context.onInstanceStop).toBeTypeOf('function');
  });

  it('terminal surface is shared and wired exactly once to the shell', async () => {
    const { ctx, shell } = await bootApp();
    const terminal = ctx.get('succinix-app-terminal') as { getTerm(): unknown };
    expect(terminal.getTerm()).toBe(termMock.term);
    expect(termMock.term.onData).toHaveBeenCalledTimes(1);
    expect(shell).not.toBeNull();
  });

  it('repeated start is idempotent: no second host spawn and the same shell is returned', async () => {
    const { ctx, wc, container, shell } = await bootApp();
    const again = await container.start();
    expect(again).toBe(shell);
    expect(wc.spawnCalls).toHaveLength(1);
    expect(hostOf(ctx).state.instances).toHaveLength(1);
  });

  it('scenario devhook exposes the window handle after boot', async () => {
    const { shell } = await bootApp();
    expect(shell).not.toBeNull();
    const win = (globalThis as unknown as { window: { __succinixScenario?: { booted: boolean } } }).window;
    expect(win.__succinixScenario?.booted).toBe(true);
  });

  it('container fiber dispose clears the shell while the shared host stays ready', async () => {
    const { ctx, containerFiber, wc } = await bootApp();
    const shellService = ctx.get('succinix-app-shell') as AppShellService;
    expect(shellService.getShell()).not.toBeNull();
    await containerFiber.dispose();
    expect(shellService.getShell()).toBeNull();
    expect(getHostManager().handle().state).toBe('ready');
    expect(wc.hostProc.kill).not.toHaveBeenCalled();
  });

  it('engine remains available after an app plugin fiber is disposed', async () => {
    const { ctx, containerFiber } = await bootApp();
    await containerFiber.dispose();
    expect(ctx.get('succinix', false)).toBeTruthy();
    expect(hostOf(ctx).state.containerState).toBe('ready');
  });
});
