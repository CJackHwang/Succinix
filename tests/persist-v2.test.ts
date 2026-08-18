import { describe, expect, it, vi } from 'vitest';
import type { FileSystemAPI } from '@webcontainer/api';
import {
  BinarySnapshotCorruptionError,
  BinarySnapshotQuotaError,
  type BinarySnapshotContainer,
  createBinarySnapshotStore,
  createPersist,
  isExcludedPath,
  SegmentedSessionLog,
} from '../src/persist/index.js';
import { FakeFS } from './helpers/fakes.js';

type InspectableIDBFactory = IDBFactory & {
  store(dbName: string, storeName: string): Map<string, unknown>;
  ensureStore(dbName: string, storeName: string): Map<string, unknown>;
};

function fakeIndexedDB(): InspectableIDBFactory {
  const databases = new Map<string, Map<string, Map<string, unknown>>>();
  const ensureDb = (name: string) => {
    let stores = databases.get(name);
    if (!stores) {
      stores = new Map();
      databases.set(name, stores);
    }
    return stores;
  };
  const ensureStore = (dbName: string, storeName: string) => {
    const stores = ensureDb(dbName);
    let store = stores.get(storeName);
    if (!store) {
      store = new Map();
      stores.set(storeName, store);
    }
    return store;
  };
  function objectStore(map: Map<string, unknown>) {
    const request = (result: unknown) => {
      const req: Record<string, unknown> = { result, onsuccess: null, onerror: null };
      queueMicrotask(() => (req.onsuccess as (() => void) | null)?.());
      return req as unknown as IDBRequest;
    };
    return { put: (v: unknown, k: unknown) => { map.set(String(k), v); return request(v); }, get: (k: unknown) => request(map.get(String(k))), delete: (k: unknown) => { map.delete(String(k)); return request(undefined); } };
  }
  return {
    open: (name = 'default') => {
      const stores = ensureDb(name);
      const db = {
        objectStoreNames: { contains: (storeName: string) => stores.has(storeName) },
        createObjectStore(storeName: string) { return objectStore(ensureStore(name, storeName)); },
        transaction(storeName: string) {
          const map = ensureStore(name, storeName);
          let complete: (() => void) | null = null;
          const tx: Record<string, unknown> = { objectStore: () => objectStore(map), onerror: null, onabort: null };
          Object.defineProperty(tx, 'oncomplete', { get: () => complete, set: (value: (() => void) | null) => { complete = value; queueMicrotask(() => complete?.()); } });
          return tx;
        },
        close() {},
      } as unknown as IDBDatabase;
      const req: Record<string, unknown> = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => { (req.onupgradeneeded as (() => void) | null)?.(); (req.onsuccess as (() => void) | null)?.(); });
      return req as unknown as IDBOpenDBRequest;
    },
    databases: async () => [...databases.keys()].map((name) => ({ name })),
    store: (dbName: string, storeName: string) => ensureStore(dbName, storeName),
    ensureStore,
  } as unknown as InspectableIDBFactory;
}

describe('binary persistence v2', () => {
  it('stores chunked generations and retains LKG', async () => {
    const store = createBinarySnapshotStore({ indexedDB: fakeIndexedDB(), instanceId: 'i', chunkBytes: 3 });
    const a = await store.save(new Uint8Array([1, 2, 3, 4]));
    const b = await store.save(new Uint8Array([5, 6]));
    expect(a.generation).toBe(1);
    expect(b.generation).toBe(2);
    expect((await store.pointer()).lastKnownGood).toBe(1);
    expect([...((await store.restore())?.data ?? [])]).toEqual([5, 6]);
    expect([...((await store.restore(1))?.data ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('falls back to LKG when current data is corrupt', async () => {
    const indexedDB = fakeIndexedDB();
    const store = createBinarySnapshotStore({ indexedDB, instanceId: 'i', chunkBytes: 3 });
    await store.save(new Uint8Array([1, 2, 3]));
    await store.save(new Uint8Array([4, 5, 6]));
    indexedDB.store('succinix-persist-v2', 'snapshot-v2-chunks').delete('i:2:0');
    await expect(store.verify()).rejects.toBeInstanceOf(BinarySnapshotCorruptionError);
    expect([...((await store.restore())?.data ?? [])]).toEqual([1, 2, 3]);
  });

  it('rejects quota overflow before the new generation becomes current', async () => {
    const indexedDB = fakeIndexedDB();
    const store = createBinarySnapshotStore({ indexedDB, instanceId: 'i', maxBytes: 6 });
    await store.save(new Uint8Array([1, 2, 3, 4]));
    await expect(store.save(new Uint8Array([5, 6, 7]))).rejects.toBeInstanceOf(BinarySnapshotQuotaError);
    expect((await store.pointer()).current).toBe(1);
    expect((await store.pointer()).lastKnownGood).toBeNull();
  });

  it('detects a legacy snapshot database without importing it', async () => {
    const indexedDB = fakeIndexedDB();
    indexedDB.ensureStore('succinix-persist', 'snapshots');
    const store = createBinarySnapshotStore({
      indexedDB,
      dbName: 'succinix-persist-v2',
      legacyDbName: 'succinix-persist',
      instanceId: 'i',
    });
    await expect(store.detectLegacy()).resolves.toEqual({ detected: true, message: 'legacy snapshot detected' });
    expect(indexedDB.store('succinix-persist', 'snapshots')).toBeDefined();
  });

  it('is the bound instance default and removes files absent from the verified snapshot', async () => {
    const indexedDB = fakeIndexedDB();
    const previousIndexedDB = globalThis.indexedDB;
    Object.assign(globalThis, { indexedDB });
    const source = new FakeFS();
    await source.writeFile('/workspace/kept.txt', 'kept');
    await source.writeFile('/workspace/.tinbase/db', 'tinbase-db');
    await source.writeFile('/workspace/binary.bin', new Uint8Array([0, 255, 1]));
    let restoreTarget: FakeFS | undefined;
    const dbName = `persist-v2-context-${Math.random()}`;
    const container = {
      fs: source as unknown as FileSystemAPI,
      export: async () => new Uint8Array([1, 2, 3]),
      mount: async (_data: Uint8Array, options?: { mountPoint?: string }) => {
        const root = options?.mountPoint ?? '/';
        await restoreTarget?.writeFile(`${root === '/' ? '' : root}/workspace/kept.txt`, 'kept');
        await restoreTarget?.writeFile(`${root === '/' ? '' : root}/workspace/.tinbase/db`, 'tinbase-db');
        await restoreTarget?.writeFile(`${root === '/' ? '' : root}/workspace/binary.bin`, new Uint8Array([0, 255, 1]));
      },
    };
    try {
      const persist = createPersist({ container, binary: { dbName } });
      await persist.save(source as unknown as FileSystemAPI, true);
      expect(isExcludedPath('/workspace/.tinbase/db')).toBe(false);
      expect(isExcludedPath('/workspace/.succinix-c-1/tinbase/db')).toBe(false);
      const pointer = indexedDB.store(dbName, 'snapshot-v2-pointers').get('current') as { current: number | null } | undefined;
      const manifest = indexedDB.store(dbName, 'snapshot-v2-manifests').get(`current:${pointer?.current ?? 0}`) as { filePaths?: string[] } | undefined;
      expect(manifest?.filePaths).toEqual(expect.arrayContaining(['/workspace/.tinbase/db', '/workspace/binary.bin']));
      const target = new FakeFS();
      await target.writeFile('/workspace/stale.txt', 'stale');
      restoreTarget = target;
      await persist.load(target as unknown as FileSystemAPI);
      expect(target.raw('/workspace/kept.txt')).toBe('kept');
      expect(target.raw('/workspace/.tinbase/db')).toBe('tinbase-db');
      expect(target.raw('/workspace/binary.bin')).toEqual(new Uint8Array([0, 255, 1]));
      expect(target.has('/workspace/stale.txt')).toBe(false);
      expect(target.has('/workspace/restore-debug.txt')).toBe(false);
    } finally {
      Object.assign(globalThis, { indexedDB: previousIndexedDB });
    }
  });

  it('leaves the target byte-for-byte unchanged when stale cleanup fails during restore', async () => {
    const previousIndexedDB = globalThis.indexedDB;
    Object.assign(globalThis, { indexedDB: fakeIndexedDB() });
    const target = new FakeFS();
    await target.writeFile('/saved.txt', 'snapshot');
    const originalRm = target.rm.bind(target);
    let rejectStaleDelete = false;
    target.rm = async (path: string) => {
      if (rejectStaleDelete && path === '/old.txt') throw new Error('stale delete interrupted');
      await originalRm(path);
    };
    const container = {
      fs: target as unknown as FileSystemAPI,
      export: async () => target.has('/old.txt') ? new Uint8Array([0]) : new Uint8Array([1]),
      mount: async (data: Uint8Array, options?: { mountPoint?: string }) => {
        const root = options?.mountPoint ?? '/';
        const file = data[0] === 0 ? 'old.txt' : 'saved.txt';
        const content = data[0] === 0 ? 'original' : 'snapshot';
        await target.writeFile(`${root === '/' ? '' : root}/${file}`, content);
      },
    };
    try {
      const persist = createPersist({ container, binary: { dbName: `persist-v2-rollback-${Math.random()}` } });
      await persist.save(target as unknown as FileSystemAPI, true);
      await target.rm('/saved.txt');
      await target.writeFile('/old.txt', 'original');
      rejectStaleDelete = true;

      await expect(persist.load(target as unknown as FileSystemAPI)).rejects.toThrow('stale delete interrupted');
      expect(target.raw('/old.txt')).toBe('original');
      expect(target.has('/saved.txt')).toBe(false);
    } finally {
      Object.assign(globalThis, { indexedDB: previousIndexedDB });
    }
  });

  it('keeps the verified generation intact after a staging mount transfers its buffer', async () => {
    const previousIndexedDB = globalThis.indexedDB;
    Object.assign(globalThis, { indexedDB: fakeIndexedDB() });
    const source = new FakeFS();
    await source.writeFile('/saved.txt', 'snapshot');
    const target = new FakeFS();
    const container = {
      fs: source as unknown as FileSystemAPI,
      export: async () => new Uint8Array([1]),
      mount: async (data: Uint8Array, options?: { mountPoint?: string }) => {
        const root = options?.mountPoint ?? '/';
        if (root.includes('.succinix-restore-stage-')) {
          await target.writeFile(`${root}/saved.txt`, 'snapshot');
          data.fill(0);
          return;
        }
        await target.writeFile('/saved.txt', data[0] === 1 ? 'snapshot' : 'corrupted');
      },
    };
    try {
      const persist = createPersist({ container, binary: { dbName: `persist-v2-transfer-${Math.random()}` } });
      await persist.save(source as unknown as FileSystemAPI, true);
      await persist.load(target as unknown as FileSystemAPI);
      expect(target.raw('/saved.txt')).toBe('snapshot');
    } finally {
      Object.assign(globalThis, { indexedDB: previousIndexedDB });
    }
  });

  it('rejects a staging empty-directory inventory mismatch before touching the target', async () => {
    const previousIndexedDB = globalThis.indexedDB;
    Object.assign(globalThis, { indexedDB: fakeIndexedDB() });
    const source = new FakeFS();
    await source.mkdir('/empty-workspace', { recursive: true });
    const target = new FakeFS();
    await target.writeFile('/keep.txt', 'keep');
    let finalMounts = 0;
    const container = {
      fs: source as unknown as FileSystemAPI,
      export: async () => new Uint8Array([7]),
      mount: async (_data: Uint8Array, options?: { mountPoint?: string }) => {
        const root = options?.mountPoint ?? '/';
        if (root.includes('.succinix-restore-stage-')) return;
        finalMounts++;
      },
    };
    try {
      const persist = createPersist({ container, binary: { dbName: `persist-v2-empty-dir-${Math.random()}` } });
      await persist.save(source as unknown as FileSystemAPI, true);

      await expect(persist.load(target as unknown as FileSystemAPI)).rejects.toThrow(/empty-directory inventory/);
      expect(finalMounts).toBe(0);
      expect(target.raw('/keep.txt')).toBe('keep');
    } finally {
      Object.assign(globalThis, { indexedDB: previousIndexedDB });
    }
  });

  it('maps fs-space scopeRoot to the container workdir for export while keeping mount at the scope root', async () => {
    const previousIndexedDB = globalThis.indexedDB;
    Object.assign(globalThis, { indexedDB: fakeIndexedDB() });
    const calls: Array<{ op: string; path?: string; mountPoint?: string }> = [];
    const container = {
      workdir: '/home/succinix-app',
      export: async (path: string) => {
        calls.push({ op: 'export', path });
        return new Uint8Array([9, 9, 9]);
      },
      mount: async (_data: Uint8Array, options?: { mountPoint?: string }) => {
        calls.push({ op: 'mount', mountPoint: options?.mountPoint });
      },
    };
    try {
      const persist = createPersist({ container, binary: { dbName: `persist-v2-workdir-${Math.random()}` } });
      await persist.save(new FakeFS() as unknown as FileSystemAPI, true);
      const dst = new FakeFS();
      await persist.load(dst as unknown as FileSystemAPI);
      expect(calls.filter((c) => c.op === 'export').map((c) => c.path)).toEqual(['/home/succinix-app', '/home/succinix-app']);
      expect(calls.filter((c) => c.op === 'mount').map((c) => c.mountPoint)).toEqual([
        expect.stringMatching(/^\/.succinix-restore-stage-/), '/',
      ]);
    } finally {
      Object.assign(globalThis, { indexedDB: previousIndexedDB });
    }
  });

  it('maps a /workspace instance scope to the matching container-root path', async () => {
    const previousIndexedDB = globalThis.indexedDB;
    Object.assign(globalThis, { indexedDB: fakeIndexedDB() });
    const calls: Array<{ op: string; path?: string; mountPoint?: string }> = [];
    const container = {
      workdir: '/home/succinix-app',
      export: async (path: string) => {
        calls.push({ op: 'export', path });
        return new Uint8Array([1]);
      },
      mount: async (_data: Uint8Array, options?: { mountPoint?: string }) => {
        calls.push({ op: 'mount', mountPoint: options?.mountPoint });
      },
    };
    try {
      const persist = createPersist({
        container,
        scopeRoot: '/workspace',
        binary: { dbName: `persist-v2-workdir-ws-${Math.random()}` },
      });
      await persist.save(new FakeFS() as unknown as FileSystemAPI, true);
      const dst = new FakeFS();
      await persist.load(dst as unknown as FileSystemAPI);
      expect(calls.filter((c) => c.op === 'export').map((c) => c.path)).toEqual(['/home/succinix-app/workspace', '/home/succinix-app/workspace']);
      expect(calls.filter((c) => c.op === 'mount').map((c) => c.mountPoint)).toEqual([
        expect.stringMatching(/^\/workspace\/.succinix-restore-stage-/), '/workspace',
      ]);
    } finally {
      Object.assign(globalThis, { indexedDB: previousIndexedDB });
    }
  });

  it('uses the same runtime-file exclusions for binary export and restore inventory', async () => {
    const previousIndexedDB = globalThis.indexedDB;
    Object.assign(globalThis, { indexedDB: fakeIndexedDB() });
    let exportOptions: { format: string; excludes?: string[] } | undefined;
    const container = {
      export: async (_path: string, options: { format: string; excludes?: string[] }) => {
        exportOptions = options;
        return new Uint8Array([1]);
      },
      mount: async () => {},
    };
    try {
      const persist = createPersist({ container, binary: { dbName: `persist-v2-excludes-${Math.random()}` } });
      await persist.save(new FakeFS() as unknown as FileSystemAPI, true);
      expect(exportOptions?.excludes).toEqual(expect.arrayContaining([
        '**/host.js',
        '**/cmd.json',
        '**/result-*.json',
        '**/.succinix-terminal/**',
        '**/usr/lib/succinix/**',
      ]));
    } finally {
      Object.assign(globalThis, { indexedDB: previousIndexedDB });
    }
  });

  it('closes watchers on rebind and dispose while tracking dirty state', async () => {
    const previousIndexedDB = globalThis.indexedDB;
    Object.assign(globalThis, { indexedDB: fakeIndexedDB() });
    const closes: string[] = [];
    const makeContainer = (label: string) => ({
      fs: {
        watch: () => ({ close: () => closes.push(label) }),
      },
      export: async () => new Uint8Array([1]),
      mount: async () => {},
    });
    try {
      const persist = createPersist({ binary: { dbName: `persist-v2-watch-${Math.random()}` } });
      persist.bindContainer?.(makeContainer('one') as unknown as BinarySnapshotContainer);
      persist.markDirty?.();
      expect(persist.status?.()).toBe('dirty');
      persist.bindContainer?.(makeContainer('two') as unknown as BinarySnapshotContainer);
      persist.dispose?.();
      expect(closes).toEqual(['one', 'two']);
    } finally {
      Object.assign(globalThis, { indexedDB: previousIndexedDB });
    }
  });
});

describe('segmented session JSONL', () => {
  it('splits by event count and reads from a sequence', async () => {
    const fs = new FakeFS();
    const log = new SegmentedSessionLog('s', { fs: fs as unknown as FileSystemAPI, root: '/sessions', segmentMaxEvents: 2 });
    await log.create(1);
    await log.append([0, 1, 2, 3].map((seq) => ({ type: 'event', seq, data: { seq } })));
    expect((await log.manifest()).segments).toHaveLength(2);
    expect((await log.readFrom(2)).map((event) => event.seq)).toEqual([2, 3]);
    expect((await log.readRaw()).split('\n').filter(Boolean)).toHaveLength(4);
  });

  it('repairs a torn tail and resumes sequencing', async () => {
    const fs = new FakeFS();
    const log = new SegmentedSessionLog('s', { fs: fs as unknown as FileSystemAPI, root: '/sessions', segmentMaxEvents: 2 });
    await log.create(1);
    await log.append([0, 1].map((seq) => ({ type: 'event', seq, data: { seq } })));
    await fs.writeFile('/sessions/s.0.jsonl', '{"type":"event","seq":0,"data":{"seq":0}}\n{"type":"event","seq":1');
    expect((await log.readFrom(0)).map((event) => event.seq)).toEqual([0]);
    await log.append([{ type: 'event', seq: 1, data: { seq: 1 } }]);
    expect((await log.manifest()).nextSeq).toBe(2);
    expect((await log.readRaw()).split('\n').filter(Boolean).map((line) => JSON.parse(line).seq)).toEqual([0, 1]);
  });

  it('flushes pending work and cancels the debounce timer on dispose', async () => {
    vi.useFakeTimers();
    try {
      const fs = new FakeFS();
      const flushes: number[] = [];
      const log = new SegmentedSessionLog('s', {
        fs: fs as unknown as FileSystemAPI,
        root: '/sessions',
        flushDebounceMs: 50,
        onFlush: async () => { flushes.push(Date.now()); },
      });
      await log.create(1);
      await log.append([{ type: 'event', seq: 0 }]);
      await vi.advanceTimersByTimeAsync(49);
      expect(flushes).toHaveLength(0);
      await log.flush();
      expect(flushes).toHaveLength(1);
      await log.append([{ type: 'event', seq: 1 }]);
      log.dispose();
      await vi.advanceTimersByTimeAsync(100);
      expect(flushes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
