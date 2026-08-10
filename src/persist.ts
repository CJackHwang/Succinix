// 快照持久化模块（TASK5 / M1）：把容器共享文件系统（wc.fs）的文本文件快照到 IndexedDB，
// boot 时恢复，实现"刷新/重开不丢数据"。核心洞察：容器 FS 快照 = 一切持久化。
//
// 存储：库 succinix-persist / store snapshots / key current，值为 { meta, files }。
// M1：persistenceKey 注入 —— createPersist({ dbName?, storeKey? }) 返回绑定全部状态的
// 闭包快照对象（save/load/clear/meta/force 一组），每个实例独立持有；缺省 = 现状
// succinix-persist/current（模块级默认实例，行为全等）。模块级缓存状态
// （lastSignature/lastSavedMeta/overLimitWarned/lastFullSaveAt/inflight/cleared/
// dbPromise/lastListingSig/lastCollected）全部实例化 —— 多实例共享会互相污染去重签名
// 与 in-flight 保存（静默丢数据），必须按实例隔离。
// POC 阶段文本为主：二进制文件跳过并计数（console.warn 报告），不做 base64。
// 尺寸保护：超过 ~50MB 跳过本次写（README 注明）。
import type { FileSystemAPI } from '@webcontainer/api';
import { log, LOG_FILE } from './log.js';
import { ensureParentDir } from './util.js';

// 快照元数据：版本号固定 1，恢复时校验用。
export interface SnapshotMeta {
  version: 1;
  savedAt: number;
  fileCount: number;
  totalBytes: number;
  /** 签名用文件数/总字节（不含 /var/log/succinix.log；旧快照无此字段时回落 fileCount/totalBytes） */
  sigFileCount?: number;
  sigTotalBytes?: number;
}

interface SnapshotRecord {
  meta: SnapshotMeta;
  files: Array<{ path: string; content: string }>;
  /** 空目录路径（TASK19：空目录不产生文件，快照不收录则刷新后丢失——如默认工作区 main） */
  emptyDirs?: string[];
}

// 保存结果：meta 为本次生效的元数据（成功写 IDB 或回落的上次值）；
// skipped=true 表示本次因超过 50MB 上限被跳过（未写 IDB），供 snapshot now 输出明确失败。
// reason（P0-1 / P4-13）：本次保存的原因 —— changed=内容/结构变化写盘；age=最大年龄强制写盘
// （见 AUTO_SNAPSHOT_FORCE_INTERVAL_MS，兜底等长编辑）；force=force 调用（snapshot now /
// pagehide flush）；dedup=内容未变跳过写；cleared=已清除标志挡掉 put；over-limit=超限跳过。
export interface SaveResult {
  meta: SnapshotMeta;
  skipped: boolean;
  reason: 'changed' | 'force' | 'age' | 'dedup' | 'cleared' | 'over-limit';
}

// POC 上限：~50MB。超过则跳过本次写并 console.warn。
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

// P0-1：自动快照「最大年龄强制」间隔。去重签名是「目录结构 + 文件数/总字节」，对
// 「内容变化但字节数不变」的等长编辑不可见；即使签名一致，超过该间隔也强制全量收集 + 写
// IDB 一次，把等长编辑的丢失窗口收敛到「发生在最近 30s 内且 tab 恰好崩溃」。浏览器侧
// force 路径（config/services/motd/workspace）仍即时落盘，此兜底只防 Lifo/shell 编辑。
export const AUTO_SNAPSHOT_FORCE_INTERVAL_MS = 30000;

// P0-1 决策提纯（可单测）：距上次真实写盘超过间隔 → 强制。lastFullSaveAt=0（未保存过）不强制。
export function isAgeForced(lastFullSaveAt: number, now: number, intervalMs: number = AUTO_SNAPSHOT_FORCE_INTERVAL_MS): boolean {
  return lastFullSaveAt > 0 && now - lastFullSaveAt >= intervalMs;
}

// 无快照/跳过时的空返回，避免调用方判空。
const EMPTY_META: SnapshotMeta = { version: 1, savedAt: 0, fileCount: 0, totalBytes: 0 };

// ─── 实例持久化上下文（M1：persistenceKey 注入）───

export interface PersistOptions {
  /** IndexedDB 库名（缺省 succinix-persist = 单实例现状） */
  dbName?: string;
  /** store 内记录 key（缺省 current = 单实例现状） */
  storeKey?: string;
}

export interface PersistContext {
  save(fs: FileSystemAPI, force?: boolean): Promise<SaveResult>;
  load(fs: FileSystemAPI): Promise<SnapshotMeta | null>;
  clear(): Promise<void>;
  meta(): Promise<SnapshotMeta | null>;
  /** 写盘成功后强制落盘（H1 / P2-6 收敛）：等长编辑也要持久。tag 供 console.warn 前缀 */
  force(fs: FileSystemAPI, tag?: string): Promise<void>;
}

// ─── 排除规则（快照遍历时跳过，避免 node_modules 巨量 & RPC 临时文件 & 重建缓存）───
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git']);
// host.js / lifo-core.js：运行时注入的 host 进程脚本，非用户数据（随 boot 重新注入）；
// cmd.json：文件 RPC 通道文件；succinix.engine.json：引擎配置（TASK21，随 boot 重写，非用户数据）。
const EXCLUDED_FILES = new Set(['host.js', 'lifo-core.js', 'cmd.json', 'succinix.engine.json']);
// TASK23：内置语言运行时系统资产（/usr/lib/succinix —— python-runtime.js + wasm/zip，~13MB）。
// 系统资产懒注入、随 boot 重建，非用户数据；排除避免每次快照遍历读 13MB 二进制。
const EXCLUDED_PREFIXES = ['/usr/lib/succinix'];
// 结果文件：/result-<id>.json（文件 RPC 每请求独立结果文件，瞬态）。
const RESULT_FILE_RE = /^\/result-\d+\.json$/;

// 快照遍历的排除判定（导出供单测）。
export function isExcludedPath(path: string): boolean {
  if (EXCLUDED_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) return true;
  const segments = path.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if (EXCLUDED_DIRS.has(segments[i])) return true;
    if (segments[i] === '.tinbase') return true;
  }
  const base = segments[segments.length - 1] ?? '';
  return EXCLUDED_FILES.has(base) || RESULT_FILE_RE.test(path);
}

// 日志文件：参与遍历（随快照持久），但不参与签名计算。
function isLogFile(path: string): boolean {
  return path === LOG_FILE;
}

// ─── 工厂：createPersist ───

export function createPersist(opts: PersistOptions = {}): PersistContext {
  const dbName = opts.dbName ?? 'succinix-persist';
  const storeKey = opts.storeKey ?? 'current';
  const storeName = 'snapshots';

  // ─── 遍历：递归 readdir + readFile，排除规则命中即剪枝 ───
  interface Collected {
    files: Array<{ path: string; content: string }>;
    totalBytes: number;
    /** 签名用文件数（不含 /var/log/succinix.log —— TASK16 R1：日志每条命令都在增长，计入签名会让自动快照每次全量重写） */
    sigFileCount: number;
    /** 签名用总字节（不含 /var/log/succinix.log） */
    sigTotalBytes: number;
    skipped: number;
    /** 空目录路径（TASK19：空目录要随快照收录，否则刷新后丢失） */
    emptyDirs: string[];
  }

  const EMPTY_COLLECT: Collected = { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 0, emptyDirs: [] };

  async function collectDir(fs: FileSystemAPI, dir: string): Promise<Collected> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return EMPTY_COLLECT; // 目录被并发删除（如 workspace rm 与自动快照竞争）：跳过该分支而非整批 reject
    }
    // TASK19：空目录（无任何条目）也要收录 —— 目录本身是状态（如空工作区），不收录则刷新后丢失。
    if (entries.length === 0) {
      return { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 0, emptyDirs: [dir] };
    }
    const parts = await Promise.all(
      entries.map(async (ent): Promise<Collected> => {
        const name = String(ent.name);
        const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
        if (isExcludedPath(path)) return EMPTY_COLLECT;
        if (ent.isDirectory()) return collectDir(fs, path);
        if (!ent.isFile()) return EMPTY_COLLECT; // symlink/未知类型不收集，避免死循环
        let content: string;
        try {
          content = await fs.readFile(path, 'utf8');
        } catch {
          return { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 1, emptyDirs: [] }; // 不可读（权限/二进制）跳过并计数
        }
        // 二进制启发：utf8 解码出现 U+FFFD 替换字符即视为二进制，跳过并计数（README 注明）
        if (content.includes('\uFFFD')) return { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 1, emptyDirs: [] };
        const excludedFromSig = isLogFile(path);
        return {
          files: [{ path, content }],
          totalBytes: content.length,
          sigFileCount: excludedFromSig ? 0 : 1,
          sigTotalBytes: excludedFromSig ? 0 : content.length,
          skipped: 0,
          emptyDirs: [],
        };
      })
    );
    return parts.reduce(
      (acc, r) => ({
        files: acc.files.concat(r.files),
        totalBytes: acc.totalBytes + r.totalBytes,
        sigFileCount: acc.sigFileCount + r.sigFileCount,
        sigTotalBytes: acc.sigTotalBytes + r.sigTotalBytes,
        skipped: acc.skipped + r.skipped,
        emptyDirs: acc.emptyDirs.concat(r.emptyDirs),
      }),
      { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 0, emptyDirs: [] }
    );
  }

  // ─── 遍历前门控：目录列表签名（TASK22 复审 R6）───
  // 自动快照每 ~2.5s 全量遍历容器 FS（readdir + 逐文件 readFile），空闲时是无谓开销。
  // 这里加一道 readdir 层面的轻量签名：递归读目录树（路径 + name:type，排除规则命中即剪枝），
  // 签名与上次全量遍历一致则直接复用上次结果，跳过遍历与读文件 —— 消除每 2.5s 的全量读。
  // 覆盖范围说明：readdir 结果不含文件大小（WebContainer DirEnt 无 size/stat），签名只捕捉
  // 目录结构变化（增/删/改名）；纯内容级修改（含等长）由 force 保存收录（config/motd/workspace
  // 写盘、snapshot now、pagehide 兜底），与既有内容盲签名的 H1 语义一致，不引入新的丢数据窗口。
  let lastListingSig: string | null = null;
  let lastCollected: Collected | null = null;

  // 递归 readdir 树结构签名：每目录输出 "path=name:type,..."（name 排序），子目录递归展开。
  async function computeListingSignature(fs: FileSystemAPI, dir: string): Promise<string> {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return `${dir}=ERR;`; // 并发删目录：标记该目录变化，门控不命中 → 走全量遍历（其内 try/catch 跳过）
    }
    const list: Array<{ name: string; path: string; isDir: boolean }> = [];
    for (const ent of entries) {
      const name = String(ent.name);
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      if (isExcludedPath(path)) continue;
      list.push({ name, path, isDir: ent.isDirectory() });
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const self = list.map((e) => `${e.name}:${e.isDir ? 'd' : 'f'}`).join(',');
    const childSigs = await Promise.all(list.filter((e) => e.isDir).map((e) => computeListingSignature(fs, e.path)));
    return `${dir}=${self};${childSigs.join('')}`;
  }

  // 带门控的收集：force 或目录列表签名变化时才全量遍历；签名一致则复用上次结果。
  // 存储的是遍历前计算的签名：若遍历期间 FS 又变，存储签名已过期，下次比对不命中 → 自动再全量遍历，
  // 不会复用可能错过最新变更的旧结果。
  async function collectWithGate(fs: FileSystemAPI, force: boolean): Promise<Collected> {
    let sig: string | null;
    try {
      sig = await computeListingSignature(fs, '/');
    } catch {
      sig = null; // 签名计算异常：按"不可用"处理，本次与下次都走全量遍历兜底
    }
    if (!force && lastListingSig !== null && lastCollected && sig !== null && sig === lastListingSig) {
      return lastCollected;
    }
    const collected = await collectDir(fs, '/');
    lastListingSig = sig;
    lastCollected = collected;
    return collected;
  }

  // ─── IndexedDB：原生 API + 轻量 promise 封装（不新增依赖）───
  let dbPromise: Promise<IDBDatabase> | null = null;

  function getDB(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          dbPromise = null; // 失败后允许下次调用重试打开
          reject(req.error ?? new Error('indexeddb open failed'));
        };
      });
    }
    return dbPromise;
  }

  // 通用事务封装：fn 里发起一个请求，事务提交时 resolve 该请求的结果。
  function idbReq<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return getDB().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const txn = db.transaction(storeName, mode);
          const req = fn(txn.objectStore(storeName));
          txn.oncomplete = () => resolve(req.result);
          txn.onerror = () => reject(txn.error ?? new Error('indexeddb transaction error'));
          txn.onabort = () => reject(txn.error ?? new Error('indexeddb transaction aborted'));
        })
    );
  }

  // ─── 快照缓存：内容（文件数/总字节）未变不写 IDB（自动快照高频调用的去重）───
  // N2（TASK20）：去重签名额外纳入 emptyDirs —— 仅空目录变化（裸 mkdir + 刷新）时文件数/总字节
  // 不变，旧签名会跳过写 IDB 造成空目录丢失。emptyDirsKey 对空目录路径排序后拼接，顺序无关稳定。
  let lastSignature = { fileCount: -1, totalBytes: -1, emptyDirsKey: '' };
  let lastSavedMeta: SnapshotMeta | null = null;
  let overLimitWarned = false;
  // P0-1：最近一次真实写盘时间戳（IDB put 时更新）。自动快照据此判定"最大年龄强制"。
  let lastFullSaveAt = 0;
  // 重入保护：并发调用复用同一个进行中的保存 Promise。
  let inflight: Promise<SaveResult> | null = null;
  // "已清除"脏标志：clearSnapshot 置位后，任何进行中/稍后开始的保存都跳过 put，防止把已删快照复活。
  let cleared = false;

  // 保存快照：遍历当前容器 FS，写 IndexedDB。force=true 跳过内容缓存强制写（snapshot now）。
  // 并发语义：非 force 调用共享进行中的保存；force 调用必须等当前完成后**重跑一次**——
  // 否则会被并发非 force 快照的"内容未变跳过写"降级复用，造成 snapshot now 假成功。
  function save(fs: FileSystemAPI, force = false): Promise<SaveResult> {
    if (!inflight) {
      inflight = doSave(fs, force).finally(() => {
        inflight = null;
      });
      return inflight;
    }
    if (!force) return inflight;
    return inflight.then(() => save(fs, true));
  }

  async function doSave(fs: FileSystemAPI, force: boolean): Promise<SaveResult> {
    // P0-1：超过最大年龄间隔（30s）即使签名一致也强制全量收集 + 写 IDB 一次，兜底等长编辑。
    const ageForced = isAgeForced(lastFullSaveAt, Date.now());
    const collected = await collectWithGate(fs, force || ageForced);
    if (collected.totalBytes > MAX_SNAPSHOT_BYTES) {
      if (!overLimitWarned) {
        console.warn(`[persist] snapshot skipped: ${collected.totalBytes} bytes exceeds ${MAX_SNAPSHOT_BYTES} limit`);
        overLimitWarned = true;
      }
      return { meta: lastSavedMeta ?? EMPTY_META, skipped: true, reason: 'over-limit' };
    }
    overLimitWarned = false;

    const fileCount = collected.files.length;
    const totalBytes = collected.totalBytes;
    // 签名用计数：不含 /var/log/succinix.log（日志每条命令都在增长，计入则自动快照每次全量重写）。
    const sigFileCount = collected.sigFileCount;
    const sigTotalBytes = collected.sigTotalBytes;
    // N2：空目录参与去重签名（排序拼接，顺序无关）——裸 mkdir + 刷新的空目录变化必须写 IDB。
    const emptyDirsKey = collected.emptyDirs.slice().sort().join('\u0000');
    // 内容未变则跳过写（自动快照去重）；force / ageForced 强制保存（ageForced 兜底等长编辑）。
    if (!force && !ageForced && lastSavedMeta && lastSignature.fileCount === sigFileCount && lastSignature.totalBytes === sigTotalBytes && lastSignature.emptyDirsKey === emptyDirsKey) {
      return { meta: lastSavedMeta, skipped: false, reason: 'dedup' };
    }
    // 已清除：禁止 put 回写复活已删快照，也不更新缓存（clearSnapshot 已重置）。
    if (cleared) return { meta: lastSavedMeta ?? EMPTY_META, skipped: false, reason: 'cleared' };

    const meta: SnapshotMeta = { version: 1, savedAt: Date.now(), fileCount, totalBytes, sigFileCount, sigTotalBytes };
    const record: SnapshotRecord = { meta, files: collected.files, emptyDirs: collected.emptyDirs };
    await idbReq('readwrite', (s) => s.put(record, storeKey));
    lastFullSaveAt = Date.now();
    lastSignature = { fileCount: sigFileCount, totalBytes: sigTotalBytes, emptyDirsKey };
    lastSavedMeta = meta;
    if (collected.skipped > 0) {
      console.warn(`[persist] snapshot saved: ${fileCount} files, ${totalBytes} bytes (skipped ${collected.skipped} binary/unreadable)`);
    }
    return { meta, skipped: false, reason: force ? 'force' : ageForced ? 'age' : 'changed' };
  }

  // 恢复快照：有则逐文件写回容器 FS，返回元数据；无快照返回 null（全新系统）。
  async function load(fs: FileSystemAPI): Promise<SnapshotMeta | null> {
    const record = await idbReq<SnapshotRecord | undefined>('readonly', (s) => s.get(storeKey));
    if (!record) return null;
    for (const f of record.files) {
      await ensureParentDir(fs, f.path);
      await fs.writeFile(f.path, f.content);
    }
    // TASK19：恢复空目录（旧快照无 emptyDirs 字段时跳过，向后兼容）。
    for (const d of record.emptyDirs ?? []) {
      try {
        await fs.mkdir(d, { recursive: true });
      } catch {
        /* 目录已存在等，恢复继续 */
      }
    }
    lastSavedMeta = record.meta;
    // 签名回落：旧快照无 sig 字段时用全量计数（迁移兼容）；emptyDirs 同步回填（N2）。
    lastSignature = {
      fileCount: record.meta.sigFileCount ?? record.meta.fileCount,
      totalBytes: record.meta.sigTotalBytes ?? record.meta.totalBytes,
      emptyDirsKey: (record.emptyDirs ?? []).slice().sort().join('\u0000'),
    };
    // 恢复写回了整树：目录列表签名缓存已过期，置空让下一次保存重新全量遍历（避免复用恢复前的结果）。
    lastListingSig = null;
    lastCollected = null;
    // P0-1 修复：lastFullSaveAt 恢复到「现在」—— 否则刷新后它为 0，而空闲时（内容未变
    // 一直 dedup）又永不更新，isAgeForced 恒为 false，最大年龄强制（30s 兜底等长 shell 编辑）
    // 在整个会话里永不触发，等长编辑的丢失窗口变成无界。恢复时归零到当前时间，让 30s 窗口
    // 从本次恢复起重新计时（恢复的这张快照即视为刚落盘）。
    lastFullSaveAt = Date.now();
    // TASK12：快照事件采集点（INFO）——恢复成功后记录（写回先完成，日志行追加在旧日志尾部）。
    void log('INFO', `snapshot restored: ${record.meta.fileCount} files, ${record.meta.totalBytes} bytes`);
    return record.meta;
  }

  // 清除快照（= 重置系统，下次启动全新）。
  // 防止复活：先置"已清除"脏标志，再等可能的 in-flight 保存结束，最后删除。
  // 标志挡掉清除期间新开始的保存，等待挡掉清除前已在途的 put——两步合起来保证没有回写复活。
  async function clear(): Promise<void> {
    cleared = true;
    try {
      const pending = inflight;
      if (pending) {
        try {
          await pending;
        } catch {
          /* 进行中保存失败不影响清除 */
        }
      }
      await idbReq('readwrite', (s) => s.delete(storeKey));
      lastSavedMeta = null;
      lastSignature = { fileCount: -1, totalBytes: -1, emptyDirsKey: '' };
      lastListingSig = null;
      lastCollected = null;
      lastFullSaveAt = 0; // 清除后下次保存按正常路径（不年龄强制）
      overLimitWarned = false;
    } finally {
      cleared = false;
    }
  }

  // 查看持久化状态：只读元数据，不触碰容器 FS。
  async function meta(): Promise<SnapshotMeta | null> {
    const record = await idbReq<SnapshotRecord | undefined>('readonly', (s) => s.get(storeKey));
    return record?.meta ?? null;
  }

  // 写盘成功后强制落盘（H1 / P2-6 收敛）：快照去重签名是「目录结构 + 文件数/总字节」，
  // 对「内容变更但字节数不变」的等长编辑不可见。浏览器侧写入（env/settings/motd/服务定义/
  // workspace switch）必须写盘后强制保存一次，否则等长修改只落在容器 FS、不随快照持久。
  // tag 供 console.warn 前缀（config/services/motd 各打自己模块名，便于定位）。
  // 单次 save(fs, true) 已足够：persist 的 inflight 重入保护里，force 调用若遇并发
  // 自动快照会先等其完成再重跑一次全量保存（save 内部逻辑），无需调用方重复保存。
  async function force(fs: FileSystemAPI, tag = 'persist'): Promise<void> {
    try {
      await save(fs, true);
    } catch (e) {
      // 文件已写盘成功，快照失败只记日志，不打断配置命令（与自动快照的降级一致）。
      console.warn(`[${tag}] force snapshot after write failed:`, e);
    }
  }

  return { save, load, clear, meta, force };
}

// ─── 默认实例（单实例路径 = 现状 succinix-persist/current，行为全等）───
const defaultPersist = createPersist();

// 向后兼容导出：既有调用方（boot/main/commands/config/services/motd/tests）不改。
export function saveSnapshot(fs: FileSystemAPI, force = false): Promise<SaveResult> {
  return defaultPersist.save(fs, force);
}
export function loadSnapshot(fs: FileSystemAPI): Promise<SnapshotMeta | null> {
  return defaultPersist.load(fs);
}
export function clearSnapshot(): Promise<void> {
  return defaultPersist.clear();
}
export function getSnapshotMeta(): Promise<SnapshotMeta | null> {
  return defaultPersist.meta();
}
export async function forcePersist(fs: FileSystemAPI, tag = 'persist'): Promise<void> {
  return defaultPersist.force(fs, tag);
}
