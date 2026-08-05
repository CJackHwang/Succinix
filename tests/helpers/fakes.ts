// 单元测试共享辅助（TASK20）：内存版 FileSystemAPI、最小 indexedDB、可脚本化 TerminalClient。
// 只覆盖被测模块用到的 API 子集；在测试里以 `as unknown as FileSystemAPI` 传入。

// ─── 内存 FileSystemAPI ───
export interface FakeDirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export class FakeFS {
  /** path → content；null = 目录 */
  private entries = new Map<string, string | null>();

  constructor() {
    this.entries.set('/', null);
  }

  private norm(p: string): string {
    const cleaned = p.replace(/\/+/g, '/');
    return cleaned.length > 1 && cleaned.endsWith('/') ? cleaned.slice(0, -1) : cleaned;
  }

  private ensureDirs(p: string): void {
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      if (!this.entries.has(cur)) this.entries.set(cur, null);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = this.norm(path);
    const idx = p.lastIndexOf('/');
    if (idx > 0) this.ensureDirs(p.slice(0, idx));
    this.entries.set(p, content);
  }

  async readFile(path: string, _encoding?: string): Promise<string> {
    const p = this.norm(path);
    const v = this.entries.get(p);
    if (v === undefined) throw new Error(`ENOENT: no such file ${path}`);
    if (v === null) throw new Error(`EISDIR: illegal operation on a directory ${path}`);
    return v;
  }

  async mkdir(path: string, _opts?: { recursive?: boolean }): Promise<void> {
    const p = this.norm(path);
    this.ensureDirs(p);
    this.entries.set(p, null);
  }

  async rm(path: string): Promise<void> {
    const p = this.norm(path);
    this.entries.delete(p);
    const prefix = p === '/' ? '/' : p + '/';
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }

  async readdir(path: string, _opts?: { withFileTypes?: boolean }): Promise<FakeDirEntry[]> {
    const dir = this.norm(path);
    if (!this.entries.has(dir)) throw new Error(`ENOENT: ${path}`);
    if (this.entries.get(dir) !== null) throw new Error(`ENOTDIR: ${path}`);
    const prefix = dir === '/' ? '/' : dir + '/';
    const names = new Set<string>();
    for (const k of this.entries.keys()) {
      if (k === dir || !k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const name = rest.split('/')[0];
      if (name) names.add(name);
    }
    return [...names].sort().map((name) => {
      const child = this.entries.get(prefix + name);
      return {
        name,
        isFile: () => child !== null && child !== undefined,
        isDirectory: () => child === null,
      };
    });
  }

  /** 测试辅助：路径是否存在 */
  has(path: string): boolean {
    return this.entries.has(this.norm(path));
  }

  /** 测试辅助：直接读原始内容（目录返回 null，缺失返回 undefined，不抛错） */
  raw(path: string): string | null | undefined {
    return this.entries.get(this.norm(path));
  }
}

// ─── 最小 indexedDB（persist 的 open/transaction/put/get/delete 子集）───
export interface FakeIDB {
  indexedDB: IDBFactory;
  store: Map<string, unknown>;
  /** 累计 put 次数（去重断言用：内容未变应不再 put） */
  readonly puts: number;
  /** 累计 delete 次数 */
  readonly deletes: number;
  /** 清空 store 与计数（beforeEach 用；persist 模块级 dbPromise 引用同一 fake） */
  reset(): void;
}

export function installFakeIDB(): FakeIDB {
  const store = new Map<string, unknown>();
  const STORE_NAME = 'snapshots';
  const counters = { puts: 0, deletes: 0 };

  const objectStore = {
    put: (value: unknown, key: unknown) => {
      counters.puts++;
      store.set(String(key), value);
      return { result: value };
    },
    get: (key: unknown) => ({ result: store.get(String(key)) }),
    delete: (key: unknown) => {
      counters.deletes++;
      store.delete(String(key));
      return { result: undefined };
    },
  };

  const db: IDBDatabase = {
    objectStoreNames: { contains: (n: string) => n === STORE_NAME } as unknown as DOMStringList,
    createObjectStore: () => objectStore as unknown as IDBObjectStore,
    transaction: () => {
      const txn = {
        objectStore: () => objectStore,
        oncomplete: null as null | (() => void),
        onerror: null,
        onabort: null,
      };
      queueMicrotask(() => txn.oncomplete?.());
      return txn as unknown as IDBTransaction;
    },
  } as unknown as IDBDatabase;

  const openReq = {
    result: db,
    onupgradeneeded: null as null | (() => void),
    onsuccess: null as null | (() => void),
    onerror: null as null | (() => void),
  };

  return {
    indexedDB: {
      open: () => {
        // 在调用 open() 时调度 success：getDB() 是同步给 onsuccess 赋值的，
        // 微任务在其后的同一 tick 触发，保证模块级 dbPromise 缓存也能拿到。
        queueMicrotask(() => {
          openReq.onupgradeneeded?.();
          openReq.onsuccess?.();
        });
        return openReq as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory,
    store,
    get puts() {
      return counters.puts;
    },
    get deletes() {
      return counters.deletes;
    },
    reset() {
      store.clear();
      counters.puts = 0;
      counters.deletes = 0;
    },
  };
}

// ─── 可脚本化 TerminalClient（services/pkg 用）───
export interface CallRecord {
  command: string;
  opts?: Record<string, unknown>;
  timeout?: number;
}

export interface FakeClientOptions {
  /** 默认 terminal 响应（未命中 handlers 时） */
  terminal?: (command: string) => unknown;
  /** 默认 spawn 响应 */
  spawn?: (command: string) => unknown;
}

export class FakeClient {
  terminalCalls: CallRecord[] = [];
  spawnCalls: CallRecord[] = [];
  private terminalHandler?: (command: string) => unknown;
  private spawnHandler?: (command: string) => unknown;

  constructor(opts: FakeClientOptions = {}) {
    this.terminalHandler = opts.terminal;
    this.spawnHandler = opts.spawn;
  }

  async terminal(command: string, opts?: Record<string, unknown>, timeout?: number): Promise<unknown> {
    this.terminalCalls.push({ command, opts, timeout });
    if (this.terminalHandler) return this.terminalHandler(command);
    return { ok: true, stdout: '' };
  }

  async spawn(command: string, opts?: Record<string, unknown>, timeout?: number): Promise<unknown> {
    this.spawnCalls.push({ command, opts, timeout });
    if (this.spawnHandler) return this.spawnHandler(command);
    return { ok: true, pid: 123, runtime: 'node' };
  }

  /** 便捷：按命令前缀/精确匹配注册一次响应 */
  whenTerminal(command: string, result: unknown): void {
    const prev = this.terminalHandler;
    this.terminalHandler = (c) => (c === command ? result : prev ? prev(c) : { ok: true, stdout: '' });
  }
}
