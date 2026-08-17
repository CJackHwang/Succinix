// invariant: dsh ctx.sessionPersistence provider as a same-invariant JSONL
// mirror. The official coordinator is deliberately not used: it is bound to a
// live @deepseek-ai/dsh-session SessionStore, while Succinix is an execution
// world provider whose host owns the live session layer. This mirror preserves
// the append-only, contiguous-seq, repair, revision, and raw-artifact contract.
import type { FileSystemAPI } from '@webcontainer/api';
import type { TerminalClient } from '../engine/index.js';
import { browserPathFor } from './fs-service.js';
import {
  isNotFoundError,
  readRaw,
} from './fs-mutations.js';
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
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
import { JsonlSessionStore, PreparedEntry, PreparedSessionView, SegmentedSessionStore } from './persistence-jsonl-store.js';

export interface SessionPersistenceServiceDeps {
  getFs(): FileSystemAPI | undefined;
  getClient(): TerminalClient | undefined;
  stateRoot?: string;
  isLive?(id: SessionId): boolean;
  liveEvents?(id: SessionId): readonly SessionEvent[] | undefined;
  onFlush?(): Promise<void> | void;
  /** Opt into v0.7 manifest + segmented JSONL storage. Legacy remains
   * available for embedders that explicitly set false during migration. */
  segmented?: boolean;
}

export class SuccinixSessionPersistence implements SessionPersistence {
  readonly supportsRawArtifacts = true;
  private readonly stateRoot: string;
  private readonly created = new Map<SessionId, SessionHeader>();
  private readonly chains = new Map<SessionId, Promise<void>>();
  private readonly prepared = new Map<SessionId, PreparedEntry>();
  private readonly reserved = new Set<SessionId>();
  private readonly segmented: boolean;
  private jsonlStore: JsonlSessionStore | null = null;
  private readonly segmentedStore: SegmentedSessionStore;

  constructor(private readonly deps: SessionPersistenceServiceDeps) {
    this.stateRoot = deps.stateRoot ?? '/workspace/.succinix/sessions';
    this.segmented = deps.segmented === true;
    this.segmentedStore = new SegmentedSessionStore(() => this.requireFs(), this.stateRoot, deps.onFlush);
  }

  locate(meta: SessionHeader): SessionLocation {
    if (this.segmented) return { kind: 'jsonl-segments', path: `${this.stateRoot}/segments/${artifactName(meta.id)}.manifest.json` };
    return { kind: 'jsonl', path: `${this.stateRoot}/${artifactName(meta.id)}` };
  }

  private requireStore(): JsonlSessionStore {
    if (!this.jsonlStore) this.jsonlStore = new JsonlSessionStore(this.requireFs(), this.stateRoot);
    return this.jsonlStore;
  }

  private async readSegmentedArtifact(id: SessionId, location: SessionLocation): Promise<StoredLog | undefined> {
    return this.segmentedStore.readArtifact(id, location);
  }

  async readRaw(id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    return this.serialize(id, async () => {
      signal?.throwIfAborted();
      if (this.segmented) {
        const location = this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 });
        const stored = await this.readSegmentedArtifact(id, location);
        if (!stored) return undefined;
        return { meta: structuredClone(stored.meta), filename: artifactBase(id), content: stored.rawText };
      }
      const fs = this.requireFs();
      const path = this.requireStore().browserPath(this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 }).path);
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
      const location = this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 });
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
      if (this.segmented) {
        await this.segmentedStore.log(snapshot.id).create(snapshot.createdAt, snapshot);
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
      if (this.segmented) {
        const log = this.segmentedStore.log(id);
        let expected: number;
        try {
          expected = (await log.manifest()).nextSeq;
        } catch {
          throw new Error(`session "${id}" not found`);
        }
        for (let index = 0; index < batch.length; index++) {
          if (batch[index]!.seq !== expected + index) throw new Error(`append seq mismatch for "${id}": expected ${expected + index} at index ${index}, got ${batch[index]!.seq}`);
        }
        await log.append(batch as unknown as readonly { type: string; seq: number; [key: string]: unknown }[]);
        return;
      }
      const location = this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 });
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

  private async readStoredMeta(id: SessionId): Promise<SessionHeader | undefined> {
    if (this.segmented) {
      const stored = await this.readSegmentedArtifact(id, this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 }));
      return stored ? structuredClone(stored.meta) : undefined;
    }
    const location = this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 });
    return this.requireStore().readMeta(id, location);
  }

  private async readStoredArtifact(id: SessionId, location: SessionLocation): Promise<StoredLog | undefined> {
    if (this.segmented) return this.readSegmentedArtifact(id, location);
    return this.requireStore().readArtifact(id, location);
  }

  private async readStoredLog(id: SessionId, location: SessionLocation): Promise<StoredLog> {
    if (this.segmented) {
      const stored = await this.readSegmentedArtifact(id, location);
      if (stored) return stored;
      const meta = this.created.get(id);
      if (meta === undefined) throw new Error(`session "${id}" not found`);
      return { meta, events: [], validLength: 0, torn: false, revision: revisionFor(id, ''), rawText: '' };
    }
    return this.requireStore().readLog(id, location, this.created.get(id));
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
      if (this.segmented) {
        if (closers.length > 0) await this.segmentedStore.log(id).append(closers as unknown as readonly { type: string; seq: number; [key: string]: unknown }[]);
        const repaired = await this.readSegmentedArtifact(id, location);
        entry.revision = repaired?.revision ?? entry.revision;
      } else {
        const repaired = stored.rawText.slice(0, stored.validLength)
          + closers.map((event) => eventLine(event)).join('\n')
          + (closers.length > 0 ? '\n' : '');
        await this.writeArtifact(id, repaired);
        entry.revision = revisionFor(id, repaired);
      }
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
    const location = this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 });
    await this.requireStore().writeArtifact(id, location, text);
  }

  private async listArtifacts(signal?: AbortSignal): Promise<Array<{ meta: SessionHeader; revision: SessionPersistenceRevision }>> {
    const fs = this.requireFs();
    if (this.segmented) {
      const dir = `${browserPathFor(this.stateRoot)}/segments`;
      let entries: Array<{ name: string; isFile(): boolean }>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isNotFoundError(error)) return [];
        throw new SessionPersistenceCorruptionError('cannot list segmented stored sessions', { cause: error });
      }
      const found: Array<{ meta: SessionHeader; revision: SessionPersistenceRevision }> = [];
      for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.manifest.json')).sort((a, b) => a.name.localeCompare(b.name))) {
        signal?.throwIfAborted();
        const encoded = entry.name.slice(0, -'.manifest.json'.length);
        let id: SessionId;
        try { id = SessionId(decodeURIComponent(encoded)); } catch { continue; }
        const stored = await this.readSegmentedArtifact(id, this.locate({ id, version: SESSION_FORMAT_VERSION, createdAt: 0 }));
        if (stored) found.push({ meta: structuredClone(stored.meta), revision: stored.revision });
      }
      return found;
    }
    return this.requireStore().listArtifacts(signal);
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
