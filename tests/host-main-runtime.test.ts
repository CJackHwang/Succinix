import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const files = new Map<string, string>();
  const intervals: Array<{ callback: () => unknown; delay: number }> = [];
  const timeouts: Array<{ callback: () => unknown; delay: number }> = [];
  const commandRun = vi.fn();
  const sandbox = {
    cwd: '/workspace',
    env: {},
    shell: {
      getRegistry: vi.fn(() => ({ resolve: vi.fn(async () => ({ name: 'lifo' })) })),
      getJobTable: vi.fn(() => ({ list: () => [] })),
    },
    kernel: {
      vfs: { exists: vi.fn(() => false), readFileString: vi.fn(() => ''), writeFile: vi.fn() },
      processRegistry: { getRunning: vi.fn(() => []), getAll: vi.fn(() => []) },
      serviceManager: { bootEnabledServices: vi.fn(async () => undefined), listUnits: vi.fn(() => []) },
    },
    commands: { run: commandRun },
    destroy: vi.fn(),
  };
  return {
    files,
    intervals,
    timeouts,
    commandRun,
    sandbox,
    fs: {
      existsSync: vi.fn((path: string) => files.has(path)),
      readFileSync: vi.fn((path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return value;
      }),
      writeFileSync: vi.fn((path: string, value: string) => { files.set(path, value); }),
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn((path: string) => { files.delete(path); }),
      rmSync: vi.fn(),
    },
    writeResult: vi.fn(),
    writeAck: vi.fn(),
    writeProtocolError: vi.fn(),
    beginRequest: vi.fn(),
    dispatchSpawn: vi.fn(),
    dispatchPs: vi.fn(async () => undefined),
    dispatchKill: vi.fn(async () => undefined),
    dispatchSetCwd: vi.fn(),
    spawnChild: vi.fn(),
    runPython: vi.fn(async () => undefined),
    setCurrentInstanceId: vi.fn(),
    createSandbox: vi.fn(async () => sandbox),
  };
});

vi.mock('node:fs', () => ({ ...state.fs, default: state.fs }));
vi.mock('../src/engine/lifo-core.js', () => ({
  Sandbox: { create: state.createSandbox },
  rehydrateGlobalPackages: vi.fn(),
  runGitCommand: vi.fn(),
}));
vi.mock('../src/engine/host/rpc.js', () => ({
  CMD_FILE: 'cmd.json',
  beginRequest: state.beginRequest,
  writeAck: state.writeAck,
  writeProtocolError: state.writeProtocolError,
  writeResult: state.writeResult,
  pruneStaleResults: vi.fn(),
  instanceOf: (request: { instanceId?: string }) => request.instanceId ?? 'default',
}));
vi.mock('../src/engine/host/config.js', () => ({
  getSessionCwd: vi.fn(() => '/workspace'),
  setSessionCwd: vi.fn(),
  persistedEnv: vi.fn(() => ({})),
  setCurrentInstanceId: state.setCurrentInstanceId,
  currentInstanceId: vi.fn(() => 'default'),
}));
vi.mock('../src/engine/rpc-v2.js', () => ({
  BoundedProcessedIds: class {
    ids = new Set<string | number>();
    has(id: string | number) { return this.ids.has(id); }
    add(id: string | number) { this.ids.add(id); }
  },
  RPC_HOST_EPOCH_FILE: '/host-epoch.json',
  RPC_PROTOCOL_VERSION: 2,
  isRpcHostEpoch: (value: unknown): value is { bootNonce: string } => Boolean(value && typeof value === 'object' && typeof (value as { bootNonce?: unknown }).bootNonce === 'string'),
  isValidRpcRequestId: (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id),
}));
vi.mock('../src/engine/host/terminal.js', () => ({
  RpcTerminal: class {},
  TerminalMailboxHost: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock('../src/engine/host-procs.js', () => ({
  PROCESS_TERMINATION_GRACE_MS: 1,
  terminateProcessesForInstance: vi.fn(),
}));
vi.mock('../src/terminal/transport-protocol.js', () => ({ TERMINAL_MAILBOX_ROOT: '/.succinix-terminal' }));
vi.mock('../src/engine/host/ps-kill.js', () => ({
  dispatchPs: state.dispatchPs,
  dispatchKill: state.dispatchKill,
  dispatchResetInstance: vi.fn(async () => undefined),
  dispatchInterrupt: vi.fn(),
  dispatchSetCwd: state.dispatchSetCwd,
}));
vi.mock('../src/engine/host/spawn.js', () => ({ spawnChild: state.spawnChild }));
vi.mock('../src/engine/host/run-python.js', () => ({ runPython: state.runPython }));
vi.mock('../src/engine/host-route.js', () => ({
  WORKSPACE_MOUNT: '/workspace',
  browserPathToLifoCwd: (path: string) => path,
  canonicalizeVirtualPath: (path: string) => path,
  classifyPrefix: (command: string) => command.startsWith('node') ? 'node' : command.startsWith('python') ? 'python' : 'lifo',
  classifyRoute: (command: string) => command.startsWith('node') ? 'node' : command.startsWith('python') ? 'python' : 'lifo',
  mapDataDirArgs: (tokens: string[]) => tokens,
  lifoCwdToSessionCwd: (cwd: string) => cwd,
  capOutput: (value: string) => value,
  instanceStateRootFor: (instanceId: string, root: string) => `${root}/.succinix-${instanceId}`,
  instanceStateFile: (_instanceId: string, root: string, path: string) => `${root}/${path}`,
}));
vi.mock('../src/engine/terminal-hub.js', () => ({
  TerminalHub: class {
    runBatch = async <T>(work: () => Promise<T>) => work();
    dispose = vi.fn();
  },
}));
vi.mock('../src/engine/host/real-binaries.js', () => ({ registerRealBinaryCommands: vi.fn() }));
vi.mock('../src/engine/host/userland.js', () => ({
  createSandboxUserlandRegistry: vi.fn(() => ({ listPackages: () => [] })),
  applyUserlandRegistryToSandbox: vi.fn(() => vi.fn()),
}));
vi.mock('../src/userland/index.js', () => ({ USERLAND_REGISTRY_PATH: '/.succinix-userland.json', parseUserlandRegistrySnapshot: vi.fn() }));
vi.mock('../src/engine/host/service-world.js', () => ({ restoreServiceEnablement: vi.fn() }));
vi.mock('../src/engine/host/process-world.js', () => ({
  LifoProcessProjection: class {
    forgetInstance = vi.fn();
    project = vi.fn(() => []);
    resolve = vi.fn();
  },
}));
vi.mock('../src/engine/host/process-commands.js', () => ({
  killProjectedLifoProcess: vi.fn(async () => null),
  listProjectedLifoProcesses: vi.fn(async () => []),
}));
vi.mock('../src/engine/host/terminal-context.js', () => ({
  attachTerminalContext: vi.fn(),
  detachTerminalContext: vi.fn(async () => undefined),
}));
vi.mock('../src/engine/host/state-mounts.js', () => ({
  mountPersistentLifoState: vi.fn(),
  persistentLifoMounts: vi.fn(() => ({})),
}));
vi.mock('../src/engine/host/package-world.js', () => ({
  installPackageManifestTracking: vi.fn(),
  reconcileRegisteredUserlandPackages: vi.fn(async () => undefined),
}));
vi.mock('../src/engine/host/control.js', () => ({ requestBrowserControl: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function loadHostModules() {
  vi.resetModules();
  const run = await import('../src/engine/host/run.js');
  const main = await import('../src/engine/host/main.js');
  return { run, main };
}

function poller() {
  const interval = state.intervals.filter((item) => item.delay === 50).at(-1);
  if (!interval) throw new Error('host RPC polling interval was not installed');
  if (!String(interval.callback).includes('CMD_FILE')) throw new Error(`unexpected 50ms callback: ${String(interval.callback)}`);
  return interval.callback;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.files.clear();
  state.intervals.splice(0);
  state.timeouts.splice(0);
  state.files.set('host-epoch.json', JSON.stringify({ bootNonce: 'epoch-current' }));
  state.commandRun.mockReset();
  state.commandRun.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });
  state.createSandbox.mockClear();
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => unknown, delay: number) => {
    state.intervals.push({ callback, delay });
    return {} as NodeJS.Timeout;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => unknown, delay: number) => {
    state.timeouts.push({ callback, delay });
    return {} as NodeJS.Timeout;
  }) as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('execution-world host epoch and scheduler', () => {
  it('routes host commands and fences stale or duplicate batch requests', async () => {
    const { main } = await loadHostModules();
    await main.handleCommand({ id: 'direct-ping', protocolVersion: 2, bootNonce: 'epoch-current', cmd: 'ping', instanceId: 'alpha' } as never);
    await main.handleCommand({ id: 'direct-cwd', protocolVersion: 2, bootNonce: 'epoch-current', cmd: 'cwd', instanceId: 'alpha' } as never);
    await main.handleCommand({ id: 'direct-unknown', protocolVersion: 2, bootNonce: 'epoch-current', cmd: 'unknown', instanceId: 'alpha' } as never);
    expect(state.writeResult).toHaveBeenCalledWith('direct-ping', { ok: true, kind: 'pong' }, 'alpha');
    expect(state.writeResult).toHaveBeenCalledWith('direct-cwd', expect.objectContaining({ ok: true, kind: 'cwd' }), 'alpha');
    expect(state.writeResult).toHaveBeenCalledWith('direct-unknown', { ok: false, error: 'unknown command: unknown' }, 'alpha');

    state.files.set('cmd.json', JSON.stringify({ id: 'rpc-1', protocolVersion: 2, bootNonce: 'epoch-current', cmd: 'ping', instanceId: 'alpha' }));
    await poller()();
    expect(state.fs.existsSync).toHaveBeenCalledWith('cmd.json');
    expect(state.beginRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 'rpc-1', bootNonce: 'epoch-current' }));
    expect(state.writeAck).toHaveBeenCalledWith(expect.objectContaining({ id: 'rpc-1' }));
    expect(state.files.has('cmd.json')).toBe(false);

    state.files.set('cmd.json', JSON.stringify({ id: 'rpc-stale', protocolVersion: 2, bootNonce: 'epoch-old', cmd: 'ping', instanceId: 'alpha' }));
    await poller()();
    expect(state.writeProtocolError).toHaveBeenCalledWith(expect.objectContaining({ code: 'STALE_BOOT_NONCE' }), 'rpc-stale', 'epoch-old', undefined);

    state.files.set('cmd.json', JSON.stringify({ id: 'rpc-1', protocolVersion: 2, bootNonce: 'epoch-current', cmd: 'ping', instanceId: 'alpha' }));
    await poller()();
    expect(state.writeAck).toHaveBeenCalledTimes(2);

    state.files.set('cmd.json', '{');
    await poller()();
    expect(state.writeProtocolError).toHaveBeenCalledWith(expect.objectContaining({ code: 'MALFORMED_JSON' }), undefined, undefined, undefined);

    state.files.set('cmd.json', JSON.stringify({ id: '../invalid', protocolVersion: 2, bootNonce: 'epoch-current', cmd: 'ping' }));
    await poller()();
    expect(state.writeProtocolError).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_REQUEST_ID' }), undefined, undefined, undefined);

    state.files.set('cmd.json', JSON.stringify({ id: 'rpc-v1', protocolVersion: 1, bootNonce: 'epoch-current', cmd: 'ping' }));
    await poller()();
    expect(state.writeProtocolError).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNSUPPORTED_PROTOCOL' }), 'rpc-v1', 'epoch-current', undefined);

    state.files.set('cmd.json', JSON.stringify({ id: 'rpc-missing-nonce', protocolVersion: 2, cmd: 'ping' }));
    await poller()();
    expect(state.writeProtocolError).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_REQUEST' }), 'rpc-missing-nonce', undefined, undefined);

    const heldRun = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    state.commandRun.mockReset();
    state.commandRun.mockImplementationOnce(() => heldRun.promise);
    state.files.set('cmd.json', JSON.stringify({ id: 'rpc-held-run', protocolVersion: 2, bootNonce: 'epoch-current', cmd: 'run', opts: { command: 'echo held' }, instanceId: 'alpha' }));
    const normalRun = poller()();
    await vi.waitFor(() => expect(state.commandRun).toHaveBeenCalledTimes(1));
    state.files.set('cmd.json', JSON.stringify({ id: 'rpc-priority-ping', protocolVersion: 2, bootNonce: 'epoch-current', cmd: 'ping', instanceId: 'alpha' }));
    await poller()();
    await vi.waitFor(() => expect(state.writeAck).toHaveBeenCalledWith(expect.objectContaining({ id: 'rpc-priority-ping' })));
    heldRun.resolve({ exitCode: 0, stdout: 'held', stderr: '' });
    await normalRun;
  });

  it('uses the instance scheduler for Lifo work while preserving direct runtime routes', async () => {
    const { run } = await loadHostModules();
    await run.dispatchRun({ id: 'empty', opts: { command: ' ' }, instanceId: 'alpha' } as never);
    await run.dispatchRun({ id: 'heredoc', opts: { command: 'cat <<EOF\nvalue\nEOF' }, instanceId: 'alpha' } as never);
    await run.dispatchRun({ id: 'bad-token', opts: { command: 'node "unterminated' }, instanceId: 'alpha' } as never);
    await run.dispatchRun({ id: 'node', opts: { command: 'node --version' }, instanceId: 'alpha' } as never);
    await run.dispatchRun({ id: 'python', opts: { command: 'python --version' }, instanceId: 'alpha' } as never);
    await run.dispatchRun({ id: 'bad-cwd', opts: { command: 'echo value', cwd: 'relative' }, instanceId: 'alpha' } as never);
    expect(state.spawnChild).toHaveBeenCalledWith('node', ['--version'], { command: 'node --version' }, 'node', 'node', 'alpha');
    expect(state.runPython).toHaveBeenCalledWith('python --version', { command: 'python --version' }, 'python', 'alpha');
    expect(state.writeResult).toHaveBeenCalledWith('bad-cwd', expect.objectContaining({ stderr: 'cwd must be an absolute path' }), 'alpha');

    const first = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    state.commandRun.mockReset();
    state.commandRun.mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ exitCode: 0, stdout: 'second', stderr: '' });
    const firstRun = run.dispatchRun({ id: 'first', opts: { command: 'echo first' }, instanceId: 'alpha' } as never);
    await vi.waitFor(() => expect(state.createSandbox).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(state.sandbox.shell.getRegistry).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.commandRun).toHaveBeenCalledTimes(1));
    const secondRun = run.dispatchRun({ id: 'second', opts: { command: 'echo second' }, instanceId: 'alpha' } as never);
    await Promise.resolve();
    expect(state.commandRun).toHaveBeenCalledTimes(1);
    expect(run.interruptLifoRun('alpha')).toBe(true);
    first.resolve({ exitCode: 0, stdout: 'first', stderr: '' });
    await Promise.all([firstRun, secondRun]);
    expect(state.commandRun).toHaveBeenCalledTimes(2);
    expect(state.writeResult).toHaveBeenCalledWith('first', expect.objectContaining({ stdout: 'first', runtime: 'lifo' }), 'alpha');
    expect(state.writeResult).toHaveBeenCalledWith('second', expect.objectContaining({ stdout: 'second', runtime: 'lifo' }), 'alpha');

    state.commandRun.mockResolvedValueOnce({ exitCode: 7, stdout: 'partial', stderr: 'failed' });
    await run.dispatchRun({ id: 'nonzero', opts: { command: 'echo nonzero', env: { VALID: 42, 'bad-key': 'ignored' } }, instanceId: 'alpha' } as never);
    expect(state.commandRun).toHaveBeenLastCalledWith('echo nonzero', expect.objectContaining({ env: { VALID: '42' } }));
    expect(state.writeResult).toHaveBeenCalledWith('nonzero', expect.objectContaining({ ok: false, exitCode: 7, stdout: 'partial', stderr: 'failed' }), 'alpha');

    state.commandRun.mockRejectedValueOnce(new Error('sandbox failure'));
    await run.dispatchRun({ id: 'throws', opts: { command: 'echo throws' }, instanceId: 'alpha' } as never);
    expect(state.writeResult).toHaveBeenCalledWith('throws', expect.objectContaining({ ok: false, exitCode: -1, stderr: expect.stringContaining('sandbox failure') }), 'alpha');
  });

  it('does not release the host command slot before a direct Node child settles', async () => {
    await loadHostModules();
    const child = deferred<void>();
    state.spawnChild.mockImplementationOnce(() => child.promise);
    state.files.set('cmd.json', JSON.stringify({ id: 'node-long', protocolVersion: 2, bootNonce: 'epoch-current', cmd: 'run', opts: { command: 'node long.js' }, instanceId: 'alpha' }));
    const nodeRun = poller()();
    await vi.waitFor(() => expect(state.spawnChild).toHaveBeenCalledTimes(1));

    state.files.set('cmd.json', JSON.stringify({ id: 'lifo-after-node', protocolVersion: 2, bootNonce: 'epoch-current', cmd: 'run', opts: { command: 'echo after-node' }, instanceId: 'alpha' }));
    await poller()();
    expect(state.commandRun).not.toHaveBeenCalled();

    child.resolve();
    await nodeRun;
    await poller()();
    expect(state.commandRun).toHaveBeenCalledWith('echo after-node', expect.any(Object));
  });
});
