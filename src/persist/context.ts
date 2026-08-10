// createPersist 闭包实现（O4）+ 实例持久化上下文注册表（M1/M2）。
// 模块级缓存状态（lastSignature/lastSavedMeta/overLimitWarned/lastFullSaveAt/inflight/
// cleared/lastListingSig/lastCollected/dbPromise）全部实例化 —— 多实例共享会互相污染
// 去重签名与 in-flight 保存（静默丢数据），必须按实例隔离。
import type { FileSystemAPI } from '@webcontainer/api';
import { log } from '../log.js';
import { ensureParentDir } from '../util.js';
import {
  MAX_SNAPSHOT_BYTES,
  isAgeForced,
  EMPTY_META,
  type SnapshotMeta,
  type SnapshotRecord,
  type SaveResult,
  type PersistOptions,
  type PersistContext,
} from './types.js';
import { excludedByInstanceScope, isExcludedPath } from './exclusions.js';
import { makeCollector } from './collect.js';
import { makeIdb } from './idb.js';

export function createPersist(opts: PersistOptions = {}): PersistContext {
  const dbName = opts.dbName ?? 'succinix-persist';
  const storeKey = opts.storeKey ?? 'current';
  const storeName = 'snapshots';
  const scopeRoot = opts.scopeRoot ?? '/';
  const extraPrefixes = opts.excludePrefixes ?? [];
  const instanceScope = opts.instanceScope;
  const shouldSkip = (path: string): boolean =>
    isExcludedPath(path) ||
    (instanceScope
      ? excludedByInstanceScope(path, instanceScope, extraPrefixes)
      : extraPrefixes.some((p) => path === p || path.startsWith(p + '/')));
  const collector = makeCollector(scopeRoot, shouldSkip);
  const { idbReq } = makeIdb(dbName, storeName);

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
    const collected = await collector.collectWithGate(fs, force || ageForced);
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
    collector.invalidate();
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
      collector.invalidate();
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

// ─── 实例持久化上下文注册表（M2：config/motd/services 的 force 落盘按实例取用）───
// 非默认实例默认用 storeKey `instance:<id>`（同库不同 key，互不覆盖）；宿主可经
// createSuccinixInstance({ persistence }) 传入自定义 dbName/storeKey（M5）。
export function instancePersistKey(instanceId: string): string {
  return instanceId === 'default' ? 'current' : `instance:${instanceId}`;
}

const persistContexts = new Map<string, PersistContext>();

/** 取实例持久化上下文（惰性创建并缓存；缺省 = 模块级默认实例，行为全等现状）。
 *  scope（D4）：实例化时传 { scopeRoot, instanceScope }，同页快照按实例归属隔离；
 *  首次调用即缓存该 scope，后续 getPersist(instanceId) 复用同一上下文。 */
export function getPersist(instanceId = 'default', scope?: PersistOptions): PersistContext {
  let ctx = persistContexts.get(instanceId);
  if (!ctx) {
    ctx = createPersist(
      instanceId === 'default' ? { ...scope } : { storeKey: instancePersistKey(instanceId), ...scope }
    );
    persistContexts.set(instanceId, ctx);
  }
  return ctx;
}

// ─── 默认实例（单实例路径 = 现状 succinix-persist/current，行为全等）───
const defaultPersist = getPersist();

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
