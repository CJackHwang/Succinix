// C2 plugin tests: lifecycle, single-host, service surface, events, capabilities,
// assets, invariants, and reload semantics.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from 'cordis';
import plugin, {
  Config,
  resolveConfig,
  requiresRestart,
  type SuccinixConfig,
} from '../src/plugin/index.js';
import { getHostManager, resetPageSingletons } from '../src/plugin/host-manager.js';
import { checkSync, type Schema } from '../src/plugin/schema.js';
import {
  SuccinixCapabilityRegistry,
  registerHostCapabilities,
} from '../src/plugin/capabilities.js';
import { invariant, invariantString } from '../src/plugin/invariant.js';
import {
  fetchAssetText,
  injectAssetOnce,
  sha256Hex,
} from '../src/plugin/assets.js';
import type { Context as CordisContext } from 'cordis';
import { FakeFS, installFakeIDB } from './helpers/fakes.js';
import { FakeWebContainer, asWebContainer } from './helpers/fake-webcontainer.js';

const wcApi = vi.hoisted(() => ({ boot: vi.fn() }));

vi.mock('@webcontainer/api', () => ({ WebContainer: { boot: wcApi.boot } }));

const idb = installFakeIDB();
const BOOT_HOOKS = { hostSrc: '// host.js', lifoCoreSrc: '// lifo-core.js' };

async function loadPlugin(config: SuccinixConfig = {}) {
  const ctx = new Context();
  const fiber = ctx.plugin(plugin, config);
  await fiber;
  return { ctx, fiber };
}

async function bootInternal(config: SuccinixConfig = {}) {
  const wc = new FakeWebContainer();
  wcApi.boot.mockResolvedValue(asWebContainer(wc));
  const loaded = await loadPlugin(config);
  await loaded.ctx.succinix.boot({ executor: BOOT_HOOKS });
  return { ...loaded, wc };
}

async function attachExternal(config: SuccinixConfig = {}) {
  const wc = new FakeWebContainer();
  const loaded = await loadPlugin({
    ...config,
    container: { ...(config.container ?? {}), mode: 'external' },
  });
  await loaded.ctx.succinix.attach(asWebContainer(wc), { executor: BOOT_HOOKS });
  return { ...loaded, wc };
}

async function ensureDefault(ctx: CordisContext, storeKey = `plugin-c2-${Math.random()}`) {
  return ctx.succinix.ensureInstance('default', {
    persistence: { dbName: 'plugin-c2', storeKey },
    executor: BOOT_HOOKS,
  });
}

beforeEach(() => {
  resetPageSingletons();
  idb.reset();
  wcApi.boot.mockReset();
  vi.stubGlobal('indexedDB', idb.indexedDB);
});

describe('config schema (C2)', () => {
  it('accepts a full valid config', () => {
    const result = checkSync(Config, {
      resultTtlMs: 5000,
      container: { mode: 'external', bootRetries: 2 },
      defaultInstance: { instanceId: 'default', home: '/workspace/users/guest' },
      terminal: { timeoutMs: 30000, history: true },
      capabilities: { defaultAllow: true, rules: [{ pattern: 'fs.read', allow: true }] },
      lifecycle: { disposeMode: 'soft', flushOnPageHide: true },
      assets: { integrity: true },
    });
    expect('issues' in result).toBe(false);
  });

  it('rejects invalid nested values and unknown capability patterns', () => {
    const result = checkSync(Config, {
      container: { mode: 'hosted' },
      capabilities: { rules: [{ pattern: 'terminal.rm', allow: true }] },
    });
    expect('issues' in result && result.issues).toBeTruthy();
  });

  it('rejects non-serializable values', () => {
    const result = checkSync(Config, { resultTtlMs: 0, terminal: { timeoutMs: -1 } });
    expect('issues' in result && result.issues).toBeTruthy();
  });

  it('requiresRestart covers host assets and container mode only', () => {
    expect(requiresRestart({}, { pythonAssetsUrl: '/other-py/' })).toBe(true);
    expect(requiresRestart({}, { resultTtlMs: 1, capabilities: { defaultAllow: false } })).toBe(false);
  });

  it('rejects unknown top-level and nested fields', () => {
    expect('issues' in checkSync(Config, { unknownField: true })).toBe(true);
    expect('issues' in checkSync(Config, { container: { bootRetries: 1, surprise: true } })).toBe(true);
    expect('issues' in checkSync(Config, { terminal: { cwd: '/tmp', promptPrefix: 'x', accent: 'gold' } })).toBe(true);
  });

  it('resolveConfig applies serializable defaults', () => {
    const resolved = resolveConfig({});
    expect(resolved.hostJsUrl).toBe('/host.js');
    expect(resolved.lifoCoreUrl).toBe('/lifo-core.js');
    expect(resolved.pythonAssetsUrl).toBe('/pyodide/');
    expect(resolved.container.mode).toBe('internal');
    expect(resolved.terminal.promptPrefix).toBe('guest@succinix:');
    expect(resolved.terminal.cwd).toBe('/workspace');
    expect(resolved.capabilities.defaultAllow).toBe(true);
  });

  it('rejects async validation with TypeError', () => {
    const asyncSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => Promise.resolve({ value: {} }),
      },
    } as unknown as Schema<Record<string, unknown>>;
    expect(() => checkSync(asyncSchema, {})).toThrow(TypeError);
  });

  it('rejects invalid nested persistence and lifecycle values', () => {
    expect('issues' in checkSync(Config, { defaultInstance: { persistence: { dbName: 1 } } })).toBe(true);
    expect('issues' in checkSync(Config, { lifecycle: { disposeMode: 'nuclear' } })).toBe(true);
    expect('issues' in checkSync(Config, { assets: { integrity: 'yes' } })).toBe(true);
  });
});

describe('capabilities (C2)', () => {
  it('defaults to allow and lists all patterns', () => {
    const registry = new SuccinixCapabilityRegistry({ defaultAllow: true, rules: [] });
    expect(registry.check('terminal.exec')).toBe(true);
    expect(registry.list()).toEqual([
      'terminal.exec',
      'terminal.spawn',
      'terminal.kill',
      'terminal.interrupt',
      'fs.read',
      'fs.write',
      'workspace.restore',
      'workspace.flush',
      'workspace.list',
    ]);
  });

  it('honors explicit deny rules', () => {
    const registry = new SuccinixCapabilityRegistry({
      defaultAllow: true,
      rules: [{ pattern: 'fs.write', allow: false }],
    });
    expect(registry.check('fs.write')).toBe(false);
    expect(registry.check('fs.read')).toBe(true);
  });

  it('define overrides rules and can be undone', () => {
    const registry = new SuccinixCapabilityRegistry({ defaultAllow: false, rules: [] });
    expect(registry.check('fs.read')).toBe(false);
    const undo = registry.define('fs.read', () => true);
    expect(registry.check('fs.read')).toBe(true);
    undo();
    expect(registry.check('fs.read')).toBe(false);
  });

  it('reset clears runtime overrides', () => {
    const registry = new SuccinixCapabilityRegistry({ defaultAllow: false, rules: [] });
    registry.define('fs.read', () => true);
    registry.reset();
    expect(registry.check('fs.read')).toBe(false);
  });

  it('integrates with an optional host capability service', () => {
    const defined: string[] = [];
    const host = {
      define: (name: string) => {
        defined.push(name);
        return () => {};
      },
    };
    const fakeCtx = {
      get: (name: string, fallback: unknown) => (name === 'capability' ? host : fallback),
    } as unknown as CordisContext;
    const registry = new SuccinixCapabilityRegistry({ defaultAllow: true, rules: [] });
    const disposers = registerHostCapabilities(fakeCtx, registry);
    expect(defined).toContain('terminal.exec');
    expect(disposers.length).toBe(9);
    for (const dispose of disposers) dispose();
  });

  it('skips host integration when capability is absent', () => {
    const fakeCtx = {
      get: (name: string, fallback: unknown) => (name === 'capability' ? undefined : fallback),
    } as unknown as CordisContext;
    const registry = new SuccinixCapabilityRegistry({ defaultAllow: true, rules: [] });
    expect(registerHostCapabilities(fakeCtx, registry)).toEqual([]);
  });
});

describe('invariants (C2)', () => {
  it('invariant throws on false', () => {
    expect(() => invariant(false, 'must be true')).toThrow(/must be true/);
  });

  it('invariantString rejects empty strings', () => {
    expect(() => invariantString('', 'name')).toThrow(/non-empty string/);
  });

  it('ensureInstance rejects empty container ids', async () => {
    const { ctx, fiber } = await bootInternal();
    await expect(ctx.succinix.ensureInstance('')).rejects.toThrow(/non-empty string/);
    await fiber.dispose();
  });
});

describe('assets (C2)', () => {
  it('sha256Hex matches known digest', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('fetchAssetText rejects integrity mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'abc' })));
    await expect(fetchAssetText('/host.js', 'deadbeef', true)).rejects.toThrow(/integrity check failed/);
  });

  it('fetchAssetText skips verification when integrity is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'abc' })));
    await expect(fetchAssetText('/host.js', 'deadbeef', false)).resolves.toBe('abc');
  });

  it('injectAssetOnce is idempotent and writes only once', async () => {
    const fs = new FakeFS();
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '// host.js' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await injectAssetOnce(fs as never, '/host.js', '/host.js', undefined, false)).toBe(true);
    expect(await injectAssetOnce(fs as never, '/host.js', '/host.js', undefined, false)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.raw('/host.js')).toBe('// host.js');
  });
});

describe('HostManager singleton (C2)', () => {
  it('is stable until resetPageSingletons', () => {
    const first = getHostManager();
    expect(getHostManager()).toBe(first);
    resetPageSingletons();
    expect(getHostManager()).not.toBe(first);
  });

  it('survives fiber dispose', async () => {
    const first = getHostManager();
    const { fiber } = await bootInternal();
    await fiber.dispose();
    expect(getHostManager()).toBe(first);
    expect(first.handle().state).toBe('ready');
  });

  it('shutdown resets state and resetPageSingletons detaches the old manager', async () => {
    const { ctx, fiber } = await bootInternal();
    const first = getHostManager();
    await ctx.succinix.shutdown();
    expect(first.handle().state).toBe('disposed');
    await fiber.dispose();
    resetPageSingletons();
    expect(getHostManager()).not.toBe(first);
  });
});

describe('lifecycle and single host (C2)', () => {
  it('boot internal spawns one host and reaches ready', async () => {
    const { ctx, wc } = await bootInternal();
    expect(ctx.succinix.state.containerState).toBe('ready');
    expect(ctx.succinix.state.containerMode).toBe('internal');
    expect(wc.spawnCalls).toEqual([{ prog: 'node', args: ['host.js'] }]);
    expect(ctx.succinix.container.startedAt).toBeGreaterThan(0);
  });

  it('attach external spawns one host and reaches ready', async () => {
    const { ctx, wc } = await attachExternal();
    expect(ctx.succinix.state.containerState).toBe('ready');
    expect(ctx.succinix.state.containerMode).toBe('external');
    expect(wc.spawnCalls).toEqual([{ prog: 'node', args: ['host.js'] }]);
  });

  it('boot is idempotent', async () => {
    const { ctx, wc } = await bootInternal();
    await ctx.succinix.boot({ executor: BOOT_HOOKS });
    expect(wc.spawnCalls.length).toBe(1);
  });

  it('attach is idempotent', async () => {
    const { ctx, wc } = await attachExternal();
    await ctx.succinix.attach(asWebContainer(wc), { executor: BOOT_HOOKS });
    expect(wc.spawnCalls.length).toBe(1);
  });

  it('boot after attach throws ERR_MODE_MISMATCH', async () => {
    const { ctx } = await attachExternal();
    await expect(ctx.succinix.boot()).rejects.toThrow(/ERR_MODE_MISMATCH/);
  });

  it('attach after boot throws ERR_MODE_MISMATCH', async () => {
    const { ctx, wc } = await bootInternal();
    await expect(ctx.succinix.attach(asWebContainer(wc))).rejects.toThrow(/ERR_MODE_MISMATCH/);
  });

  it('multiple instances never spawn a second host', async () => {
    const { ctx, wc } = await bootInternal();
    await ctx.succinix.ensureInstance('a', { persistence: { dbName: 'plugin-c2', storeKey: 'a' }, executor: BOOT_HOOKS });
    await ctx.succinix.ensureInstance('b', { persistence: { dbName: 'plugin-c2', storeKey: 'b' }, executor: BOOT_HOOKS });
    expect(wc.spawnCalls.length).toBe(1);
    expect(ctx.succinix.state.instances).toHaveLength(2);
    expect(ctx.succinix.getInstance('a')?.instanceId).toBe('a');
  });

  it('soft dispose keeps the host and removes the service', async () => {
    const { ctx, fiber, wc } = await bootInternal();
    await ensureDefault(ctx);
    const manager = getHostManager();
    await fiber.dispose();
    expect(manager.handle().state).toBe('ready');
    expect(wc.hostProc.kill).not.toHaveBeenCalled();
    expect(ctx.get('succinix', false)).toBeUndefined();
  });

  it('reload restores the service without restarting the host', async () => {
    const { ctx, fiber, wc } = await bootInternal();
    await ensureDefault(ctx);
    const spawnCount = wc.spawnCalls.length;
    await fiber.dispose();
    const reloaded = await loadPlugin();
    await reloaded.ctx.succinix.boot({ executor: BOOT_HOOKS });
    expect(wc.spawnCalls.length).toBe(spawnCount);
    await ensureDefault(reloaded.ctx, 'reload-key');
    expect(reloaded.ctx.succinix.executor).toBeTruthy();
  });

  it('shutdown kills the host and marks state disposed', async () => {
    const { ctx, wc } = await bootInternal();
    await ctx.succinix.shutdown();
    expect(wc.hostProc.kill).toHaveBeenCalledTimes(1);
    expect(ctx.succinix.state.containerState).toBe('disposed');
    expect(getHostManager().handle().state).toBe('disposed');
  });

  it('shutdown is idempotent', async () => {
    const { ctx, wc } = await bootInternal();
    await ctx.succinix.shutdown();
    await ctx.succinix.shutdown();
    expect(wc.hostProc.kill).toHaveBeenCalledTimes(1);
  });

  it('host boot failure records lastError', async () => {
    wcApi.boot.mockRejectedValue(new Error('wc boot exploded'));
    const loaded = await loadPlugin();
    await expect(loaded.ctx.succinix.boot({ executor: BOOT_HOOKS })).rejects.toThrow(/wc boot exploded/);
    expect(loaded.ctx.succinix.state.lastError).toContain('wc boot exploded');
    await loaded.fiber.dispose();
  });
});

describe('service surface (C2)', () => {
  it('default services fail fast before ensureInstance', async () => {
    const { ctx, fiber } = await bootInternal();
    expect(() => ctx.succinix.executor).toThrow(/not available/);
    expect(ctx.succinix.state.lastError).toContain('not available');
    await fiber.dispose();
  });

  it('executor and instance are available after ensureInstance', async () => {
    const { ctx } = await bootInternal();
    const instance = await ensureDefault(ctx);
    expect(ctx.succinix.instance).toBe(instance);
    expect(ctx.succinix.executor).toBe(instance.executor);
  });

  it('terminal.create returns a session bound to the default instance', async () => {
    const { ctx } = await bootInternal();
    await ensureDefault(ctx);
    const session = ctx.succinix.terminal.create({ write() {}, clear() {} });
    expect(session.getPrompt()).toContain('guest@succinix');
    session.dispose();
  });

  it('snapshot save/meta/clear work', async () => {
    const { ctx } = await bootInternal();
    await ensureDefault(ctx, 'snapshot-key');
    const saved = await ctx.succinix.snapshot.save();
    expect(saved.skipped).toBe(false);
    expect(await ctx.succinix.snapshot.meta()).toMatchObject({ version: 1 });
    await ctx.succinix.snapshot.clear();
    expect(await ctx.succinix.snapshot.meta()).toBeNull();
  });

  it('persist save/load/clear work', async () => {
    const { ctx } = await bootInternal();
    await ensureDefault(ctx, 'persist-key');
    await ctx.succinix.persist.force(ctx.succinix.container.wc!.fs);
    expect(await ctx.succinix.persist.meta()).toMatchObject({ version: 1 });
    await ctx.succinix.persist.clear();
    expect(await ctx.succinix.persist.meta()).toBeNull();
  });

  it('workspace restore/flush/list work', async () => {
    const { ctx } = await bootInternal();
    await ensureDefault(ctx, 'workspace-key');
    await ctx.succinix.workspace.flush('test');
    const list = await ctx.succinix.workspace.list();
    expect(list[0]).toMatchObject({ instanceId: 'default' });
    await ctx.succinix.workspace.restore();
    expect(ctx.succinix.workspace.stateRoot).toBe('');
  });

  it('services list/start/stop fail gracefully on unknown services', async () => {
    const { ctx } = await bootInternal();
    await ensureDefault(ctx, 'services-key');
    const list = await ctx.succinix.services.list();
    expect(list.map((service) => service.def.name)).toEqual(['tinbase']);
    expect(list[0].state).toBe('stopped');
    const started = await ctx.succinix.services.start('missing');
    expect(started.ok).toBe(false);
    const stopped = await ctx.succinix.services.stop('missing');
    expect(stopped.ok).toBe(false);
  });

  it('listProcesses returns the process table and emits process event', async () => {
    const { ctx } = await bootInternal();
    await ensureDefault(ctx, 'ps-key');
    const events: unknown[] = [];
    ctx.succinix.on('succinix/process', (payload) => events.push(payload));
    const procs = await ctx.succinix.listProcesses();
    expect(procs).toEqual([]);
    expect(events[0]).toMatchObject({ instanceId: 'default' });
  });
});

describe('ports (C2)', () => {
  it('starts empty and reflects ready ports after events', async () => {
    const { ctx, wc } = await bootInternal();
    await ensureDefault(ctx, 'ports-key');
    expect(ctx.succinix.ports.list().size).toBe(0);
    wc.emitServerReady(3000, 'https://preview/3000');
    expect(ctx.succinix.ports.ready(3000)).toBe('https://preview/3000');
    expect(ctx.succinix.ports.list().get(3000)).toBe('https://preview/3000');
  });

  it('onServerReady receives instance-scoped payloads', async () => {
    const { ctx, wc } = await bootInternal();
    await ensureDefault(ctx, 'ports-ready-key');
    const events: Array<{ port: number; url?: string; instanceId?: string }> = [];
    ctx.succinix.onServerReady((payload) => events.push(payload));
    wc.emitServerReady(4000, 'https://preview/4000');
    expect(events[0]).toMatchObject({ port: 4000, url: 'https://preview/4000', instanceId: 'default' });
  });

  it('unsubscribe stops ready events', async () => {
    const { ctx, wc } = await bootInternal();
    await ensureDefault(ctx, 'ports-unsub-key');
    const events: unknown[] = [];
    const unsubscribe = ctx.succinix.onServerReady((payload) => events.push(payload));
    unsubscribe();
    wc.emitServerReady(5000, 'https://preview/5000');
    expect(events).toHaveLength(0);
  });

  it('onServerClosed receives port close events', async () => {
    const { ctx, wc } = await bootInternal();
    await ensureDefault(ctx, 'ports-close-key');
    const events: Array<{ port: number; instanceId?: string }> = [];
    ctx.succinix.onServerClosed((payload) => events.push(payload));
    wc.emitServerReady(6000, 'https://preview/6000');
    wc.emitPortClosed(6000);
    expect(events[0]).toMatchObject({ port: 6000, instanceId: 'default' });
    expect(ctx.succinix.ports.ready(6000)).toBeUndefined();
  });

  it('dispose clears port subscriptions', async () => {
    const { ctx, fiber, wc } = await bootInternal();
    await ensureDefault(ctx, 'ports-dispose-key');
    const events: unknown[] = [];
    ctx.succinix.onServerReady((payload) => events.push(payload));
    await fiber.dispose();
    wc.emitServerReady(7000, 'https://preview/7000');
    expect(events).toHaveLength(0);
  });
});

describe('service consumption and reload (C2)', () => {
  it('consumer with inject can access ctx.succinix', async () => {
    const { ctx } = await loadPlugin();
    let seen: unknown = null;
    const consumer = {
      name: 'consumer',
      inject: ['succinix'],
      apply(context: CordisContext) {
        seen = context.succinix;
      },
    };
    const fiber = ctx.plugin(consumer);
    await fiber;
    expect(seen).toBe(ctx.succinix);
    await fiber.dispose();
  });

  it('ctx.get fallback is undefined when the provider is absent', () => {
    const ctx = new Context();
    expect(ctx.get('succinix', false)).toBeUndefined();
  });

  it('provider dispose makes the service unavailable', async () => {
    const { ctx, fiber } = await loadPlugin();
    let active = true;
    const consumer = {
      name: 'consumer',
      inject: ['succinix'],
      apply(context: CordisContext) {
        active = Boolean(context.succinix);
      },
    };
    const consumerFiber = ctx.plugin(consumer);
    await consumerFiber;
    await fiber.dispose();
    expect(ctx.get('succinix', false)).toBeUndefined();
    expect(active).toBe(true);
  });

  it('reapply restores injected consumers', async () => {
    const ctx = new Context();
    const values: unknown[] = [];
    const consumer = {
      name: 'consumer',
      inject: ['succinix'],
      apply(context: CordisContext) {
        values.push(context.succinix);
      },
    };
    const providerFiber = ctx.plugin(plugin, {});
    await providerFiber;
    const consumerFiber = ctx.plugin(consumer);
    await consumerFiber;
    await providerFiber.dispose();
    const providerFiber2 = ctx.plugin(plugin, {});
    await providerFiber2;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.get('succinix', false)).toBeTruthy();
    expect(values.length).toBeGreaterThanOrEqual(2);
  });
});

describe('state events and reconfigure (C2)', () => {
  it('state event carries reason and changed fields', async () => {
    const { ctx } = await bootInternal();
    const events: Array<{ reason: string; changed: string[] }> = [];
    ctx.succinix.on('succinix/state', (payload) => events.push(payload));
    await ensureDefault(ctx, 'state-key');
    expect(events.some((event) => event.reason === 'instance' && event.changed.includes('instances'))).toBe(true);
  });

  it('hot reconfigure increments configRevision without restarting the host', async () => {
    const { ctx, wc } = await bootInternal();
    await ensureDefault(ctx, 'reconfigure-hot-key');
    const events: Array<{ reason: string; changed: string[] }> = [];
    ctx.succinix.on('succinix/state', (payload) => events.push(payload));
    await ctx.succinix.reconfigure({ resultTtlMs: 5000 });
    expect(ctx.succinix.state.configRevision).toBe(1);
    expect(wc.spawnCalls.length).toBe(1);
    expect(events.some((event) => event.reason === 'config' && event.changed.includes('configRevision'))).toBe(true);
  });

  it('restart-required reconfigure shuts the host down', async () => {
    const { ctx } = await bootInternal();
    await ctx.succinix.reconfigure({ hostJsUrl: '/other-host.js' });
    expect(ctx.succinix.state.containerState).toBe('disposed');
    expect(getHostManager().handle().state).toBe('disposed');
    expect(ctx.succinix.state.configRevision).toBe(1);
  });

  it('invalid reconfigure throws ValidationError and preserves the last valid config', async () => {
    const { ctx } = await bootInternal();
    await expect(ctx.succinix.reconfigure({ resultTtlMs: 0 })).rejects.toThrow();
    expect(ctx.succinix.state.lastError).toContain('resultTtlMs');
    expect(ctx.succinix.state.configRevision).toBe(0);
    expect(getHostManager().handle().state).toBe('ready');
  });

  it('command telemetry emits startedAt/durationMs/runtime', async () => {
    const { ctx } = await bootInternal();
    await ensureDefault(ctx, 'telemetry-key');
    const events: Array<{ command: string; instanceId: string; startedAt: number; durationMs: number; runtime: string }> = [];
    ctx.succinix.on('succinix/command', (payload) => events.push(payload));
    await ctx.succinix.executor.exec('echo hi');
    expect(events[0]).toMatchObject({ command: 'echo hi', instanceId: 'default', runtime: 'lifo', exitCode: 0 });
    expect(events[0].startedAt).toBeGreaterThan(0);
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
