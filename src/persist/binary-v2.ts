// Persistence v2: binary WebContainer exports stored as generation-scoped chunks.
// This module deliberately has no Cordis or browser UI dependencies.  The browser
// owns IndexedDB; the execution world remains the source of truth for the export.

export const BINARY_SNAPSHOT_FORMAT_VERSION = 2 as const;
export const DEFAULT_BINARY_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_BINARY_QUOTA_BYTES = 256 * 1024 * 1024;

export interface BinarySnapshotManifest {
  formatVersion: typeof BINARY_SNAPSHOT_FORMAT_VERSION;
  instanceId: string;
  workspaceRoot: string;
  generation: number;
  fileCount?: number;
  chunkCount: number;
  byteSize: number;
  sha256: string;
  engineVersion?: string;
  lifoVersion?: string;
  pyodideVersion?: string;
  rubyVersion?: string;
  wasiVersion?: string;
  createdAt: number;
  excludedPaths: string[];
  /** Exact file/empty-directory inventory used by the restore adapter. */
  filePaths?: string[];
  emptyDirs?: string[];
  packageManifest?: unknown;
  degradation?: string[];
}

export interface BinarySnapshotPointer {
  current: number | null;
  lastKnownGood: number | null;
  updatedAt: number;
}

export interface BinarySnapshotExport {
  data: Uint8Array;
  manifest?: Partial<Omit<BinarySnapshotManifest, 'formatVersion' | 'generation' | 'chunkCount' | 'byteSize' | 'sha256' | 'createdAt'>>;
}

export interface BinarySnapshotOptions {
  dbName?: string;
  /** v0.6 database to inspect without importing or deleting it. */
  legacyDbName?: string;
  instanceId?: string;
  workspaceRoot?: string;
  chunkBytes?: number;
  maxBytes?: number;
  indexedDB?: IDBFactory;
  /** Used by tests and by hosts that already hold a WebContainer export. */
  exportBinary?: () => Promise<Uint8Array | ArrayBuffer>;
  /** Optional exact restore hook. It receives a verified complete export. */
  importBinary?: (data: Uint8Array, manifest: BinarySnapshotManifest) => Promise<void>;
}

export interface BinarySnapshotStore {
  save(data?: Uint8Array | ArrayBuffer, metadata?: BinarySnapshotExport['manifest']): Promise<BinarySnapshotManifest>;
  restore(generation?: number): Promise<{ data: Uint8Array; manifest: BinarySnapshotManifest } | null>;
  /** Verify the active generation without invoking importBinary. */
  verify(generation?: number): Promise<BinarySnapshotManifest | null>;
  pointer(): Promise<BinarySnapshotPointer>;
  manifest(generation?: number): Promise<BinarySnapshotManifest | null>;
  clear(): Promise<void>;
  detectLegacy(): Promise<{ detected: boolean; message?: string }>;
}

export class BinarySnapshotQuotaError extends Error {
  constructor(message = 'snapshot quota exceeded') {
    super(message);
    this.name = 'BinarySnapshotQuotaError';
  }
}

export class BinarySnapshotCorruptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BinarySnapshotCorruptionError';
  }
}

async function sha256(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', data.slice().buffer);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function asBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function validChunkSize(n: number | undefined): number {
  if (n === undefined) return DEFAULT_BINARY_CHUNK_BYTES;
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('chunkBytes must be a positive integer');
  return n;
}

function key(prefix: string, instanceId: string, generation: number, index?: number): string {
  return index === undefined ? `${instanceId}:${generation}` : `${instanceId}:${generation}:${index}`;
}

/**
 * Create an IndexedDB backed binary snapshot store.  A generation is considered
 * active only after all chunks, its manifest, and a hash verification complete.
 * The previous active generation is retained as the last-known-good pointer.
 */
export function createBinarySnapshotStore(options: BinarySnapshotOptions = {}): BinarySnapshotStore {
  const dbName = options.dbName ?? 'succinix-persist-v2';
  const legacyDbName = options.legacyDbName ?? 'succinix-persist';
  const instanceId = options.instanceId ?? 'default';
  const workspaceRoot = options.workspaceRoot ?? '/workspace';
  const chunkBytes = validChunkSize(options.chunkBytes);
  const maxBytes = options.maxBytes ?? DEFAULT_BINARY_QUOTA_BYTES;
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is unavailable');
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      // Version 2 deliberately keeps the v0.6 `snapshots` store intact.  An
      // existing v0.6 database therefore gets the new stores through a normal
      // IndexedDB upgrade and can be reported as legacy without being imported.
      const req = factory.open(dbName, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['snapshot-v2-chunks', 'snapshot-v2-manifests', 'snapshot-v2-pointers']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error('indexeddb open failed'));
      };
    });
    return dbPromise;
  };

  async function request<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      let requestResult: T;
      const tx = db.transaction(storeName, mode);
      const req = operation(tx.objectStore(storeName));
      req.onsuccess = () => { requestResult = req.result; };
      req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
      tx.oncomplete = () => resolve(requestResult);
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
    });
  }

  const pointerKey = instanceId;
  const readPointer = async (): Promise<BinarySnapshotPointer> =>
    (await request<BinarySnapshotPointer | undefined>('snapshot-v2-pointers', 'readonly', (s) => s.get(pointerKey)))
      ?? { current: null, lastKnownGood: null, updatedAt: 0 };

  async function readManifest(generation: number): Promise<BinarySnapshotManifest | null> {
    return (await request<BinarySnapshotManifest | undefined>('snapshot-v2-manifests', 'readonly', (s) => s.get(key('m', instanceId, generation)))) ?? null;
  }

  async function readGeneration(generation: number, manifest: BinarySnapshotManifest): Promise<Uint8Array> {
    const out = new Uint8Array(manifest.byteSize);
    let offset = 0;
    for (let index = 0; index < manifest.chunkCount; index++) {
      const chunk = await request<Uint8Array | ArrayBuffer | undefined>('snapshot-v2-chunks', 'readonly', (s) => s.get(key('c', instanceId, generation, index)));
      if (!chunk) throw new BinarySnapshotCorruptionError(`snapshot generation ${generation} is missing chunk ${index}`);
      const bytes = asBytes(chunk);
      out.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== manifest.byteSize) throw new BinarySnapshotCorruptionError(`snapshot generation ${generation} has an invalid byte size`);
    if (await sha256(out) !== manifest.sha256) throw new BinarySnapshotCorruptionError(`snapshot generation ${generation} failed SHA-256 verification`);
    return out;
  }

  async function quotaCheck(incoming: number, oldGeneration: number | null): Promise<void> {
    if (incoming > maxBytes) throw new BinarySnapshotQuotaError(`snapshot is ${incoming} bytes; limit is ${maxBytes}`);
    let oldBytes = 0;
    if (oldGeneration !== null) oldBytes = (await readManifest(oldGeneration))?.byteSize ?? 0;
    if (incoming + oldBytes > maxBytes) throw new BinarySnapshotQuotaError(`snapshot requires ${incoming + oldBytes} bytes while preserving the last-known-good generation; limit is ${maxBytes}`);
    try {
      const estimate = await globalThis.navigator?.storage?.estimate?.();
      if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.usage + incoming + oldBytes > estimate.quota) throw new BinarySnapshotQuotaError('browser storage quota exceeded');
    } catch (error) {
      if (error instanceof BinarySnapshotQuotaError) throw error;
      // StorageManager is optional (test environments and embedded browsers).
    }
  }

  const store: BinarySnapshotStore = {
    async save(input, metadata) {
      const source = input === undefined ? await options.exportBinary?.() : input;
      if (source === undefined) throw new Error('binary snapshot export is required');
      const data = asBytes(source);
      const old = await readPointer();
      await quotaCheck(data.byteLength, old.current);
      const generation = Math.max(old.current ?? 0, old.lastKnownGood ?? 0) + 1;
      const digest = await sha256(data);
      const manifest: BinarySnapshotManifest = {
        formatVersion: BINARY_SNAPSHOT_FORMAT_VERSION,
        instanceId,
        workspaceRoot,
        generation,
        chunkCount: Math.ceil(data.byteLength / chunkBytes),
        byteSize: data.byteLength,
        sha256: digest,
        createdAt: Date.now(),
        excludedPaths: [],
        ...metadata,
      };
      // Chunks are written independently.  The pointer is intentionally the last write.
      for (let i = 0; i < manifest.chunkCount; i++) {
        const start = i * chunkBytes;
        await request('snapshot-v2-chunks', 'readwrite', (s) => s.put(data.slice(start, start + chunkBytes), key('c', instanceId, generation, i)));
      }
      await request('snapshot-v2-manifests', 'readwrite', (s) => s.put(manifest, key('m', instanceId, generation)));
      await readGeneration(generation, manifest);
      await request('snapshot-v2-pointers', 'readwrite', (s) => s.put({ current: generation, lastKnownGood: old.current, updatedAt: Date.now() } satisfies BinarySnapshotPointer, pointerKey));
      return manifest;
    },
    async restore(generation) {
      const p = await readPointer();
      const candidates = generation === undefined
        ? [p.current, p.lastKnownGood].filter((n, i, all): n is number => n !== null && all.indexOf(n) === i)
        : [generation];
      if (!candidates.length) return null;
      let failure: unknown;
      for (const selected of candidates) {
        try {
          const manifest = await readManifest(selected);
          if (!manifest || manifest.formatVersion !== BINARY_SNAPSHOT_FORMAT_VERSION) throw new BinarySnapshotCorruptionError('snapshot manifest is missing or unsupported');
          const data = await readGeneration(selected, manifest);
          if (options.importBinary) await options.importBinary(data, manifest);
          return { data, manifest };
        } catch (error) {
          failure = error;
        }
      }
      throw failure instanceof Error ? failure : new BinarySnapshotCorruptionError('snapshot restore failed');
    },
    async verify(generation) {
      const p = await readPointer();
      const selected = generation ?? p.current ?? p.lastKnownGood;
      if (selected === null) return null;
      const manifest = await readManifest(selected);
      if (!manifest || manifest.formatVersion !== BINARY_SNAPSHOT_FORMAT_VERSION) throw new BinarySnapshotCorruptionError('snapshot manifest is missing or unsupported');
      await readGeneration(selected, manifest);
      return manifest;
    },
    pointer: readPointer,
    manifest: async (generation) => {
      const p = await readPointer();
      const selected = generation ?? p.current ?? p.lastKnownGood;
      return selected === null ? null : readManifest(selected);
    },
    async clear() {
      const p = await readPointer();
      const generations = [p.current, p.lastKnownGood].filter((n): n is number => n !== null);
      for (const generation of generations) {
        const m = await readManifest(generation);
        for (let i = 0; i < (m?.chunkCount ?? 0); i++) await request('snapshot-v2-chunks', 'readwrite', (s) => s.delete(key('c', instanceId, generation, i)));
        await request('snapshot-v2-manifests', 'readwrite', (s) => s.delete(key('m', instanceId, generation)));
      }
      await request('snapshot-v2-pointers', 'readwrite', (s) => s.delete(pointerKey));
    },
    async detectLegacy() {
      const db = await open();
      if (db.objectStoreNames.contains('snapshots')) return { detected: true, message: 'legacy snapshot detected' };
      // v0.6 used a separate `succinix-persist` database.  Open it at its
      // existing version (without an upgrade) and only inspect store names.
      if (legacyDbName !== dbName) {
        try {
          const listDatabases = (factory as unknown as { databases?: () => Promise<Array<{ name?: string }>> }).databases;
          if (listDatabases) {
            const known = await listDatabases.call(factory);
            if (!known.some((entry) => entry.name === legacyDbName)) return { detected: false };
          }
          const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open(legacyDbName);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error('legacy indexeddb open failed'));
          });
          const detected = legacy.objectStoreNames.contains('snapshots');
          legacy.close?.();
          if (detected) return { detected: true, message: 'legacy snapshot detected' };
        } catch {
          // A missing legacy database is the normal v0.7 first-boot path.
        }
      }
      return { detected: false };
    },
  };
  return store;
}

/** Convenience wrapper for a WebContainer-like object exposing export(). */
export function createWebContainerBinarySnapshotStore(container: { export(path: string, options: { format: 'binary' }): Promise<Uint8Array> }, options: Omit<BinarySnapshotOptions, 'exportBinary'> = {}): BinarySnapshotStore {
  const workdir = (container as { workdir?: string }).workdir;
  const scopeRoot = options.workspaceRoot ?? '/';
  const exportRoot = workdir ? (scopeRoot === '/' ? workdir : `${workdir}${scopeRoot}`) : scopeRoot;
  return createBinarySnapshotStore({ ...options, exportBinary: () => container.export(exportRoot, { format: 'binary' }) });
}
