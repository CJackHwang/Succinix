// invariant: dsh ctx.sessionPersistence provider as a same-invariant JSONL
// mirror. The official coordinator is deliberately not used: it is bound to a
// live @deepseek-ai/dsh-session SessionStore, while Succinix is an execution
// world provider whose host owns the live session layer. This mirror preserves
// the append-only, contiguous-seq, repair, revision, and raw-artifact contract.
import type { FileSystemAPI } from '@webcontainer/api';
import type { TerminalClient } from '../engine/index.js';
import { browserPathFor } from './fs-service.js';
import {
  atomicWrite,
  isNotFoundError,
  readRaw,
} from './fs-mutations.js';
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  JSONL_EXTENSION,
  SESSION_FORMAT_VERSION,
  artifactBase,
  artifactName,
  eventLine,
  headerLine,
  isBalanced,
  isSessionHeader,
  parseStoredLog,
  revisionFor,
  snapshotJson,
  syntheticClosers,
  type StoredLog,
} from './persistence-jsonl.js';
import {
  SessionFormatUnsupportedError,
  SessionId,
  SessionPersistenceCorruptionError,
  SessionPersistenceRevision,
  type SessionEvent,
  type SessionHeader,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistence,
  type SessionPersistenceSnapshot,
  type SessionPreparation,
  type SessionRawArtifact,
} from './dsh-types.js';

export interface SessionPersistenceServiceDeps {
  getFs(): FileSystemAPI | undefined;
  getClient(): TerminalClient | undefined;
  stateRoot?: string;
  isLive?(id: SessionId): boolean;
  liveEvents?(id: SessionId): readonly SessionEvent[] | undefined;
  onFlush?(): Promise<void> | void;
}

interface PreparedEntry {
  id: SessionId;
  inspection: SessionInspection;
  revision: SessionPersistenceRevision;
  reserved: boolean;
  committed: boolean;
}

interface PreparedSessionView {
  readonly id: SessionId;
  readonly header: SessionHeader;
  readonly events: readonly SessionEvent[];
}

export class SuccinixSessionPersistence implements SessionPersistence {
  readonly supportsRawArtifacts = true;
  private readonly stateRoot: string;
  private readonly created = new Map<SessionId, SessionHeader>();
  private readonly chains = new Map<SessionId, Promise<void>>();
  private readonly prepared = new Map<SessionId, PreparedEntry>();
  private readonly reserved = new Set<SessionId>();

  constructor(private readonly deps: SessionPersistenceServiceDeps) {
    this.stateRoot = deps.stateRoot ?? '/workspace/.succinix/sessions';
  }

  locate(meta: SessionHeader): SessionLocation {
    return { kind: 'jsonl', path: `${this.stateRoot}/${artifactName(meta.id)}` };
  }

  async readRaw(id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    return this.serialize(id, async () => {
      signal?.throwIfAborted();
      const fs = this.requireFs();
      const path = this.browserPath(this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 }).path);
      let bytes: Uint8Array;
      try {
        bytes = await readRaw(fs, path);
      } catch (error) {
        if (isNotFoundError(error)) return undefined;
        throw new SessionPersistenceCorruptionError(`cannot read stored session "${id}"`, { cause: error });
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (error) {
        throw new SessionPersistenceCorruptionError(`stored session "${id}" is not valid UTF-8`, { cause: error });
      }
      const location = { kind: 'jsonl', path: this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 }).path };
      const meta = parseStoredLog(text, id, location).meta;
      return {
        meta: structuredClone(meta),
        filename: artifactBase(id),
        content: text,
      };
    }, signal);
  }

  async create(meta: SessionHeader): Promise<void> {
    const snapshot = snapshotJson(meta, 'session metadata');
    if (!isSessionHeader(snapshot) || snapshot.version !== SESSION_FORMAT_VERSION) {
      throw new TypeError('session metadata must be a valid SessionHeader with the current format version');
    }
    return this.serialize(snapshot.id, async () => {
      if (this.created.has(snapshot.id) || this.reserved.has(snapshot.id)) {
        throw new Error(`session "${snapshot.id}" already exists in this backend`);
      }
      if (await this.readStoredMeta(snapshot.id) !== undefined) {
        throw new Error(`session "${snapshot.id}" already has a persisted log on disk; load/resume it instead of creating`);
      }
      this.created.set(snapshot.id, structuredClone(snapshot));
    });
  }

  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    for (const event of events) {
      snapshotJson(event.data, `event "${event.type}" data`);
    }
    const batch = snapshotJson([...events], 'session event batch');
    return this.serialize(id, async () => {
      if (batch.length === 0) return;
      if (this.reserved.has(id)) {
        throw new Error(`cannot append session "${id}" while its persisted preparation is reserved`);
      }
      const location = { kind: 'jsonl', path: this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 }).path };
      const current = await this.readStoredLog(id, location);
      const expectedSeq = current.events.length;
      for (let index = 0; index < batch.length; index++) {
        const event = batch[index]!;
        if (event.seq !== expectedSeq + index) {
          throw new Error(`append seq mismatch for "${id}": expected ${expectedSeq + index} at index ${index}, got ${event.seq}`);
        }
      }
      const meta = current.meta ?? this.created.get(id);
      if (meta === undefined) throw new Error(`session "${id}" not found`);
      const text = current.events.length === 0
        ? headerLine(meta) + '\n' + batch.map((event) => eventLine(event)).join('\n') + '\n'
        : current.rawText + batch.map((event) => eventLine(event)).join('\n') + '\n';
      await this.writeArtifact(id, text);
      await this.flushAfterWrite();
    });
  }

  async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.serialize(id, async () => {
      signal?.throwIfAborted();
      this.assertNotLive(id);
      const entry = await this.prepareEntry(id, true, signal);
      if (this.reserved.has(id)) throw new Error(`session "${id}" already has a reserved preparation`);
      this.reserved.add(id);
      entry.reserved = true;
      let released = false;
      const sessionView: PreparedSessionView = Object.freeze({
        id,
        header: entry.inspection.meta,
        events: entry.inspection.events,
      });
      return {
        session: sessionView,
        [Symbol.dispose]: () => {
          if (released) return;
          released = true;
          this.reserved.delete(id);
          entry.reserved = false;
          this.cachePrepared(entry);
        },
      };
    }, signal);
  }

  async load(id: SessionId): Promise<SessionInspection> {
    return this.serialize(id, async () => {
      const live = this.liveEvents(id);
      if (live !== undefined) {
        if (!isBalanced(live)) {
          throw new Error(`cannot load session "${id}" while its live turn is open; use the live Session or wait for the turn to close`);
        }
        const header = this.created.get(id) ?? (await this.readStoredMeta(id));
        if (header === undefined) throw new Error(`session "${id}" not found`);
        return Object.freeze({ meta: structuredClone(header), events: Object.freeze([...live]) });
      }
      this.assertNotLive(id);
      const entry = await this.prepareEntry(id, true);
      return entry.inspection;
    });
  }

  async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.serialize(id, async () => {
      signal?.throwIfAborted();
      const live = this.liveEvents(id);
      if (live !== undefined) {
        const header = this.created.get(id) ?? (await this.readStoredMeta(id));
        if (header === undefined) throw new Error(`session "${id}" not found`);
        return Object.freeze({ meta: structuredClone(header), events: Object.freeze([...live]) });
      }
      if (this.deps.isLive?.(id)) {
        throw new Error(`cannot inspect session "${id}" while it is live and no live event view is available`);
      }
      const entry = await this.prepareEntry(id, false, signal);
      return entry.inspection;
    }, signal);
  }

  async readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
      throw new TypeError(`readFrom fromSeq must be a non-negative safe integer, got ${String(fromSeq)}`);
    }
    return this.serialize(id, async () => {
      signal?.throwIfAborted();
      const location = { kind: 'jsonl', path: this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 }).path };
      const stored = await this.readStoredArtifact(id, location);
      if (stored === undefined) throw new Error(`session "${id}" not found`);
      return {
        meta: structuredClone(stored.meta),
        events: stored.events.filter((event) => event.seq >= fromSeq),
      };
    }, signal);
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    const entries = await this.listArtifacts(signal);
    return entries.map((entry) => structuredClone(entry.meta));
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted();
    const entries = await this.listArtifacts(signal);
    return entries.map((entry) => ({
      header: structuredClone(entry.meta),
      revision: entry.revision,
    }));
  }

  private requireFs(): FileSystemAPI {
    const fs = this.deps.getFs();
    if (!fs) throw new Error('execution world is not ready for session persistence');
    return fs;
  }

  private browserPath(executionPath: string): string {
    return browserPathFor(executionPath);
  }

  private browserStateRoot(): string {
    return browserPathFor(this.stateRoot);
  }

  private async readStoredMeta(id: SessionId): Promise<SessionHeader | undefined> {
    const location = { kind: 'jsonl', path: this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 }).path };
    const stored = await this.readStoredArtifact(id, location);
    return stored === undefined ? undefined : structuredClone(stored.meta);
  }

  private async readStoredArtifact(id: SessionId, location: SessionLocation): Promise<StoredLog | undefined> {
    const fs = this.requireFs();
    const path = this.browserPath(location.path);
    let bytes: Uint8Array;
    try {
      bytes = await readRaw(fs, path);
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw new SessionPersistenceCorruptionError(`cannot read stored session "${id}"`, { cause: error });
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new SessionPersistenceCorruptionError(`stored session "${id}" is not valid UTF-8`, { cause: error });
    }
    return parseStoredLog(text, id, location);
  }

  private async readStoredLog(id: SessionId, location: SessionLocation): Promise<StoredLog> {
    const fs = this.requireFs();
    const path = this.browserPath(location.path);
    let bytes: Uint8Array;
    try {
      bytes = await readRaw(fs, path);
    } catch (error) {
      if (isNotFoundError(error)) {
        const meta = this.created.get(id);
        if (meta === undefined) throw new Error(`session "${id}" not found`, { cause: error });
        return {
          meta,
          events: [],
          validLength: 0,
          torn: false,
          revision: revisionFor(id, ''),
          rawText: '',
        };
      }
      throw new SessionPersistenceCorruptionError(`cannot read stored session "${id}"`, { cause: error });
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new SessionPersistenceCorruptionError(`stored session "${id}" is not valid UTF-8`, { cause: error });
    }
    return parseStoredLog(text, id, location);
  }

  private async prepareEntry(id: SessionId, commit: boolean, signal?: AbortSignal): Promise<PreparedEntry> {
    signal?.throwIfAborted();
    const location = { kind: 'jsonl', path: this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 }).path };
    const stored = await this.readStoredArtifact(id, location);
    if (stored === undefined) throw new Error(`session "${id}" not found`);
    const closers = syntheticClosers(stored.events, id);
    const events = [...stored.events, ...closers];
    const inspection: SessionInspection = Object.freeze({
      meta: structuredClone(stored.meta),
      events: Object.freeze(events),
    });
    const cached = this.prepared.get(id);
    if (cached !== undefined && !cached.reserved && cached.revision === stored.revision && (!commit || cached.committed)) {
      this.touchPrepared(id);
      return cached;
    }
    const entry: PreparedEntry = {
      id,
      inspection,
      revision: stored.revision,
      reserved: false,
      committed: false,
    };
    if (commit && (stored.torn || closers.length > 0)) {
      const repaired = stored.rawText.slice(0, stored.validLength)
        + closers.map((event) => eventLine(event)).join('\n')
        + (closers.length > 0 ? '\n' : '');
      await this.writeArtifact(id, repaired);
      entry.revision = revisionFor(id, repaired);
      entry.committed = true;
      await this.flushAfterWrite();
    }
    if (commit && !stored.torn && closers.length === 0) entry.committed = true;
    this.cachePrepared(entry);
    return entry;
  }

  private cachePrepared(entry: PreparedEntry): void {
    if (entry.reserved) return;
    this.prepared.delete(entry.id);
    this.prepared.set(entry.id, entry);
    if (this.prepared.size <= DEFAULT_PREPARED_SESSION_CACHE_SIZE) return;
    for (const oldest of this.prepared.keys()) {
      if (this.prepared.size <= DEFAULT_PREPARED_SESSION_CACHE_SIZE) break;
      const candidate = this.prepared.get(oldest);
      if (candidate !== undefined && !candidate.reserved) this.prepared.delete(oldest);
    }
  }

  private touchPrepared(id: SessionId): void {
    const entry = this.prepared.get(id);
    if (entry === undefined || entry.reserved) return;
    this.prepared.delete(id);
    this.prepared.set(id, entry);
  }

  private async writeArtifact(id: SessionId, text: string): Promise<void> {
    const fs = this.requireFs();
    const path = this.browserPath(this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 }).path);
    const dir = path.slice(0, path.lastIndexOf('/'));
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(fs, path, text);
  }

  private async listArtifacts(signal?: AbortSignal): Promise<Array<{ meta: SessionHeader; revision: SessionPersistenceRevision }>> {
    const fs = this.requireFs();
    const dir = this.browserStateRoot();
    let names: string[];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      names = entries
        .filter((entry) => typeof entry.isFile === 'function' && entry.isFile())
        .map((entry) => String(entry.name))
        .filter((name) => name.endsWith(JSONL_EXTENSION))
        .sort();
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw new SessionPersistenceCorruptionError(`cannot list stored sessions`, { cause: error });
    }
    const found: Array<{ meta: SessionHeader; revision: SessionPersistenceRevision }> = [];
    for (const name of names) {
      signal?.throwIfAborted();
      let id: SessionId;
      try {
        id = SessionId(decodeURIComponent(name.slice(0, -JSONL_EXTENSION.length)));
      } catch {
        continue;
      }
      const location = { kind: 'jsonl', path: `${this.stateRoot}/${name}` };
      try {
        const stored = await this.readStoredArtifact(id, location);
        if (stored !== undefined) found.push({ meta: structuredClone(stored.meta), revision: stored.revision });
      } catch (error) {
        if (error instanceof SessionPersistenceCorruptionError || error instanceof SessionFormatUnsupportedError) throw error;
        /* an artifact that disappeared mid-list is treated as absent */
      }
    }
    return found;
  }

  private liveEvents(id: SessionId): readonly SessionEvent[] | undefined {
    return this.deps.liveEvents?.(id);
  }

  private assertNotLive(id: SessionId): void {
    if (this.deps.isLive?.(id)) {
      throw new Error(`cannot prepare session "${id}" while it is live`);
    }
  }

  private async flushAfterWrite(): Promise<void> {
    try {
      await this.deps.onFlush?.();
    } catch {
      /* append durability is the file write; snapshot flush is best effort */
    }
  }

  private serialize<T>(id: SessionId, op: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve();
    const run = () => {
      signal?.throwIfAborted();
      return op();
    };
    const next = prior.then(run, run);
    const tail = next.then(() => undefined, () => undefined);
    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });
    return next;
  }
}
