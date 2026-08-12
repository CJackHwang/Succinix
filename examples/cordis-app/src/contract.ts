import { Context, FiberState, type Fiber } from 'cordis';
import enginePlugin, {
  ensurePythonRuntime,
  type SuccinixConfig,
  type SuccinixPortEvent,
  type SuccinixService,
} from '@succinix/engine';
import type { WebContainer } from '@webcontainer/api';

export interface ContractCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ContractResult {
  checks: ContractCheck[];
  passed: number;
  failed: number;
}

const EXPECTED_CAPABILITIES = [
  'terminal.exec',
  'terminal.spawn',
  'terminal.kill',
  'terminal.interrupt',
  'fs.read',
  'fs.write',
  'workspace.restore',
  'workspace.flush',
  'workspace.list',
] as const;

function add(checks: ContractCheck[], name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
}

async function expectMismatch(fn: () => Promise<unknown>, checks: ContractCheck[], name: string): Promise<void> {
  try {
    await fn();
    add(checks, name, false, 'expected ERR_MODE_MISMATCH, got success');
  } catch (error) {
    const message = String(error);
    add(checks, name, message.includes('ERR_MODE_MISMATCH'), message.slice(0, 160));
  }
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

function waitForEvent<T>(
  subscribe: (handler: (payload: T) => void) => () => void,
  predicate: (payload: T) => boolean,
  timeoutMs: number
): Promise<T | null> {
  return new Promise((resolve) => {
    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsub?.();
      resolve(null);
    }, timeoutMs);
    unsub = subscribe((payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      unsub?.();
      resolve(payload);
    });
  });
}

function baseConfig(storeKey: string): SuccinixConfig {
  return {
    hostJsUrl: '/engine/host.js',
    lifoCoreUrl: '/engine/lifo-core.js',
    pythonAssetsUrl: '/pyodide/',
    container: { mode: 'internal', bootRetries: 2, bootIntervalMs: 1000, hostReadyDeadlineMs: 120000 },
    defaultInstance: {
      instanceId: 'demo',
      home: '/workspace/demo',
      persistence: { dbName: 'cordis-app-contract', storeKey },
    },
    terminal: { timeoutMs: 120000, bootGate: false },
    assets: { integrity: true },
    lifecycle: { disposeMode: 'soft', flushOnPageHide: false },
  };
}

async function withSection(
  checks: ContractCheck[],
  name: string,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    add(checks, `${name} completed`, false, String(error).slice(0, 240));
  }
}

export async function runContract(): Promise<ContractResult> {
  const checks: ContractCheck[] = [];
  const storeKey = `contract-${Date.now()}`;
  const config = baseConfig(storeKey);
  const ctx = new Context();
  const stateEvents: string[] = [];
  let engineFiber: Fiber | null = null;

  await withSection(checks, 'plugin', async () => {
    const fiber = ctx.plugin(enginePlugin, config);
    engineFiber = fiber;
    await fiber;
    add(checks, 'plugin object shape', enginePlugin.name === 'succinix' && typeof enginePlugin.apply === 'function' && !!enginePlugin.Config);
    add(checks, 'fiber reaches ACTIVE', fiber.state === FiberState.ACTIVE, String(fiber.state));

    let injected: unknown = null;
    const consumerFiber = ctx.plugin({
      name: 'contract-consumer',
      inject: ['succinix'],
      apply(consumerCtx: Context) {
        injected = consumerCtx.succinix;
        consumerCtx.on('succinix/state', (payload) => stateEvents.push(payload.reason));
      },
    });
    await consumerFiber;
    add(checks, 'inject: [succinix] resolves', injected === ctx.succinix);

    const fallbackCtx = new Context();
    let fallbackValue: unknown = 'unset';
    const fallbackFiber = fallbackCtx.plugin({
      name: 'contract-fallback',
      apply(consumerCtx: Context) {
        fallbackValue = consumerCtx.get('succinix', false);
      },
    });
    await fallbackFiber;
    add(checks, 'uninjected fallback is explicit', fallbackValue === undefined);
    await fallbackFiber.dispose();

    const service: SuccinixService = ctx.succinix;
    const capabilityMatch =
      service.capabilities.list().length === EXPECTED_CAPABILITIES.length &&
      service.capabilities.list().every((name, index) => name === EXPECTED_CAPABILITIES[index]);
    add(checks, 'capability pattern set matches SunamAI', capabilityMatch);

    const manifest = await fetch('/engine/sha256.json').then((response) => response.json());
    const hostAsset = await fetch('/engine/host.js').then((response) => response.text());
    const hostDigest = await sha256Hex(new TextEncoder().encode(hostAsset));
    add(
      checks,
      'asset SHA manifest matches host.js',
      typeof manifest['host.js'] === 'string' && manifest['host.js'] === hostDigest,
      `${manifest['host.js']?.slice(0, 16) ?? 'missing'}`
    );
    add(
      checks,
      'asset SHA manifest has lifo-core.js',
      typeof manifest['lifo-core.js'] === 'string' && manifest['lifo-core.js'].length === 64
    );
  });

  let wc: WebContainer | null = null;
  let startedAt: number | null = null;

  await withSection(checks, 'container', async () => {
    const booted = await ctx.succinix.boot();
    wc = booted;
    startedAt = ctx.succinix.state.host.startedAt;
    add(checks, 'internal boot reaches ready', ctx.succinix.state.containerState === 'ready' && ctx.succinix.container.state === 'ready');
    add(checks, 'state event includes ready', stateEvents.includes('ready'));

    await ctx.succinix.ensureInstance('demo', {
      persistence: { dbName: 'cordis-app-contract', storeKey },
      home: '/workspace/demo',
      executor: {},
    });
    add(checks, 'default instance is available', ctx.succinix.instance?.instanceId === 'demo');

    const service: SuccinixService = ctx.succinix;
    const surfaceOk =
      typeof service.state === 'object' &&
      typeof service.container === 'object' &&
      typeof service.boot === 'function' &&
      typeof service.attach === 'function' &&
      typeof service.ensureInstance === 'function' &&
      typeof service.getInstance === 'function' &&
      typeof service.releaseInstance === 'function' &&
      typeof service.listProcesses === 'function' &&
      typeof service.terminal.create === 'function' &&
      typeof service.snapshot.save === 'function' &&
      typeof service.snapshot.restore === 'function' &&
      typeof service.persist.save === 'function' &&
      typeof service.workspace.restore === 'function' &&
      typeof service.workspace.flush === 'function' &&
      typeof service.workspace.list === 'function' &&
      typeof service.ports.list === 'function' &&
      typeof service.ports.onServerReady === 'function' &&
      typeof service.services.list === 'function' &&
      typeof service.capabilities.check === 'function' &&
      typeof service.on === 'function' &&
      typeof service.reconfigure === 'function' &&
      typeof service.dispose === 'function' &&
      typeof service.shutdown === 'function';
    add(checks, 'ctx.succinix service surface', surfaceOk);

    const node = await ctx.succinix.executor.exec('node -e "console.log(21*2)"', { timeoutMs: 30000 });
    add(checks, 'node executes in the container', node.ok && node.exitCode === 0 && String(node.stdout ?? '').includes('42'), String(node.stdout ?? '').trim());

    const lifo = await ctx.succinix.executor.exec('echo lifo-ok', { timeoutMs: 30000 });
    add(checks, 'lifo executes in the container', lifo.ok && String(lifo.stdout ?? '').includes('lifo-ok'), String(lifo.stdout ?? '').trim());

    if (!wc) throw new Error('boot did not return a WebContainer');
    await ensurePythonRuntime(wc);
    const python = await ctx.succinix.executor.exec('python -c "print(6*7)"', { timeoutMs: 120000 });
    add(checks, 'python executes via packaged assets', python.ok && String(python.stdout ?? '').includes('42'), String(python.stdout ?? '').trim());

    const terminalOutput: string[] = [];
    const session = ctx.succinix.terminal.create({
      write: (data) => terminalOutput.push(data),
      clear: () => {},
    });
    const terminalRun = await session.rpc.exec('echo terminal-ok', {}, 30000);
    add(checks, 'terminal.create returns a working session', terminalRun.ok && String(terminalRun.stdout ?? '').includes('terminal-ok'), String(terminalRun.stdout ?? '').trim());

    const second = await ctx.succinix.ensureInstance('second', {
      persistence: { dbName: 'cordis-app-contract', storeKey: `${storeKey}-second` },
      home: '/workspace/second',
      executor: {},
    });
    add(
      checks,
      'ensureInstance reuses the page host',
      ctx.succinix.getInstance('second') === second &&
        ctx.succinix.container.wc === wc &&
        ctx.succinix.state.host.startedAt === startedAt
    );

    const port = 4821;
    const portEventPromise = waitForEvent<SuccinixPortEvent>(
      (handler) => ctx.succinix.on('succinix/server-ready', handler),
      (payload) => payload.port === port,
      30000
    );
    const spawned = await ctx.succinix.executor.spawn(
      `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port})"`,
      { timeoutMs: 15000 }
    );
    const portEvent = await portEventPromise;
    add(checks, 'port subscription delivers server-ready', portEvent?.port === port, JSON.stringify(portEvent));
    add(checks, 'ports view contains the ready port', ctx.succinix.ports.ready(port) !== undefined);
    if (spawned.ok && spawned.pid) await ctx.succinix.executor.kill(spawned.pid);

    await wc.fs.mkdir('/workspace/demo', { recursive: true });
    await wc.fs.writeFile('/workspace/demo/contract.txt', 'original');
    const saveResult = await ctx.succinix.snapshot.save(true);
    add(checks, 'snapshot save succeeds', !saveResult.skipped && saveResult.reason !== 'over-limit', saveResult.reason);
    await wc.fs.writeFile('/workspace/demo/contract.txt', 'changed');
    await ctx.succinix.workspace.restore();
    const restored = await wc.fs.readFile('/workspace/demo/contract.txt', 'utf8');
    add(checks, 'workspace restore restores snapshot', restored === 'original', restored);
    await ctx.succinix.workspace.flush('contract');
    const workspaceList = await ctx.succinix.workspace.list();
    add(checks, 'workspace list returns instance metadata', Array.isArray(workspaceList) && workspaceList.length >= 1);

    await ctx.succinix.services.ensureFiles();
    await ctx.succinix.services.add(
      'contract-svc',
      `node -e "require('http').createServer((q,s)=>s.end('service-ok')).listen(4822)"`,
      4822
    );
    const serviceStart = await ctx.succinix.services.start('contract-svc');
    add(checks, 'declarative service starts', serviceStart.ok === true, serviceStart.message);
    const serviceStatus = await ctx.succinix.services.status('contract-svc');
    add(checks, 'declarative service reports running', serviceStatus.state === 'running');
    await ctx.succinix.services.stop('contract-svc');

    await expectMismatch(() => ctx.succinix.attach(ctx.succinix.container.wc as WebContainer), checks, 'attach after boot throws ERR_MODE_MISMATCH');
  });

  await withSection(checks, 'reload', async () => {
    if (!engineFiber) throw new Error('engine fiber is not loaded');
    const beforeRevision = ctx.succinix.state.configRevision;
    const beforeStartedAt = ctx.succinix.state.host.startedAt;
    await ctx.succinix.reconfigure({ ...config, terminal: { timeoutMs: 45000, bootGate: false } });
    add(checks, 'reconfigure increments configRevision', ctx.succinix.state.configRevision === beforeRevision + 1, `rev=${ctx.succinix.state.configRevision}`);
    engineFiber.update({ ...config, terminal: { timeoutMs: 45000, bootGate: false } });
    await engineFiber;
    await ctx.succinix.boot();
    await ctx.succinix.ensureInstance('demo', {
      persistence: { dbName: 'cordis-app-contract', storeKey: `${storeKey}-reload` },
      home: '/workspace/demo',
      executor: {},
    });
    const reloadCheck = await ctx.succinix.executor.exec('echo reload-ok', { timeoutMs: 30000 });
    add(
      checks,
      'reload preserves the host and restores service',
      ctx.succinix.state.host.startedAt === beforeStartedAt &&
        ctx.succinix.state.containerState === 'ready' &&
        reloadCheck.ok &&
        String(reloadCheck.stdout ?? '').includes('reload-ok'),
      String(reloadCheck.stdout ?? '').trim()
    );
  });

  await withSection(checks, 'shutdown and external mode', async () => {
    if (!engineFiber) throw new Error('engine fiber is not loaded');
    await ctx.succinix.shutdown();
    add(checks, 'shutdown disposes container state', ctx.succinix.state.containerState === 'disposed');
    let executorUnavailable = false;
    try {
      ctx.succinix.executor;
    } catch {
      executorUnavailable = true;
    }
    add(checks, 'service access fails after shutdown', executorUnavailable);

    const externalConfig: SuccinixConfig = {
      ...config,
      container: { ...config.container, mode: 'external' },
      defaultInstance: { ...config.defaultInstance, persistence: { dbName: 'cordis-app-contract', storeKey: `${storeKey}-external` } },
    };
    engineFiber.update(externalConfig);
    await engineFiber;
    if (!wc) throw new Error('external mode needs the booted WebContainer');
    await ctx.succinix.attach(wc);
    add(checks, 'external attach reaches ready', ctx.succinix.state.containerState === 'ready');
    await expectMismatch(() => ctx.succinix.boot(), checks, 'boot after attach throws ERR_MODE_MISMATCH');
    await ctx.succinix.shutdown();
    await engineFiber.dispose();
    add(checks, 'service is gone after fiber dispose', ctx.get('succinix', false) === undefined);

    const restoredCtx = new Context();
    const restoredFiber = restoredCtx.plugin(enginePlugin, baseConfig(`${storeKey}-restored`));
    await restoredFiber;
    add(checks, 'reapply restores the service', !!restoredCtx.get('succinix', false));
    await restoredFiber.dispose();
  });

  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;
  return { checks, passed, failed };
}
