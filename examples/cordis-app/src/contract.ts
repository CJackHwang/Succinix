import { Context, type Fiber, type FiberState } from '@deepseek-ai/cordis';
import enginePlugin, {
  ensurePythonRuntime,
  FsError,
  SandboxUnavailableError,
  SessionId,
  TerminalSessionId,
  type Agent,
  type SessionEvent,
  type SessionHeader,
  type SuccinixConfig,
  type SuccinixHostService,
  type SuccinixPortEvent,
} from '@succinix/engine';
import type { WebContainer } from '@webcontainer/api';
import { runMigrationSurface } from './migration';

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

// Cordis 4.0.1 compiles FiberState as a const enum, so the runtime bundle
// does not export the value. Keep the comparison type-safe with the literal.
const FIBER_STATE_ACTIVE: FiberState = 2;

function add(checks: ContractCheck[], name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
}

function hostOf(ctx: Context): SuccinixHostService {
  const host = ctx.get('succinix-host', false) as SuccinixHostService | undefined;
  if (!host) throw new Error('succinix-host service is not available');
  return host;
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

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof FsError ? error.code : String(error);
  }
}

function sandboxCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof SandboxUnavailableError ? error.code : String(error);
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
    add(checks, 'fiber reaches ACTIVE', fiber.state === FIBER_STATE_ACTIVE, String(fiber.state));

    const host = hostOf(ctx);
    const injected: Record<string, unknown> = {};
    const consumerFiber = ctx.plugin({
      name: 'contract-consumer',
      inject: ['fs', 'sandbox', 'terminals', 'sessionPersistence'],
      apply(consumerCtx: Context) {
        injected.fs = consumerCtx.fs;
        injected.sandbox = consumerCtx.sandbox;
        injected.terminals = consumerCtx.terminals;
        injected.sessionPersistence = consumerCtx.sessionPersistence;
        consumerCtx.on('succinix/state', (payload: { reason: string }) => stateEvents.push(payload.reason));
      },
    });
    await consumerFiber;
    add(
      checks,
      'inject: [fs, sandbox, terminals, sessionPersistence] resolves',
      injected.fs === host.fs &&
        injected.sandbox === host.sandbox &&
        injected.terminals === host.terminals &&
        injected.sessionPersistence === host.sessionPersistence
    );

    const fallbackCtx = new Context();
    const fallbackValues: Record<string, unknown> = {};
    const fallbackFiber = fallbackCtx.plugin({
      name: 'contract-fallback',
      apply(consumerCtx: Context) {
        fallbackValues.host = consumerCtx.get('succinix-host', false);
        fallbackValues.fs = consumerCtx.get('fs', false);
        fallbackValues.sandbox = consumerCtx.get('sandbox', false);
        fallbackValues.terminals = consumerCtx.get('terminals', false);
        fallbackValues.sessionPersistence = consumerCtx.get('sessionPersistence', false);
      },
    });
    await fallbackFiber;
    add(
      checks,
      'uninjected dsh fallbacks are explicit',
      fallbackValues.host === undefined &&
        fallbackValues.fs === undefined &&
        fallbackValues.sandbox === undefined &&
        fallbackValues.terminals === undefined &&
        fallbackValues.sessionPersistence === undefined
    );
    await fallbackFiber.dispose();

    const migration = await runMigrationSurface(`${storeKey}-migration`);
    add(checks, 'migration example runs', migration.ok, migration.detail);

    const capabilityMatch =
      host.capabilities.list().length === EXPECTED_CAPABILITIES.length &&
      host.capabilities.list().every((name, index) => name === EXPECTED_CAPABILITIES[index]);
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
    const host = hostOf(ctx);
    const booted = await host.boot();
    wc = booted;
    startedAt = host.state.host.startedAt;
    add(checks, 'internal boot reaches ready', host.state.containerState === 'ready' && host.container.state === 'ready');
    add(checks, 'state event includes ready', stateEvents.includes('ready'));

    await host.ensureInstance('demo', {
      persistence: { dbName: 'cordis-app-contract', storeKey },
      home: '/workspace/demo',
      executor: {},
    });
    add(checks, 'default instance is available', host.instance?.instanceId === 'demo');

    const surfaceOk =
      ctx.fs.sandboxMode === 'workspace-write' &&
      typeof ctx.fs.resolve === 'function' &&
      typeof ctx.fs.processPath === 'function' &&
      typeof ctx.fs.fileUrl === 'function' &&
      typeof ctx.fs.contains === 'function' &&
      typeof ctx.fs.stat === 'function' &&
      typeof ctx.fs.lstat === 'function' &&
      typeof ctx.fs.readText === 'function' &&
      typeof ctx.fs.streamText === 'function' &&
      typeof ctx.fs.readBytes === 'function' &&
      typeof ctx.fs.listDir === 'function' &&
      typeof ctx.fs.writeText === 'function' &&
      typeof ctx.fs.editText === 'function' &&
      typeof ctx.sandbox.confine === 'function' &&
      typeof ctx.terminals.registerBackend === 'function' &&
      typeof ctx.terminals.listBackends === 'function' &&
      typeof ctx.terminals.spawn === 'function' &&
      typeof ctx.terminals.hasOwnerActivity === 'function' &&
      typeof ctx.terminals.startSend === 'function' &&
      typeof ctx.terminals.read === 'function' &&
      typeof ctx.terminals.signal === 'function' &&
      typeof ctx.terminals.kill === 'function' &&
      typeof ctx.terminals.list === 'function' &&
      ctx.sessionPersistence.supportsRawArtifacts === true &&
      typeof ctx.sessionPersistence.locate === 'function' &&
      typeof ctx.sessionPersistence.readRaw === 'function' &&
      typeof ctx.sessionPersistence.create === 'function' &&
      typeof ctx.sessionPersistence.append === 'function' &&
      typeof ctx.sessionPersistence.prepare === 'function' &&
      typeof ctx.sessionPersistence.load === 'function' &&
      typeof ctx.sessionPersistence.inspect === 'function' &&
      typeof ctx.sessionPersistence.readFrom === 'function' &&
      typeof ctx.sessionPersistence.list === 'function' &&
      typeof ctx.sessionPersistence.listSnapshots === 'function';
    add(checks, 'dsh service surface is complete', surfaceOk);

    const node = await host.executor.exec('node -e "console.log(21*2)"', { timeoutMs: 30000 });
    add(checks, 'node executes in the container', node.ok && node.exitCode === 0 && String(node.stdout ?? '').includes('42'), String(node.stdout ?? '').trim());

    const lifo = await host.executor.exec('echo lifo-ok', { timeoutMs: 30000 });
    add(checks, 'lifo executes in the container', lifo.ok && String(lifo.stdout ?? '').includes('lifo-ok'), String(lifo.stdout ?? '').trim());

    if (!wc) throw new Error('boot did not return a WebContainer');
    await ensurePythonRuntime(wc, config.pythonAssetsUrl);
    const python = await host.executor.exec('python -c "print(6*7)"', { timeoutMs: 120000 });
    add(checks, 'python executes via packaged assets', python.ok && String(python.stdout ?? '').includes('42'), String(python.stdout ?? '').trim());

    const agent: Agent = { id: SessionId('contract-agent'), status: 'idle', ctx: {} };
    host.registerAgent(agent);
    const backends = ctx.terminals.listBackends();
    add(checks, 'terminals registers the succinix backend', backends.includes('succinix'), backends.join(','));
    const spawnedTerminal = await ctx.terminals.spawn(agent, { type: 'succinix', name: 'dsh-terminal' });
    add(checks, 'terminals spawn publishes a session', spawnedTerminal.sessionId.startsWith('pty-') && spawnedTerminal.type === 'succinix');
    const send = ctx.terminals.startSend(agent, spawnedTerminal.sessionId, {
      text: 'echo terminal-dsh-ok',
      submit: true,
    });
    const sendResult = await send.done;
    const terminalText = ctx.terminals.read(agent, spawnedTerminal.sessionId, { count: 100 }).text;
    add(
      checks,
      'terminals startSend and read capture output',
      sendResult.sessionStatus.kind === 'running' && terminalText.includes('terminal-dsh-ok'),
      terminalText.slice(0, 160)
    );
    add(checks, 'terminals hasOwnerActivity tracks the owner', ctx.terminals.hasOwnerActivity(agent));
    const killResult = await ctx.terminals.kill(agent, spawnedTerminal.sessionId, 'contract complete');
    add(checks, 'terminals kill closes the session', killResult === true && ctx.terminals.list(agent).length === 0);
    host.unregisterAgent(agent);

    // ctx.fs displays Lifo /workspace paths; the browser wc.fs root maps
    // /workspace/demo to /demo.
    await wc.fs.mkdir('/demo', { recursive: true });
    const fileTarget = await ctx.fs.resolve('/workspace/demo/dsh-contract.txt');
    const created = await ctx.fs.writeText(fileTarget, 'alpha\n');
    const readBack = await ctx.fs.readText(fileTarget);
    const edited = await ctx.fs.editText(fileTarget, { oldString: 'alpha', newString: 'beta', replaceAll: false });
    const fileInfo = await ctx.fs.stat(fileTarget);
    const entries = await ctx.fs.listDir(await ctx.fs.resolve('/workspace/demo'));
    const missingTarget = await ctx.fs.resolve('/workspace/demo/does-not-exist.txt');
    const missingCode = await codeOf(ctx.fs.readText(missingTarget));
    const deniedCode = await codeOf(
      ctx.fs.writeText(fileTarget, 'denied', undefined, undefined, { mode: 'read-only', workspaceRoot: '/workspace' })
    );
    const editNotFoundCode = await codeOf(
      ctx.fs.editText(fileTarget, { oldString: 'missing', newString: 'x', replaceAll: false })
    );
    add(
      checks,
      'fs write/read/edit round-trips',
      created.operation === 'create' &&
        created.before === null &&
        readBack === 'alpha\n' &&
        edited.after === 'beta\n' &&
        (await ctx.fs.readText(fileTarget)) === 'beta\n'
    );
    add(checks, 'fs stat and listDir report the file', fileInfo?.type === 'file' && entries.some((entry) => entry.name === 'dsh-contract.txt'));
    add(checks, 'fs errors are structured', missingCode === 'FS_NOT_FOUND' && deniedCode === 'FS_SANDBOX_DENIED' && editNotFoundCode === 'FS_EDIT_NOT_FOUND');

    const confined = ctx.sandbox.confine(['echo', 'sandbox-ok'], { mode: 'read-only', workspaceRoot: '/workspace' });
    const nodeSandboxCode = sandboxCode(() =>
      ctx.sandbox.confine(['node', '--version'], { mode: 'read-only', workspaceRoot: '/workspace' })
    );
    add(
      checks,
      'sandbox confines lifo argv and fails closed for node',
      confined.argv[0] === 'succinix-sandbox' &&
        confined.enforcement === 'full' &&
        confined.denialSignatures.length > 0 &&
        nodeSandboxCode === 'SANDBOX_UNAVAILABLE'
    );

    const sessionId = SessionId('contract-session');
    const sessionMeta: SessionHeader = { version: 0, id: sessionId, createdAt: Date.now() };
    const sessionEvent: SessionEvent = { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 0 } };
    await ctx.sessionPersistence.create(sessionMeta);
    await ctx.sessionPersistence.append(sessionId, [sessionEvent]);
    const persistedList = await ctx.sessionPersistence.list();
    const persistedEvents = await ctx.sessionPersistence.readFrom(sessionId, 0);
    const rawArtifact = await ctx.sessionPersistence.readRaw(sessionId);
    const location = ctx.sessionPersistence.locate(sessionMeta);
    add(
      checks,
      'sessionPersistence appends and lists events',
      persistedList.some((header) => header.id === sessionId) &&
        persistedEvents.events.length === 1 &&
        persistedEvents.events[0]?.type === 'turn/start' &&
        (rawArtifact?.content.includes('turn/start') ?? false) &&
        location?.path.includes('.jsonl') === true
    );

    const second = await host.ensureInstance('second', {
      persistence: { dbName: 'cordis-app-contract', storeKey: `${storeKey}-second` },
      home: '/workspace/second',
      executor: {},
    });
    add(
      checks,
      'ensureInstance reuses the page host',
      host.getInstance('second') === second &&
        host.container.wc === wc &&
        host.state.host.startedAt === startedAt
    );

    const port = 4821;
    const portEventPromise = waitForEvent<SuccinixPortEvent>(
      (handler) => host.on('succinix/server-ready', handler),
      (payload) => payload.port === port,
      30000
    );
    const spawned = await host.executor.spawn(
      `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port})"`,
      { timeoutMs: 15000 }
    );
    const portEvent = await portEventPromise;
    add(checks, 'port subscription delivers server-ready', portEvent?.port === port, JSON.stringify(portEvent));
    add(checks, 'ports view contains the ready port', host.ports.ready(port) !== undefined);
    if (spawned.ok && spawned.pid) await host.executor.kill(spawned.pid);

    await wc.fs.mkdir('/workspace/demo', { recursive: true });
    await wc.fs.writeFile('/workspace/demo/contract.txt', 'original');
    const saveResult = await host.snapshot.save(true);
    add(checks, 'snapshot save succeeds', !saveResult.skipped && saveResult.reason !== 'over-limit', saveResult.reason);
    await wc.fs.writeFile('/workspace/demo/contract.txt', 'changed');
    await host.workspace.restore();
    const restored = await wc.fs.readFile('/workspace/demo/contract.txt', 'utf8');
    add(checks, 'workspace restore restores snapshot', restored === 'original', restored);
    await host.workspace.flush('contract');
    const workspaceList = await host.workspace.list();
    add(checks, 'workspace list returns instance metadata', Array.isArray(workspaceList) && workspaceList.length >= 1);
    await host.persist.force(host.container.wc!.fs, 'contract');
    add(checks, 'persist.force executes explicitly', true);

    await host.services.ensureFiles();
    await host.services.add(
      'contract-svc',
      `node -e "require('http').createServer((q,s)=>s.end('service-ok')).listen(4822)"`,
      4822
    );
    const serviceStart = await host.services.start('contract-svc');
    add(checks, 'declarative service starts', serviceStart.ok === true, serviceStart.message);
    const serviceStatus = await host.services.status('contract-svc');
    add(checks, 'declarative service reports running', serviceStatus.state === 'running');
    await host.services.stop('contract-svc');

    await expectMismatch(() => host.attach(host.container.wc as WebContainer), checks, 'attach after boot throws ERR_MODE_MISMATCH');
  });

  await withSection(checks, 'reload', async () => {
    if (!engineFiber) throw new Error('engine fiber is not loaded');
    const beforeRevision = hostOf(ctx).state.configRevision;
    const beforeStartedAt = hostOf(ctx).state.host.startedAt;
    await hostOf(ctx).reconfigure({ ...config, terminal: { timeoutMs: 45000, bootGate: false } });
    add(checks, 'reconfigure increments configRevision', hostOf(ctx).state.configRevision === beforeRevision + 1, `rev=${hostOf(ctx).state.configRevision}`);
    await engineFiber.update({ ...config, terminal: { timeoutMs: 45000, bootGate: false } });
    add(
      checks,
      'fiber.update increments configRevision',
      hostOf(ctx).state.configRevision === beforeRevision + 2,
      `rev=${hostOf(ctx).state.configRevision}`
    );
    await hostOf(ctx).boot();
    await hostOf(ctx).ensureInstance('demo', {
      persistence: { dbName: 'cordis-app-contract', storeKey: `${storeKey}-reload` },
      home: '/workspace/demo',
      executor: {},
    });
    const reloadCheck = await hostOf(ctx).executor.exec('echo reload-ok', { timeoutMs: 30000 });
    add(
      checks,
      'reload preserves the host and restores service',
      hostOf(ctx).state.host.startedAt === beforeStartedAt &&
        hostOf(ctx).state.containerState === 'ready' &&
        reloadCheck.ok &&
        String(reloadCheck.stdout ?? '').includes('reload-ok'),
      String(reloadCheck.stdout ?? '').trim()
    );
  });

  await withSection(checks, 'restart-required fiber update', async () => {
    if (!engineFiber) throw new Error('engine fiber is not loaded');
    const beforeRevision = hostOf(ctx).state.configRevision;
    await engineFiber.update({ ...config, hostJsUrl: '/host.js?restart=1' });
    add(
      checks,
      'restart-required fiber.update shuts the host down',
      hostOf(ctx).state.configRevision === beforeRevision + 1 &&
        hostOf(ctx).state.host.startedAt === null &&
        ['disposed', 'unattached'].includes(hostOf(ctx).state.containerState),
      `rev=${hostOf(ctx).state.configRevision} state=${hostOf(ctx).state.containerState}`
    );
    await engineFiber.update(config);
  });

  await withSection(checks, 'shutdown and external mode', async () => {
    if (!engineFiber) throw new Error('engine fiber is not loaded');
    await hostOf(ctx).shutdown();
    add(checks, 'shutdown disposes container state', hostOf(ctx).state.containerState === 'disposed');
    let executorUnavailable = false;
    try {
      hostOf(ctx).executor;
    } catch {
      executorUnavailable = true;
    }
    add(checks, 'service access fails after shutdown', executorUnavailable);

    const externalConfig: SuccinixConfig = {
      ...config,
      container: { ...config.container, mode: 'external' },
      defaultInstance: { ...config.defaultInstance, persistence: { dbName: 'cordis-app-contract', storeKey: `${storeKey}-external` } },
    };
    await engineFiber.update(externalConfig);
    if (!wc) throw new Error('external mode needs the booted WebContainer');
    await hostOf(ctx).attach(wc);
    add(checks, 'external attach reaches ready', hostOf(ctx).state.containerState === 'ready');
    await expectMismatch(() => hostOf(ctx).boot(), checks, 'boot after attach throws ERR_MODE_MISMATCH');
    await hostOf(ctx).shutdown();
    await engineFiber.dispose();
    add(
      checks,
      'service is gone after fiber dispose',
      ctx.get('succinix-host', false) === undefined &&
        ctx.get('fs', false) === undefined &&
        ctx.get('sandbox', false) === undefined &&
        ctx.get('terminals', false) === undefined &&
        ctx.get('sessionPersistence', false) === undefined
    );

    const restoredCtx = new Context();
    const restoredFiber = restoredCtx.plugin(enginePlugin, baseConfig(`${storeKey}-restored`));
    await restoredFiber;
    add(
      checks,
      'reapply restores the service',
      !!restoredCtx.get('succinix-host', false) &&
        !!restoredCtx.get('fs', false) &&
        !!restoredCtx.get('sandbox', false) &&
        !!restoredCtx.get('terminals', false) &&
        !!restoredCtx.get('sessionPersistence', false)
    );
    await restoredFiber.dispose();
  });

  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;
  return { checks, passed, failed };
}
