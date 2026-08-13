// invariant: owner-scoped dsh ctx.terminals registry over Succinix PTY backends.
// The service owns ids, publication, authorization, and awaited cleanup; it
// never invents an implicit guest owner and fails closed when the host cannot
// prove an Agent is live.
import {
  TerminalBackendCleanupError,
  TerminalError,
  TerminalSessionId,
  type Agent,
  type TerminalBackend,
  type TerminalBackendSession,
  type TerminalSendOperation,
  type TerminalSessionIdValue,
  type TerminalSessionService,
  type TerminalSessionSnapshot,
  type TerminalSignal,
  type TerminalSpawnRequest,
  type TerminalSpawnResult,
} from './dsh-types.js';

const ALLOWED_SIGNALS: readonly TerminalSignal[] = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'];

export interface TerminalServiceDeps {
  isOwnerLive(owner: Agent): boolean;
  onOwnerDispose(owner: Agent, handler: () => void | Promise<void>): () => void;
}

interface SessionRecord {
  id: TerminalSessionIdValue;
  owner: Agent;
  name?: string;
  type: string;
  session: TerminalBackendSession;
  active?: TerminalSendOperation;
  closing?: Promise<void>;
}

interface PendingSpawn {
  owner: Agent;
  controller: AbortController;
  settled: Promise<void>;
  cleanupFailure?: { error: unknown };
}

export class SuccinixTerminalService implements TerminalSessionService {
  private readonly backends = new Map<string, TerminalBackend>();
  private readonly sessions = new Map<TerminalSessionIdValue, SessionRecord>();
  private readonly reservedNames = new Map<Agent, Set<string>>();
  private readonly pendingSpawns = new Map<Agent, Set<PendingSpawn>>();
  private readonly ownerCleanups = new Map<Agent, () => void | Promise<void>>();
  private readonly disposedOwners = new WeakSet<Agent>();
  private nextId = 0;
  private disposing = false;

  constructor(private readonly deps: TerminalServiceDeps) {}

  registerBackend(backend: TerminalBackend): () => void {
    if (backend.type.length === 0) throw new Error('PTY backend type must be non-empty');
    if (this.backends.has(backend.type)) {
      throw new TerminalError(`a PTY backend named "${backend.type}" is already registered`, 'DUPLICATE_BACKEND');
    }
    this.backends.set(backend.type, backend);
    return () => {
      if (this.backends.get(backend.type) === backend) this.backends.delete(backend.type);
    };
  }

  listBackends(): string[] {
    return [...this.backends.keys()];
  }

  async spawn(owner: Agent, request: TerminalSpawnRequest, signal?: AbortSignal): Promise<TerminalSpawnResult> {
    this.assertActive();
    signal?.throwIfAborted();
    this.ensureOwnerCleanup(owner);
    const backend = this.backends.get(request.type);
    if (!backend) throw new TerminalError(`no PTY backend registered for "${request.type}"`, 'NO_BACKEND');
    if (request.name !== undefined && request.name.length === 0) throw new Error('PTY session name must be non-empty');
    const releaseName = this.reserveName(owner, request.name);
    const spawnReservation = this.reserveSpawn(owner);
    const backendSignal = signal === undefined ? spawnReservation.signal : AbortSignal.any([signal, spawnReservation.signal]);
    const sessionId = TerminalSessionId(`pty-${++this.nextId}`);
    let session: TerminalBackendSession | undefined;
    let cleanupFailure: { error: unknown } | undefined;
    try {
      session = await backend.spawn({
        sessionId,
        owner,
        type: request.type,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        signal: backendSignal,
      });
      signal?.throwIfAborted();
      if (this.disposing) throw new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING');
      if (!this.isLiveOwner(owner)) throw new TerminalError('PTY owner is no longer live', 'OWNER_NOT_LIVE');
      const record: SessionRecord = {
        id: sessionId,
        owner,
        name: request.name,
        type: request.type,
        session,
      };
      this.sessions.set(sessionId, record);
      return this.snapshot(record, session.motd) as TerminalSpawnResult;
    } catch (error) {
      if (error instanceof TerminalBackendCleanupError) cleanupFailure = { error: error.cleanupError };
      let rollbackFailure: { error: unknown } | undefined;
      if (session !== undefined && !this.sessions.has(sessionId)) {
        try {
          await session.close('PTY spawn rolled back');
        } catch (closeError) {
          rollbackFailure = { error: closeError };
          cleanupFailure = rollbackFailure;
        }
      }
      let failure = error;
      try {
        signal?.throwIfAborted();
        spawnReservation.signal.throwIfAborted();
      } catch (cancellation) {
        failure = cancellation;
      }
      if (rollbackFailure !== undefined && signal?.aborted !== true) {
        throw new AggregateError([failure, rollbackFailure.error], 'PTY spawn and rollback both failed', { cause: error });
      }
      throw failure;
    } finally {
      spawnReservation.release(cleanupFailure);
      releaseName();
    }
  }

  hasOwnerActivity(owner: Agent): boolean {
    return (this.pendingSpawns.get(owner)?.size ?? 0) > 0 || [...this.sessions.values()].some((record) => record.owner === owner);
  }

  startSend(owner: Agent, id: TerminalSessionIdValue, request: Parameters<TerminalSessionService['startSend']>[2]): TerminalSendOperation {
    const record = this.expectOwned(owner, id);
    if (record.closing !== undefined) throw new Error(`PTY session ${id} is closing`);
    if (record.active !== undefined) throw new TerminalError(`PTY session ${id} already has an active send`, 'SEND_ACTIVE');
    const operation = record.session.startSend(request);
    record.active = operation;
    const clear = () => {
      if (record.active === operation) record.active = undefined;
    };
    operation.done.then(clear, clear);
    return operation;
  }

  read(owner: Agent, id: TerminalSessionIdValue, request?: Parameters<TerminalSessionService['read']>[2]): ReturnType<TerminalSessionService['read']> {
    return this.expectOwned(owner, id).session.read(request ?? {});
  }

  signal(owner: Agent, id: TerminalSessionIdValue, signal: TerminalSignal): Promise<{ delivered: true; targetPgid: number }> {
    if (!ALLOWED_SIGNALS.includes(signal)) {
      throw new TerminalError(`signal ${String(signal)} is not in the allowed PTY signal set`, 'NO_SESSION');
    }
    return this.expectOwned(owner, id).session.signal(signal);
  }

  async kill(owner: Agent, id: TerminalSessionIdValue, reason = 'model request'): Promise<boolean> {
    const record = this.expectOwned(owner, id);
    if (record.closing !== undefined) {
      await record.closing;
      return false;
    }
    const closing = record.session.close(reason);
    record.closing = closing;
    try {
      await closing;
      this.sessions.delete(id);
      return true;
    } catch (error) {
      if (record.closing === closing) record.closing = undefined;
      throw error;
    }
  }

  list(owner: Agent): TerminalSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((record) => record.owner === owner)
      .map((record) => this.snapshot(record));
  }

  async dispose(): Promise<void> {
    await this.disposeAll();
  }

  private assertActive(): void {
    if (this.disposing) throw new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING');
  }

  private isLiveOwner(owner: Agent): boolean {
    return !this.disposedOwners.has(owner) && this.deps.isOwnerLive(owner);
  }

  private ensureOwnerCleanup(owner: Agent): void {
    if (!this.isLiveOwner(owner)) throw new TerminalError(`agent "${owner.id}" is not the registered PTY owner`, 'OWNER_NOT_LIVE');
    if (this.ownerCleanups.has(owner)) return;
    const detach = this.deps.onOwnerDispose(owner, async () => {
      this.disposedOwners.add(owner);
      this.ownerCleanups.delete(owner);
      await this.disposeOwned(owner);
    });
    this.ownerCleanups.set(owner, detach);
  }

  private reserveName(owner: Agent, name?: string): () => void {
    if (name === undefined) return () => {};
    if ([...this.sessions.values()].some((record) => record.owner === owner && record.name === name)) {
      throw new TerminalError(`PTY session name "${name}" already exists for this owner`, 'DUPLICATE_NAME');
    }
    const reserved = this.reservedNames.get(owner) ?? new Set<string>();
    if (reserved.has(name)) throw new TerminalError(`PTY session name "${name}" is already being created`, 'DUPLICATE_NAME');
    reserved.add(name);
    this.reservedNames.set(owner, reserved);
    return () => {
      reserved.delete(name);
      if (reserved.size === 0) this.reservedNames.delete(owner);
    };
  }

  private reserveSpawn(owner: Agent): { signal: AbortSignal; release(cleanupFailure?: { error: unknown }): void } {
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const pending: PendingSpawn = {
      owner,
      controller,
      settled,
    };
    const owned = this.pendingSpawns.get(owner) ?? new Set<PendingSpawn>();
    owned.add(pending);
    this.pendingSpawns.set(owner, owned);
    return {
      signal: controller.signal,
      release: (cleanupFailure) => {
        pending.cleanupFailure = cleanupFailure;
        if (cleanupFailure === undefined) this.removePendingSpawn(pending);
        resolveSettled();
      },
    };
  }

  private removePendingSpawn(pending: PendingSpawn): void {
    const owned = this.pendingSpawns.get(pending.owner);
    if (!owned) return;
    owned.delete(pending);
    if (owned.size === 0) this.pendingSpawns.delete(pending.owner);
  }

  private async abortPendingSpawns(owner: Agent | undefined, reason: unknown): Promise<void> {
    const pending = owner === undefined
      ? [...this.pendingSpawns.values()].flatMap((owned) => [...owned])
      : [...(this.pendingSpawns.get(owner) ?? [])];
    for (const spawn of pending) spawn.controller.abort(reason);
    await Promise.all(pending.map((spawn) => spawn.settled));
    const failures = pending.flatMap((spawn) => (spawn.cleanupFailure === undefined ? [] : [spawn.cleanupFailure.error]));
    for (const spawn of pending) this.removePendingSpawn(spawn);
    if (failures.length > 0) throw new AggregateError(failures, 'failed to roll back unpublished PTY setup');
  }

  private expectOwned(owner: Agent, id: TerminalSessionIdValue): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new TerminalError(`unknown PTY session ${id}`, 'NO_SESSION');
    if (record.owner !== owner) throw new TerminalError(`PTY session ${id} belongs to another agent`, 'FOREIGN_SESSION');
    return record;
  }

  private snapshot(record: SessionRecord, motd?: string): TerminalSessionSnapshot & { motd?: string } {
    return {
      sessionId: record.id,
      ...(record.name !== undefined ? { name: record.name } : {}),
      type: record.type,
      ...(record.session.pid !== undefined ? { pid: record.session.pid } : {}),
      status: record.session.status(),
      ...(motd !== undefined ? { motd } : {}),
    };
  }

  private async abortAndClose(owner: Agent | undefined, abortReason: unknown, closeReason: string): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.abortPendingSpawns(owner, abortReason);
    } catch (error) {
      failures.push(error);
    }
    const records = [...this.sessions.values()].filter((record) => owner === undefined || record.owner === owner);
    try {
      await this.closeRecords(records, closeReason);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'failed to clean up PTY lifecycle');
  }

  private async disposeOwned(owner: Agent): Promise<void> {
    try {
      await this.abortAndClose(owner, new TerminalError('PTY owner is no longer live', 'OWNER_NOT_LIVE'), 'PTY owner disposed');
    } finally {
      this.reservedNames.delete(owner);
    }
  }

  private async disposeAll(): Promise<void> {
    this.disposing = true;
    try {
      await this.abortAndClose(undefined, new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING'), 'PTY service disposed');
    } finally {
      this.backends.clear();
      this.reservedNames.clear();
      this.pendingSpawns.clear();
      const cleanups = [...this.ownerCleanups.values()];
      this.ownerCleanups.clear();
      await Promise.all(cleanups.map((cleanup) => Promise.resolve(cleanup())));
    }
  }

  private async closeRecords(records: SessionRecord[], reason: string): Promise<void> {
    const failures = (await Promise.allSettled(records.map(async (record) => {
      const closing = record.closing ?? record.session.close(reason);
      record.closing = closing;
      try {
        await closing;
        this.sessions.delete(record.id);
      } catch (error) {
        if (record.closing === closing) record.closing = undefined;
        throw error;
      }
    }))).filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, `failed to close ${failures.length} PTY session(s)`);
  }
}
