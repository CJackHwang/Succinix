// 快照持久化契约（O4）：类型 / 常量 / 纯决策函数。实现见 context.ts（createPersist 闭包）。
import type { FileSystemAPI } from '@webcontainer/api';

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

export interface SnapshotRecord {
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
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

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
export const EMPTY_META: SnapshotMeta = { version: 1, savedAt: 0, fileCount: 0, totalBytes: 0 };

// ─── 实例持久化上下文（M1：persistenceKey 注入）───

export interface PersistOptions {
  /** IndexedDB 库名（缺省 succinix-persist = 单实例现状） */
  dbName?: string;
  /** store 内记录 key（缺省 current = 单实例现状） */
  storeKey?: string;
  /** 快照遍历根（D4，缺省 '/' = 整棵 FS，单实例现状全等）。实例化时传实例 scope
   *  （如 /workspace —— 状态根 / 用户 home / 工作区都在其下），避免收录无关系统目录。 */
  scopeRoot?: string;
  /** 实例归属（D4，同页多实例）：快照只收录本实例的状态根与用户 home，
   *  跳过其他实例的 `.succinix-*` 状态根（含其 tinbase）与其他用户的 home。
   *  自定义布局（非内置前缀）的宿主可用 excludePrefixes 补充排除。 */
  instanceScope?: { stateRoot?: string; home?: string };
  /** 额外排除前缀（路径或子树，快照遍历剪枝用；宿主自定义布局的逃生舱）。 */
  excludePrefixes?: string[];
}

export interface PersistContext {
  save(fs: FileSystemAPI, force?: boolean): Promise<SaveResult>;
  load(fs: FileSystemAPI): Promise<SnapshotMeta | null>;
  clear(): Promise<void>;
  meta(): Promise<SnapshotMeta | null>;
  /** 写盘成功后强制落盘（H1 / P2-6 收敛）：等长编辑也要持久。tag 供 console.warn 前缀 */
  force(fs: FileSystemAPI, tag?: string): Promise<void>;
}
