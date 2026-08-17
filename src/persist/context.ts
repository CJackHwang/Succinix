// createPersist 闭包实现（O4）。实例注册表与默认 facade 位于 registry.ts。
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
  type BinarySnapshotContainer,
  type PersistStatus,
} from './types.js';
import { excludedByInstanceScope, isExcludedPath } from './exclusions.js';
import { makeCollector } from './collect.js';
import { makeIdb } from './idb.js';
import {
  BinarySnapshotCorruptionError,
  BinarySnapshotQuotaError,
  createBinarySnapshotStore,
  type BinarySnapshotStore,
} from './binary-v2.js';
import { collectBinaryInstanceExcludes, listSnapshotTreePaths, removeStaleSnapshotPaths } from './snapshot-tree.js';

export function createPersist(opts: PersistOptions = {}): PersistContext {
  const dbName = opts.dbName ?? 'succinix-persist';
  const storeKey = opts.storeKey ?? 'current';
  const storeName = 'snapshots';
  const scopeRoot = opts.scopeRoot ?? '/';
  const extraPrefixes = opts.excludePrefixes ?? [];
  const includeGit = opts.includeGit === true;
  const instanceScope = opts.instanceScope;
  const shouldSkip = (path: string): boolean =>
    isExcludedPath(path, { includeGit }) ||
    (instanceScope
      ? excludedByInstanceScope(path, instanceScope, extraPrefixes)
      : extraPrefixes.some((p) => path === p || path.startsWith(p + '/')));
  const collector = makeCollector(scopeRoot, shouldSkip);
  const { idbReq } = makeIdb(dbName, storeName);

  // v0.7 production contexts bind a WebContainer and therefore use the binary
  // export path.  The unbound text adapter below is retained only for existing
  // SDK callers that provide a FileSystemAPI but cannot provide a container.
  let container: BinarySnapshotContainer | undefined = opts.container;
  let binary: BinarySnapshotStore | undefined;
  let restoreFs: FileSystemAPI | undefined;
  let binaryDynamicExcludes: string[] = [];
  let watcher: { close(): void } | undefined;
  let persistStatus: PersistStatus = 'clean';
  let dirtyRevision = 0;
  let savedDirtyRevision = 0;
  const dirtyListeners = new Set<() => void>();

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

  function bindContainer(next: BinarySnapshotContainer): void {
    if (container === next && binary) return;
    // Test harnesses and older embedders may expose only `wc.fs`. Keep the
    // explicit v0.6 adapter in that case; a real WebContainer always has both
    // export and mount and therefore takes v0.7 by default.
    if (typeof next.export !== 'function' || typeof next.mount !== 'function') {
      container = undefined;
      binary = undefined;
      return;
    }
    watcher?.close();
    container = next;
    // WebContainer resolves export() paths against the container root, while
    // the fs API and mount() resolve absolute paths against the container
    // workdir (the fs-space '/' IS the workdir).  Exporting the fs-space
    // scopeRoot by name would either capture the whole container root (for
    // '/', baking in the random /home/<id> prefix) or fail with ENOENT (for
    // '/workspace').  Map the fs-space scope to its container-root absolute
    // path through the container's workdir when it is available.
    const workdir = next.workdir;
    const exportRoot = workdir ? (scopeRoot === '/' ? workdir : `${workdir}${scopeRoot}`) : scopeRoot;
    const binaryDbName = opts.binary?.dbName ?? (opts.dbName ? `${opts.dbName}-v2` : 'succinix-persist-v2');
    binary = createBinarySnapshotStore({
      dbName: binaryDbName,
      legacyDbName: opts.dbName ?? 'succinix-persist',
      instanceId: storeKey,
      workspaceRoot: scopeRoot,
      chunkBytes: opts.binary?.chunkBytes,
      maxBytes: opts.binary?.maxBytes,
      exportBinary: () => {
        if (!container) throw new Error('binary snapshot container is not bound');
        return container.export(exportRoot, {
          format: 'binary',
          excludes: [
            '**/node_modules/**',
            '**/dist/**',
            ...(includeGit ? [] : ['**/.git/**']),
            '**/.succinix-terminal/**',
            '**/.succinix-control/**',
            '**/.succinix-userland/**',
            ...binaryDynamicExcludes,
            ...extraPrefixes.map((prefix) => `${prefix.replace(/^\//, '')}/**`),
          ],
        });
      },
      importBinary: async (data, manifest) => {
        if (!container || !restoreFs) throw new Error('binary snapshot restore target is not bound');
        await container.mount(data, { mountPoint: scopeRoot });
        await removeStaleSnapshotPaths(restoreFs, scopeRoot, shouldSkip, manifest);
      },
    });
    try {
      watcher = (next as BinarySnapshotContainer & { fs?: FileSystemAPI }).fs?.watch(scopeRoot, { recursive: true }, () => markDirty());
    } catch {
      // FS watch is an optimisation/dirty signal. The max-age flush remains a
      // correctness backstop on runtimes that do not expose recursive watch.
    }
  }

  function markDirty(): void {
    dirtyRevision++;
    if (persistStatus !== 'saving') persistStatus = 'dirty';
    for (const listener of [...dirtyListeners]) listener();
  }

  async function doSaveV2(fs: FileSystemAPI, force: boolean): Promise<SaveResult> {
    if (!binary) throw new Error('binary snapshot store is not available');
    persistStatus = 'saving';
    try {
      const ageForced = isAgeForced(lastFullSaveAt, Date.now());
      const dirty = dirtyRevision !== savedDirtyRevision;
      const effectiveForce = force || ageForced || dirty;
      const collected = await collector.collectWithGate(fs, effectiveForce);
      binaryDynamicExcludes = await collectBinaryInstanceExcludes(fs, scopeRoot, instanceScope);
      // The text collector intentionally skips binary/unreadable files for the
      // legacy metadata path. v2's exact restore inventory must still include
      // every directory entry so a binary file is never deleted after mount.
      const inventory = await listSnapshotTreePaths(fs, scopeRoot, shouldSkip);
      const emptyDirsKey = collected.emptyDirs.slice().sort().join('\u0000');
      if (!effectiveForce && lastSavedMeta && lastSignature.fileCount === collected.sigFileCount && lastSignature.totalBytes === collected.sigTotalBytes && lastSignature.emptyDirsKey === emptyDirsKey) {
        persistStatus = 'clean';
        return { meta: lastSavedMeta, skipped: false, reason: 'dedup' };
      }
      if (cleared) return { meta: lastSavedMeta ?? EMPTY_META, skipped: false, reason: 'cleared' };
      const manifest = await binary.save(undefined, {
        fileCount: inventory.files.length,
        filePaths: inventory.files.sort(),
        emptyDirs: collected.emptyDirs.slice().sort(),
        excludedPaths: ['/node_modules', '/dist', ...(includeGit ? [] : ['/.git']), ...extraPrefixes],
        degradation: collected.skipped ? [`${collected.skipped} unreadable paths excluded from the inventory`] : undefined,
      });
      const meta: SnapshotMeta = {
        version: 1,
        savedAt: manifest.createdAt,
        fileCount: inventory.files.length,
        totalBytes: manifest.byteSize,
        sigFileCount: collected.sigFileCount,
        sigTotalBytes: collected.sigTotalBytes,
      };
      lastFullSaveAt = Date.now();
      lastSignature = { fileCount: collected.sigFileCount, totalBytes: collected.sigTotalBytes, emptyDirsKey };
      lastSavedMeta = meta;
      savedDirtyRevision = dirtyRevision;
      persistStatus = 'saved';
      return { meta, skipped: false, reason: force ? 'force' : ageForced ? 'age' : 'changed' };
    } catch (error) {
      persistStatus = error instanceof BinarySnapshotQuotaError ? 'quota-exceeded' : error instanceof BinarySnapshotCorruptionError ? 'corrupt' : 'degraded';
      throw error;
    }
  }

  async function doLoadV2(fs: FileSystemAPI): Promise<SnapshotMeta | null> {
    if (!binary) throw new Error('binary snapshot store is not available');
    restoreFs = fs;
    try {
      const restored = await binary.restore();
      if (!restored) {
        const legacy = await binary.detectLegacy();
        if (legacy.detected) console.warn(`[persist] ${legacy.message}`);
        persistStatus = legacy.detected ? 'degraded' : 'clean';
        return null;
      }
      const { manifest } = restored;
      const meta: SnapshotMeta = {
        version: 1,
        savedAt: manifest.createdAt,
        fileCount: manifest.fileCount ?? 0,
        totalBytes: manifest.byteSize,
      };
      lastSavedMeta = meta;
      lastFullSaveAt = Date.now();
      savedDirtyRevision = dirtyRevision;
      collector.invalidate();
      persistStatus = 'saved';
      return meta;
    } catch (error) {
      persistStatus = error instanceof BinarySnapshotCorruptionError ? 'corrupt' : 'degraded';
      throw error;
    } finally {
      restoreFs = undefined;
    }
  }

  // 保存快照：遍历当前容器 FS，写 IndexedDB。force=true 跳过内容缓存强制写（snapshot now）。
  // 并发语义：非 force 调用共享进行中的保存；force 调用必须等当前完成后**重跑一次**——
  // 否则会被并发非 force 快照的"内容未变跳过写"降级复用，造成 snapshot now 假成功。
  function save(fs: FileSystemAPI, force = false): Promise<SaveResult> {
    if (!inflight) {
      inflight = (binary ? doSaveV2(fs, force) : doSave(fs, force)).finally(() => {
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
    if (binary) return doLoadV2(fs);
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
      if (binary) await binary.clear();
      else await idbReq('readwrite', (s) => s.delete(storeKey));
      lastSavedMeta = null;
      lastSignature = { fileCount: -1, totalBytes: -1, emptyDirsKey: '' };
      collector.invalidate();
      lastFullSaveAt = 0; // 清除后下次保存按正常路径（不年龄强制）
      overLimitWarned = false;
      persistStatus = 'clean';
    } finally {
      cleared = false;
    }
  }

  // 查看持久化状态：只读元数据，不触碰容器 FS。
  async function meta(): Promise<SnapshotMeta | null> {
    if (binary) {
      const manifest = await binary.manifest();
      if (!manifest) return null;
      return {
        version: 1,
        savedAt: manifest.createdAt,
        fileCount: manifest.fileCount ?? 0,
        totalBytes: manifest.byteSize,
      };
    }
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

  if (container) bindContainer(container);
  return {
    save,
    load,
    clear,
    meta,
    force,
    bindContainer,
    markDirty,
    onDirty: (listener) => {
      dirtyListeners.add(listener);
      return () => dirtyListeners.delete(listener);
    },
    status: () => persistStatus,
    dispose: () => {
      watcher?.close();
      dirtyListeners.clear();
    },
  };
}
