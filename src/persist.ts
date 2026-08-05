// 快照持久化模块（TASK5）：把容器共享文件系统（wc.fs）的文本文件快照到 IndexedDB，
// boot 时恢复，实现"刷新/重开不丢数据"。核心洞察：容器 FS 快照 = 一切持久化。
//
// 存储：库 webunix-persist / store snapshots / key current，值为 { meta, files }。
// POC 阶段文本为主：二进制文件跳过并计数（console.warn 报告），不做 base64。
// 尺寸保护：超过 ~50MB 跳过本次写（README 注明）。
import type { FileSystemAPI } from '@webcontainer/api';
import { log, LOG_FILE } from './log.js';

// 快照元数据：版本号固定 1，恢复时校验用。
export interface SnapshotMeta {
  version: 1;
  savedAt: number;
  fileCount: number;
  totalBytes: number;
  /** 签名用文件数/总字节（不含 /var/log/webunix.log；旧快照无此字段时回落 fileCount/totalBytes） */
  sigFileCount?: number;
  sigTotalBytes?: number;
}

interface SnapshotRecord {
  meta: SnapshotMeta;
  files: Array<{ path: string; content: string }>;
}

// 保存结果：meta 为本次生效的元数据（成功写 IDB 或回落的上次值）；
// skipped=true 表示本次因超过 50MB 上限被跳过（未写 IDB），供 snapshot now 输出明确失败。
export interface SaveResult {
  meta: SnapshotMeta;
  skipped: boolean;
}

const DB_NAME = 'webunix-persist';
const STORE_NAME = 'snapshots';
const KEY = 'current';

// POC 上限：~50MB。超过则跳过本次写并 console.warn。
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

// 无快照/跳过时的空返回，避免调用方判空。
const EMPTY_META: SnapshotMeta = { version: 1, savedAt: 0, fileCount: 0, totalBytes: 0 };

// ─── 排除规则（快照遍历时跳过，避免 node_modules 巨量 & RPC 临时文件 & 重建缓存）───
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git']);
// host.js / lifo-core.js：运行时注入的 host 进程脚本，非用户数据（随 boot 重新注入）；
// cmd.json：文件 RPC 通道文件。
const EXCLUDED_FILES = new Set(['host.js', 'lifo-core.js', 'cmd.json']);

function isResultFile(name: string): boolean {
  return name.startsWith('result-') && name.endsWith('.json');
}

// 命中排除即剪枝：node_modules/dist/.git 任意层级整体跳过；
// .tinbase/storage（可重建的存储缓存，数据在 .tinbase/ 其他目录）整树跳过；
// 文件按名跳过 host.js / lifo-core.js（boot 重新注入的 host 进程脚本）/ cmd.json / result-*.json（文件 RPC 临时文件）。
function isExcludedPath(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if (EXCLUDED_DIRS.has(segments[i])) return true;
    if (segments[i] === '.tinbase' && segments[i + 1] === 'storage') return true;
  }
  const base = segments[segments.length - 1] ?? '';
  return EXCLUDED_FILES.has(base) || isResultFile(base);
}

// ─── 遍历：递归 readdir + readFile，排除规则命中即剪枝 ───
interface Collected {
  files: Array<{ path: string; content: string }>;
  totalBytes: number;
  /** 签名用文件数（不含 /var/log/webunix.log —— TASK16 R1：日志每条命令都在增长，计入签名会让自动快照每次全量重写） */
  sigFileCount: number;
  /** 签名用总字节（不含 /var/log/webunix.log） */
  sigTotalBytes: number;
  skipped: number;
}

const EMPTY_COLLECT: Collected = { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 0 };

// 日志文件：参与遍历（随快照持久），但不参与签名计算。
function isLogFile(path: string): boolean {
  return path === LOG_FILE;
}

async function collectDir(fs: FileSystemAPI, dir: string): Promise<Collected> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return EMPTY_COLLECT; // 目录被并发删除（如 workspace rm 与自动快照竞争）：跳过该分支而非整批 reject
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
        return { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 1 }; // 不可读（权限/二进制）跳过并计数
      }
      // 二进制启发：utf8 解码出现 U+FFFD 替换字符即视为二进制，跳过并计数（README 注明）
      if (content.includes('\uFFFD')) return { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 1 };
      const excludedFromSig = isLogFile(path);
      return {
        files: [{ path, content }],
        totalBytes: content.length,
        sigFileCount: excludedFromSig ? 0 : 1,
        sigTotalBytes: excludedFromSig ? 0 : content.length,
        skipped: 0,
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
    }),
    { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 0 }
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
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
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
        const txn = db.transaction(STORE_NAME, mode);
        const req = fn(txn.objectStore(STORE_NAME));
        txn.oncomplete = () => resolve(req.result);
        txn.onerror = () => reject(txn.error ?? new Error('indexeddb transaction error'));
        txn.onabort = () => reject(txn.error ?? new Error('indexeddb transaction aborted'));
      })
  );
}

// ─── 快照缓存：内容（文件数/总字节）未变不写 IDB（自动快照高频调用的去重）───
let lastSignature = { fileCount: -1, totalBytes: -1 };
let lastSavedMeta: SnapshotMeta | null = null;
let overLimitWarned = false;
// 重入保护：并发调用复用同一个进行中的保存 Promise。
let inflight: Promise<SaveResult> | null = null;
// "已清除"脏标志：clearSnapshot 置位后，任何进行中/稍后开始的保存都跳过 put，防止把已删快照复活。
let cleared = false;

// 保存快照：遍历当前容器 FS，写 IndexedDB。force=true 跳过内容缓存强制写（snapshot now）。
// 并发语义：非 force 调用共享进行中的保存；force 调用必须等当前完成后**重跑一次**——
// 否则会被并发非 force 快照的"内容未变跳过写"降级复用，造成 snapshot now 假成功。
export function saveSnapshot(fs: FileSystemAPI, force = false): Promise<SaveResult> {
  if (!inflight) {
    inflight = doSave(fs, force).finally(() => {
      inflight = null;
    });
    return inflight;
  }
  if (!force) return inflight;
  return inflight.then(() => saveSnapshot(fs, true));
}

async function doSave(fs: FileSystemAPI, force: boolean): Promise<SaveResult> {
  const collected = await collectWithGate(fs, force);
  if (collected.totalBytes > MAX_SNAPSHOT_BYTES) {
    if (!overLimitWarned) {
      console.warn(`[persist] snapshot skipped: ${collected.totalBytes} bytes exceeds ${MAX_SNAPSHOT_BYTES} limit`);
      overLimitWarned = true;
    }
    return { meta: lastSavedMeta ?? EMPTY_META, skipped: true };
  }
  overLimitWarned = false;

  const fileCount = collected.files.length;
  const totalBytes = collected.totalBytes;
  // 签名用计数：不含 /var/log/webunix.log（日志每条命令都在增长，计入则自动快照每次全量重写）。
  const sigFileCount = collected.sigFileCount;
  const sigTotalBytes = collected.sigTotalBytes;
  // 内容未变则跳过写（自动快照去重）；force 供手动 snapshot now 强制保存。
  if (!force && lastSavedMeta && lastSignature.fileCount === sigFileCount && lastSignature.totalBytes === sigTotalBytes) {
    return { meta: lastSavedMeta, skipped: false };
  }
  // 已清除：禁止 put 回写复活已删快照，也不更新缓存（clearSnapshot 已重置）。
  if (cleared) return { meta: lastSavedMeta ?? EMPTY_META, skipped: false };

  const meta: SnapshotMeta = { version: 1, savedAt: Date.now(), fileCount, totalBytes, sigFileCount, sigTotalBytes };
  const record: SnapshotRecord = { meta, files: collected.files };
  await idbReq('readwrite', (s) => s.put(record, KEY));
  lastSignature = { fileCount: sigFileCount, totalBytes: sigTotalBytes };
  lastSavedMeta = meta;
  if (collected.skipped > 0) {
    console.warn(`[persist] snapshot saved: ${fileCount} files, ${totalBytes} bytes (skipped ${collected.skipped} binary/unreadable)`);
  }
  return { meta, skipped: false };
}

// 恢复快照：有则逐文件写回容器 FS，返回元数据；无快照返回 null（全新系统）。
export async function loadSnapshot(fs: FileSystemAPI): Promise<SnapshotMeta | null> {
  const record = await idbReq<SnapshotRecord | undefined>('readonly', (s) => s.get(KEY));
  if (!record) return null;
  for (const f of record.files) {
    await ensureParentDir(fs, f.path);
    await fs.writeFile(f.path, f.content);
  }
  lastSavedMeta = record.meta;
  // 签名回落：旧快照无 sig 字段时用全量计数（迁移兼容）。
  lastSignature = {
    fileCount: record.meta.sigFileCount ?? record.meta.fileCount,
    totalBytes: record.meta.sigTotalBytes ?? record.meta.totalBytes,
  };
  // 恢复写回了整树：目录列表签名缓存已过期，置空让下一次保存重新全量遍历（避免复用恢复前的结果）。
  lastListingSig = null;
  lastCollected = null;
  // TASK12：快照事件采集点（INFO）——恢复成功后记录（写回先完成，日志行追加在旧日志尾部）。
  void log('INFO', `snapshot restored: ${record.meta.fileCount} files, ${record.meta.totalBytes} bytes`);
  return record.meta;
}

async function ensureParentDir(fs: FileSystemAPI, path: string): Promise<void> {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return; // 根目录直接文件，无父目录
  try {
    await fs.mkdir(path.slice(0, idx), { recursive: true });
  } catch {
    /* 目录已存在等，恢复继续 */
  }
}

// 清除快照（= 重置系统，下次启动全新）。
// 防止复活：先置"已清除"脏标志，再等可能的 in-flight 保存结束，最后删除。
// 标志挡掉清除期间新开始的保存，等待挡掉清除前已在途的 put——两步合起来保证没有回写复活。
export async function clearSnapshot(): Promise<void> {
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
    await idbReq('readwrite', (s) => s.delete(KEY));
    lastSavedMeta = null;
    lastSignature = { fileCount: -1, totalBytes: -1 };
    lastListingSig = null;
    lastCollected = null;
    overLimitWarned = false;
  } finally {
    cleared = false;
  }
}

// 查看持久化状态：只读元数据，不触碰容器 FS。
export async function getSnapshotMeta(): Promise<SnapshotMeta | null> {
  const record = await idbReq<SnapshotRecord | undefined>('readonly', (s) => s.get(KEY));
  return record?.meta ?? null;
}
