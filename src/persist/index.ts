// 快照持久化公开面（O4）：类型 + 工厂 + 实例注册表 + 默认实例兼容导出。
export {
  MAX_SNAPSHOT_BYTES,
  AUTO_SNAPSHOT_FORCE_INTERVAL_MS,
  isAgeForced,
  EMPTY_META,
} from './types.js';
export type { SnapshotMeta, SnapshotRecord, SaveResult, PersistOptions, PersistContext } from './types.js';
export { isExcludedPath, excludedByInstanceScope } from './exclusions.js';
export {
  createPersist,
  instancePersistKey,
  getPersist,
  saveSnapshot,
  loadSnapshot,
  clearSnapshot,
  getSnapshotMeta,
  forcePersist,
} from './context.js';
