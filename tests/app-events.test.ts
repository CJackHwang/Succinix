// v0.7 Cordis event wiring: terminal-open/close/backpressure and degradation
// events must be published by the app plugins on real lifecycle transitions.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import enginePlugin, { type SuccinixConfig } from '../src/plugin/index.js';
import { appPlugins } from '../src/host/plugins.js';
import { resetPageSingletons } from '../src/plugin/host-manager.js';
import { FakeWebContainer, asWebContainer } from './helpers/fake-webcontainer.js';
import { installFakeIDB } from './helpers/fakes.js';
import { RUBY_REQUEST_FILE } from '../src/engine/ruby-protocol.js';
import { mailboxPath, TERMINAL_PROTOCOL_VERSION } from '../src/terminal/transport-protocol.js';
import type { AppContainerService } from '../src/host/types.js';
import type { SuccinixDegradationEvent, SuccinixTerminalBackpressureEvent, SuccinixTerminalEvent } from '../src/plugin/events.js';

const wcApi = vi.hoisted(() => ({ boot: vi.fn() }));
const termMock = vi.hoisted(() => {
  const term = {
    onData: vi.fn(),
    onResize: vi.fn(),
    writeln: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    options: {},
    open: vi.fn(),
    loadAddon: vi.fn(),
    focus: vi.fn(),
  };
  const fitAddon = { fit: vi.fn() };
  return { term, fitAddon, ensureTerminal: vi.fn(async () => term), getTerm: vi.fn(() => term), getFitAddon: vi.fn(() => fitAddon) };
});

vi.mock('@webcontainer/api', () => ({ WebContainer: { boot: wcApi.boot } }));
vi.mock('../src/app/xterm.js', () => termMock);
vi.mock('../src/boot-ui.js', () => ({
  createBootUI: () => ({ log: vi.fn(), systemInfo: vi.fn(), complete: vi.fn(async () => {}), fail: vi.fn() }),
}));

vi.hoisted(() => {
  const win = { __succinixScenario: null, crossOriginIsolated: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as Record<string, unknown>;
  const global = globalThis as unknown as Record<string, unknown>;
  const define = (name: string, value: unknown) => Object.defineProperty(global, name, { value, configurable: true, writable: true });
  define('window', win);
  define('location', new URL('http://localhost/?scenario=1'));
  define('document', {});
  define('navigator', { userAgent: 'Mozilla/5.0 Chrome/120', language: 'en', hardwareConcurrency: 4 });
  (globalThis as unknown as Record<string, unknown>).performance = { now: () => 0 };
});

const idb = installFakeIDB();
const ENGINE_CONFIG: SuccinixConfig = { assets: { integrity: false } };

async function loadApp() {
  const ctx = new Context();
  const engineFiber = ctx.plugin(enginePlugin, ENGINE_CONFIG);
  const appFibers = appPlugins.map((plugin) => ctx.plugin(plugin));
  await Promise.all([engineFiber, ...appFibers]);
  const container = ctx.get('succinix-app-container') as AppContainerService;
  return { ctx, container };
}

async function bootApp(beforeStart?: (ctx: Context) => void) {
  const wc = new FakeWebContainer();
  wcApi.boot.mockResolvedValue(asWebContainer(wc));
  const loaded = await loadApp();
  beforeStart?.(loaded.ctx);
  const shell = await loaded.container.start();
  return { ...loaded, wc, shell };
}

function nextEvent<T>(ctx: Context, name: string): { promise: Promise<T>; resolve(payload: T): void } {
  let resolve!: (payload: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  ctx.on(name as never, ((payload: T) => resolve(payload)) as never);
  return { promise, resolve };
}

beforeEach(() => {
  resetPageSingletons();
  idb.reset();
  wcApi.boot.mockReset();
  vi.stubGlobal('indexedDB', idb.indexedDB);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '// host.js' })));
  termMock.term.onData.mockClear();
  termMock.term.onResize.mockClear();
  termMock.term.writeln.mockClear();
  termMock.term.write.mockClear();
});

describe('v0.7 Cordis terminal events', () => {
  it('publishes succinix/terminal-open when the interactive session opens', async () => {
    let open: { promise: Promise<SuccinixTerminalEvent> } | undefined;
    await bootApp((ctx) => {
      open = nextEvent<SuccinixTerminalEvent>(ctx, 'succinix/terminal-open');
    });
    const payload = await open!.promise;
    expect(payload).toMatchObject({ instanceId: 'default' });
    expect(payload.sessionId).toBeTruthy();
    expect(payload.bootNonce).toBeTruthy();
  });

  it('publishes succinix/terminal-backpressure for host pressure frames', async () => {
    const { ctx, shell } = await bootApp();
    const pressure = nextEvent<SuccinixTerminalBackpressureEvent>(ctx, 'succinix/terminal-backpressure');
    await shell!.wc.fs.writeFile(
      mailboxPath({
        instanceId: shell!.instanceId,
        sessionId: shell!.interactive.sessionId,
      }, 'out-000000000001.json'),
      JSON.stringify({
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        instanceId: shell!.instanceId,
        sessionId: shell!.interactive.sessionId,
        bootNonce: shell!.interactive.bootNonce,
        type: 'output',
        seq: 1,
        control: 'backpressure',
        bufferedBytes: 4096,
      })
    );
    const payload = await pressure.promise;
    expect(payload.queuedBytes).toBe(4096);
    expect(payload.limitBytes).toBeGreaterThan(0);
  });

  it('forwards xterm resize into the interactive mailbox', async () => {
    const { shell } = await bootApp();
    const resize = termMock.term.onResize.mock.calls[0]?.[0] as ((size: { cols: number; rows: number }) => void) | undefined;
    expect(resize).toBeTypeOf('function');
    resize?.({ cols: 132, rows: 43 });
    const path = mailboxPath({
      instanceId: shell!.instanceId,
      sessionId: shell!.interactive.sessionId,
    }, 'in-000000000001.json');
    const fakeFs = shell!.wc.fs as unknown as {
      has(path: string): boolean;
      raw(path: string): string | Uint8Array | null | undefined;
    };
    await vi.waitFor(() => {
      expect(fakeFs.has(path)).toBe(true);
    });
    const frame = JSON.parse(String(fakeFs.raw(path)));
    expect(frame.type).toBe('resize');
    expect(frame.cols).toBe(132);
    expect(frame.rows).toBe(43);
  });

  it('publishes succinix/terminal-close when the instance stops', async () => {
    const { ctx, shell } = await bootApp();
    const close = nextEvent<SuccinixTerminalEvent>(ctx, 'succinix/terminal-close');
    await shell!.onInstanceStop();
    const payload = await close.promise;
    expect(payload.sessionId).toBeTruthy();
    expect(payload.bootNonce).toBeTruthy();
  });

  it('publishes succinix/degradation when a runtime asset request is malformed', async () => {
    const { ctx, wc, shell } = await bootApp();
    const degraded = nextEvent<SuccinixDegradationEvent>(ctx, 'succinix/degradation');
    await wc.fs.writeFile(RUBY_REQUEST_FILE, '{not json');
    const payload = await degraded.promise;
    expect(payload.code).toBe('RUNTIME_ASSET_INJECTION_FAILED');
    expect(payload.runtime).toBe('ruby');
    expect(payload.retryable).toBe(true);
    expect(payload.degraded).toBe(true);
    shell!.runtimeAssets.stop();
    await shell!.onInstanceStop();
  });
});
