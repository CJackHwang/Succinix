// invariant: legacy JSONL session artifact file I/O for ctx.sessionPersistence
// (split from persistence-service.ts for the 450-line gate). The segmented
// v0.7 storage lives in src/persist/session-segments.ts; this store keeps the
// plain JSONL path used by embedders that opt out of segmentation.
import type { FileSystemAPI } from '@webcontainer/api';
import { browserPathFor } from './fs-service.js';
import { atomicWrite, isNotFoundError, readRaw } from './fs-mutations.js';
import {
  JSONL_EXTENSION,
  SESSION_FORMAT_VERSION,
  eventLine,
  headerLine,
  isSessionHeader,
  parseStoredLog,
  revisionFor,
  type StoredLog,
} from './persistence-jsonl.js';
import {
  SessionFormatUnsupportedError,
  SessionId,
  SessionPersistenceCorruptionError,
  type SessionEvent,
  type SessionHeader,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceRevision,
} from './dsh-types.js';
import { SegmentedSessionLog, SessionSegmentCorruptionError, type SessionSegmentManifest } from '../persist/session-segments.js';

export interface PreparedEntry {
  id: SessionId;
  inspection: SessionInspection;
  revision: SessionPersistenceRevision;
  reserved: boolean;
  committed: boolean;
}

export interface PreparedSessionView {
  readonly id: SessionId;
  readonly header: SessionHeader;
  readonly events: readonly SessionEvent[];
}

export class JsonlSessionStore {
  constructor(private readonly fs: FileSystemAPI, private readonly stateRoot: string) {}

  browserPath(executionPath: string): string {
    return browserPathFor(executionPath);
  }

  browserStateRoot(): string {
    return browserPathFor(this.stateRoot);
  }

  async readArtifact(id: SessionId, location: SessionLocation): Promise<StoredLog | undefined> {
    const path = this.browserPath(location.path);
    let bytes: Uint8Array;
    try {
      bytes = await readRaw(this.fs, path);
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

  async readMeta(id: SessionId, location: SessionLocation): Promise<SessionHeader | undefined> {
    const stored = await this.readArtifact(id, location);
    return stored === undefined ? undefined : structuredClone(stored.meta);
  }

  async readLog(id: SessionId, location: SessionLocation, fallbackMeta: SessionHeader | undefined): Promise<StoredLog> {
    const path = this.browserPath(location.path);
    let bytes: Uint8Array;
    try {
      bytes = await readRaw(this.fs, path);
    } catch (error) {
      if (isNotFoundError(error)) {
        if (fallbackMeta === undefined) throw new Error(`session "${id}" not found`, { cause: error });
        return {
          meta: fallbackMeta,
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

  async writeArtifact(id: SessionId, location: SessionLocation, text: string): Promise<void> {
    const path = this.browserPath(location.path);
    const dir = path.slice(0, path.lastIndexOf('/'));
    await this.fs.mkdir(dir, { recursive: true });
    await atomicWrite(this.fs, path, text);
  }

  async listArtifacts(signal?: AbortSignal): Promise<Array<{ meta: SessionHeader; revision: SessionPersistenceRevision }>> {
    let names: string[];
    try {
      const entries = await this.fs.readdir(this.browserStateRoot(), { withFileTypes: true });
      names = entries
        .filter((entry) => typeof entry.isFile === 'function' && entry.isFile())
        .map((entry) => String(entry.name))
        .filter((name) => name.endsWith(JSONL_EXTENSION))
        .sort();
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw new SessionPersistenceCorruptionError('cannot list stored sessions', { cause: error });
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
        const stored = await this.readArtifact(id, location);
        if (stored !== undefined) found.push({ meta: structuredClone(stored.meta), revision: stored.revision });
      } catch (error) {
        if (error instanceof SessionPersistenceCorruptionError || error instanceof SessionFormatUnsupportedError) throw error;
        /* an artifact that disappeared mid-list is treated as absent */
      }
    }
    return found;
  }
}

// Segmented v0.7 session storage: per-session SegmentedSessionLog instances
// with manifest validation and reconstruction of the plain JSONL text.
export class SegmentedSessionStore {
  private readonly logs = new Map<SessionId, SegmentedSessionLog>();

  constructor(
    private readonly fs: () => FileSystemAPI,
    private readonly root: string,
    private readonly onFlush?: () => Promise<void> | void,
  ) {}

  log(id: SessionId): SegmentedSessionLog {
    let log = this.logs.get(id);
    if (!log) {
      log = new SegmentedSessionLog(id, {
        fs: this.fs(),
        root: `${browserPathFor(this.root)}/segments`,
        onFlush: this.onFlush,
      });
      this.logs.set(id, log);
    }
    return log;
  }

  async readArtifact(id: SessionId, location: SessionLocation): Promise<StoredLog | undefined> {
    const log = this.log(id);
    let manifest: SessionSegmentManifest;
    try {
      manifest = await log.manifest();
    } catch (error) {
      if (error instanceof SessionSegmentCorruptionError && /does not exist/.test(error.message)) return undefined;
      if (error instanceof SessionSegmentCorruptionError) throw error;
      return undefined;
    }
    if (!manifest.header || !isSessionHeader(manifest.header) || manifest.header.id !== id || manifest.header.version !== SESSION_FORMAT_VERSION) {
      throw new SessionPersistenceCorruptionError(`stored session "${id}" has an invalid segmented header`);
    }
    const events = await log.readFrom(0);
    const raw = `${headerLine(manifest.header)}\n${events.map((event) => eventLine(event as unknown as SessionEvent)).join('\n')}${events.length ? '\n' : ''}`;
    return parseStoredLog(raw, id, location);
  }
}
