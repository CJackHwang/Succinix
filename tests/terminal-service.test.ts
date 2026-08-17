// S0.6: owner-scoped dsh ctx.terminals registry and Succinix PTY backend.
import { describe, it, expect } from 'vitest';
import {
  TerminalBackendCleanupError,
  TerminalError,
  SessionId,
  TerminalSessionId,
  type Agent,
  type TerminalBackend,
  type TerminalBackendSession,
  type TerminalBackendSpawnSpec,
  type TerminalReadResult,
  type TerminalSendOperation,
  type TerminalSendRequest,
  type TerminalSendResult,
  type TerminalSessionStatus,
  type TerminalSignal,
  type TerminalSpawnRequest,
} from '../src/plugin/dsh-types.js';
import {
  SuccinixTerminalService,
  type TerminalServiceDeps,
} from '../src/plugin/terminal-service.js';
import { SuccinixTerminalBackend } from '../src/plugin/terminal-backend.js';
import type { InteractiveTerminalSession } from '../src/engine/index.js';

class OwnerRegistry {
  private readonly live = new Set<Agent>();
  private readonly handlers = new Map<Agent, Set<() => void | Promise<void>>>();

  register(owner: Agent): void {
    this.live.add(owner);
  }

  unregister(owner: Agent): void {
    this.live.delete(owner);
    for (const handler of [...(this.handlers.get(owner) ?? [])]) void handler();
  }

  isLive = (owner: Agent): boolean => this.live.has(owner);

  onOwnerDispose = (owner: Agent, handler: () => void | Promise<void>): (() => void) => {
    const set = this.handlers.get(owner) ?? new Set<() => void | Promise<void>>();
    set.add(handler);
    this.handlers.set(owner, set);
    return () => set.delete(handler);
  };

  deps(): TerminalServiceDeps {
    return { isOwnerLive: this.isLive, onOwnerDispose: this.onOwnerDispose };
  }
}

function owner(id = 'agent-1'): Agent {
  return { id: SessionId(id), status: 'idle', ctx: {} };
}

interface FakeSessionOptions {
  motd?: string;
  pid?: number;
  status?: TerminalSessionStatus;
  closeError?: Error;
  closeGate?: Promise<void>;
  signalError?: Error;
}

class FakeBackendSession implements TerminalBackendSession {
  readonly motd: string;
  readonly pid?: number;
  readonly sends: TerminalSendRequest[] = [];
  readonly signals: TerminalSignal[] = [];
  closes = 0;
  closed = false;
  private statusValue: TerminalSessionStatus;

  constructor(private readonly opts: FakeSessionOptions = {}) {
    this.motd = opts.motd ?? 'ready';
    this.pid = opts.pid;
    this.statusValue = opts.status ?? { kind: 'running' };
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    this.sends.push(request);
    const result: TerminalSendResult = {
      viewport: `out:${request.text}`,
      waitReason: 'stdin_read',
      sessionStatus: this.statusValue,
      truncated: false,
    };
    return {
      done: Promise.resolve(result),
      readOutput: () => ({ delta: request.text, truncated: false }),
      cancel: () => false,
    };
  }

  read(): TerminalReadResult {
    return { text: this.motd, totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false };
  }

  async signal(signal: TerminalSignal): Promise<{ delivered: true; targetPgid: number }> {
    this.signals.push(signal);
    if (this.opts.signalError) throw this.opts.signalError;
    return { delivered: true, targetPgid: 42 };
  }

  status(): TerminalSessionStatus {
    return this.statusValue;
  }

  async close(_reason: string): Promise<void> {
    this.closes++;
    this.closed = true;
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null };
    if (this.opts.closeGate) await this.opts.closeGate;
    if (this.opts.closeError) throw this.opts.closeError;
  }
}

interface FakeBackendOptions {
  type?: string;
  session?: FakeBackendSession;
  spawnError?: Error;
  spawnGate?: { signal: AbortSignal; ready: () => void };
  spawnCount?: number;
}

class FakeBackend implements TerminalBackend {
  readonly type: string;
  readonly sessions: FakeBackendSession[] = [];
  readonly specs: TerminalBackendSpawnSpec[] = [];
  spawnCalls = 0;
  private readonly opts: FakeBackendOptions;

  constructor(type = 'succinix', opts: FakeBackendOptions = {}) {
    this.type = type;
    this.opts = opts;
  }

  async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
    this.spawnCalls++;
    this.specs.push(spec);
    if (this.opts.spawnGate) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(spec.signal?.reason ?? this.opts.spawnGate!.signal.reason ?? new Error('aborted'));
        if (spec.signal?.aborted || this.opts.spawnGate!.signal.aborted) {
          onAbort();
          return;
        }
        spec.signal?.addEventListener('abort', onAbort, { once: true });
        this.opts.spawnGate!.signal.addEventListener('abort', onAbort, { once: true });
        this.opts.spawnGate!.ready = resolve;
      });
    }
    if (this.opts.spawnError) throw this.opts.spawnError;
    const session = this.opts.session ?? new FakeBackendSession();
    this.sessions.push(session);
    return session;
  }
}

function setup(options: { backend?: FakeBackend; owner?: Agent } = {}) {
  const registry = new OwnerRegistry();
  const service = new SuccinixTerminalService(registry.deps());
  const agent = options.owner ?? owner();
  registry.register(agent);
  const backend = options.backend ?? new FakeBackend();
  service.registerBackend(backend);
  return { registry, service, agent, backend };
}

function request(overrides: Partial<TerminalSpawnRequest> = {}): TerminalSpawnRequest {
  return { type: 'succinix', ...overrides };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ctx.terminals registry', () => {
  it('registers and lists backends in order, rejecting duplicates', () => {
    const { service } = setup();
    const second = new FakeBackend('other');
    service.registerBackend(second);
    expect(service.listBackends()).toEqual(['succinix', 'other']);
    expect(() => service.registerBackend(new FakeBackend('succinix'))).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_BACKEND' })
    );
    expect(() => service.registerBackend(new FakeBackend(''))).toThrowError('non-empty');
  });

  it('spawns, publishes, and lists only the exact owner', async () => {
    const { service, agent, backend, registry } = setup();
    const other = owner('agent-2');
    registry.register(other);
    expect(await service.spawn(other, request({ name: 'other' }))).toBeDefined();
    const result = await service.spawn(agent, request({ name: 'main' }));
    expect(result.sessionId.startsWith('pty-')).toBe(true);
    expect(result.motd).toBe('ready');
    expect(backend.specs[1]).toMatchObject({ owner: agent, type: 'succinix', name: 'main' });
    expect(service.hasOwnerActivity(agent)).toBe(true);
    expect(service.list(agent).map((entry) => entry.name)).toEqual(['main']);
    expect(service.list(other).map((entry) => entry.name)).toEqual(['other']);
  });

  it('fails closed for missing backends, dead owners, and foreign sessions', async () => {
    const { service, agent } = setup();
    const dead = owner('dead');
    await expect(service.spawn(dead, request())).rejects.toMatchObject({ code: 'OWNER_NOT_LIVE' });
    await expect(service.spawn(agent, request({ type: 'missing' }))).rejects.toMatchObject({ code: 'NO_BACKEND' });
    const result = await service.spawn(agent, request());
    const other = owner('other');
    expect(() => service.startSend(other, result.sessionId, { text: 'x', submit: true })).toThrowError(
      expect.objectContaining({ code: 'FOREIGN_SESSION' })
    );
    expect(() => service.read(agent, TerminalSessionId('missing'))).toThrowError(
      expect.objectContaining({ code: 'NO_SESSION' })
    );
  });

  it('enforces owner-local unique names including reserved spawns', async () => {
    const { service, agent } = setup();
    await service.spawn(agent, request({ name: 'a' }));
    await expect(service.spawn(agent, request({ name: 'a' }))).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
    const gate = new AbortController();
    const backend = new FakeBackend('slow', { spawnGate: { signal: gate.signal, ready: () => {} } });
    const service2 = new SuccinixTerminalService({
      isOwnerLive: () => true,
      onOwnerDispose: () => () => {},
    });
    service2.registerBackend(backend);
    const first = service2.spawn(agent, request({ type: 'slow', name: 'b' }));
    await expect(service2.spawn(agent, request({ type: 'slow', name: 'b' }))).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
    gate.abort();
    await expect(first).rejects.toThrow();
  });

  it('enforces one in-flight send per session', async () => {
    const { service, agent } = setup();
    const result = await service.spawn(agent, request());
    const first = service.startSend(agent, result.sessionId, { text: 'a', submit: true });
    expect(() => service.startSend(agent, result.sessionId, { text: 'b', submit: true })).toThrowError(
      expect.objectContaining({ code: 'SEND_ACTIVE' })
    );
    await first.done;
    expect(() => service.startSend(agent, result.sessionId, { text: 'b', submit: true })).not.toThrow();
  });

  it('accepts the fixed signal whitelist and rejects anything else', async () => {
    const { service, agent } = setup();
    const result = await service.spawn(agent, request());
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'] as const) {
      await expect(service.signal(agent, result.sessionId, signal)).resolves.toEqual({ delivered: true, targetPgid: 42 });
    }
    expect(() => service.signal(agent, result.sessionId, 'SIGUSR1' as TerminalSignal)).toThrowError(TerminalError);
  });

  it('kill is idempotent and removes the record only after quiescent close', async () => {
    const gate = deferred();
    const session = new FakeBackendSession({ closeGate: gate.promise });
    const backend = new FakeBackend('succinix', { session });
    const { service, agent } = setup({ backend });
    const result = await service.spawn(agent, request());
    const first = service.kill(agent, result.sessionId, 'test');
    const second = service.kill(agent, result.sessionId, 'test');
    expect(session.closes).toBe(1);
    expect(service.list(agent)).toHaveLength(1);
    expect(session.closed).toBe(true);
    gate.resolve();
    await expect(second).resolves.toBe(false);
    await first;
    expect(service.list(agent)).toHaveLength(0);
  });

  it('rolls back unpublished setup and surfaces cleanup failures', async () => {
    const session = new FakeBackendSession({ closeError: new Error('cleanup failed') });
    const backend = new FakeBackend('succinix', { session });
    const registry = new OwnerRegistry();
    const agent = owner();
    registry.register(agent);
    const service = new SuccinixTerminalService(registry.deps());
    service.registerBackend(backend);
    let liveChecks = 0;
    const dyingService = new SuccinixTerminalService({
      isOwnerLive: () => ++liveChecks > 1 ? false : true,
      onOwnerDispose: () => () => {},
    });
    dyingService.registerBackend(backend);
    await expect(dyingService.spawn(agent, request())).rejects.toBeInstanceOf(AggregateError);
    expect(session.closes).toBe(1);

    const failingBackend = new FakeBackend('failing', {
      spawnError: new TerminalBackendCleanupError(new Error('spawn'), new Error('cleanup')),
    });
    const service2 = new SuccinixTerminalService({
      isOwnerLive: () => true,
      onOwnerDispose: () => () => {},
    });
    service2.registerBackend(failingBackend);
    await expect(service2.spawn(agent, request({ type: 'failing' }))).rejects.toBeInstanceOf(TerminalBackendCleanupError);
  });

  it('disposes all sessions and rejects new work while disposing', async () => {
    const session = new FakeBackendSession();
    const backend = new FakeBackend('succinix', { session });
    const { service, agent } = setup({ backend });
    await service.spawn(agent, request());
    await service.dispose();
    expect(session.closed).toBe(true);
    expect(service.list(agent)).toHaveLength(0);
    await expect(service.spawn(agent, request())).rejects.toMatchObject({ code: 'SERVICE_DISPOSING' });
  });

  it('owner disposal aborts pending spawns and closes published sessions', async () => {
    const gate = new AbortController();
    const backend = new FakeBackend('slow', { spawnGate: { signal: gate.signal, ready: () => {} } });
    const { registry, service, agent } = setup({ backend });
    const pending = service.spawn(agent, request({ type: 'slow' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.hasOwnerActivity(agent)).toBe(true);
    registry.unregister(agent);
    await expect(pending).rejects.toThrow();
    expect(service.hasOwnerActivity(agent)).toBe(false);
    await expect(service.spawn(agent, request())).rejects.toMatchObject({ code: 'OWNER_NOT_LIVE' });
  });
});

describe('ctx.terminals Succinix backend', () => {
  class FakeInteractiveSession implements InteractiveTerminalSession {
    readonly id = 'interactive-1';
    readonly sent: string[] = [];
    readonly signals: Array<'SIGINT' | 'SIGTERM' | 'SIGKILL'> = [];
    closes = 0;
    private readonly listeners = new Set<(data: string) => void>();

    async send(data: string): Promise<void> {
      this.sent.push(data);
      if (data.includes('printf hello')) this.emit('hello\r\nguest@succinix:~$ ');
      if (data.includes('printf delayed')) {
        setTimeout(() => this.emit('delayed\r\nguest@succinix:~$ '), 70);
      }
      if (data.includes('printf late')) {
        setTimeout(() => this.emit('late\r\nguest@succinix:~$ '), 180);
      }
    }

    async resize(): Promise<void> {}

    onData(listener: (data: string) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    async signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void> {
      this.signals.push(signal);
    }

    async close(): Promise<void> {
      this.closes++;
    }

    emit(data: string): void {
      for (const listener of this.listeners) listener(data);
    }
  }

  it('wraps the execution-world interactive session with captured scrollback and raw sends', async () => {
    const interactive = new FakeInteractiveSession();
    const backend = new SuccinixTerminalBackend({
      open: async () => {
        setTimeout(() => interactive.emit('guest@succinix:~$ '), 0);
        return interactive;
      },
    });
    const session = await backend.spawn({
      sessionId: TerminalSessionId('pty-1'),
      owner: owner(),
      type: 'succinix',
      cwd: '/workspace',
    });
    expect(session.motd).toContain('guest@succinix');
    const send = session.startSend({ text: 'printf hello', submit: true });
    const result = await send.done;
    expect(result.waitReason).toBe('inferred_idle');
    expect(result.sessionStatus.kind).toBe('running');
    expect(interactive.sent).toEqual(['printf hello\r']);
    expect(session.read({ count: 10 }).text).toContain('hello');
    await session.close('test');
    expect(interactive.closes).toBe(1);
    expect(session.status()).toEqual({ kind: 'exited', exitCode: 0, signal: null });
  });

  it('waits for command output before reporting an inferred idle state', async () => {
    const interactive = new FakeInteractiveSession();
    const backend = new SuccinixTerminalBackend({
      open: async () => {
        setTimeout(() => interactive.emit('guest@succinix:~$ '), 0);
        return interactive;
      },
    });
    const session = await backend.spawn({
      sessionId: TerminalSessionId('pty-delayed'),
      owner: owner(),
      type: 'succinix',
    });

    const result = await session.startSend({ text: 'printf delayed', submit: true }).done;

    expect(result.waitReason).toBe('inferred_idle');
    expect(result.viewport).toContain('delayed');
    expect(session.read({ count: 10 }).text).toContain('delayed');
  });

  it('accepts a command before the first prompt reaches the subscriber', async () => {
    const interactive = new FakeInteractiveSession();
    const backend = new SuccinixTerminalBackend({
      open: async () => interactive,
    });
    const session = await backend.spawn({
      sessionId: TerminalSessionId('pty-late-prompt'),
      owner: owner(),
      type: 'succinix',
    });

    const result = await session.startSend({ text: 'printf late', submit: true }).done;

    expect(result.waitReason).toBe('inferred_idle');
    expect(result.viewport).toContain('late');
    expect(session.read({ count: 10 }).text).toContain('late');
  });

  it('rejects signals that have no verifiable foreground channel', async () => {
    const interactive = new FakeInteractiveSession();
    const backend = new SuccinixTerminalBackend({
      open: async () => {
        setTimeout(() => interactive.emit('guest@succinix:~$ '), 0);
        return interactive;
      },
    });
    const session = await backend.spawn({
      sessionId: TerminalSessionId('pty-2'),
      owner: owner(),
      type: 'succinix',
    });
    await expect(session.signal('SIGINT')).resolves.toEqual({ delivered: true, targetPgid: expect.any(Number) });
    expect(interactive.signals).toEqual(['SIGINT']);
    await expect(session.signal('SIGHUP')).rejects.toThrow('no verifiable foreground delivery channel');
  });
});
