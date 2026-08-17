// 快照持久化公开面（O4）：类型 + 工厂 + 实例注册表 + 默认实例兼容导出。
export {
  MAX_SNAPSHOT_BYTES,
  AUTO_SNAPSHOT_FORCE_INTERVAL_MS,
  isAgeForced,
  EMPTY_META,
} from './types.js';
export type {
  BinarySnapshotContainer,
  PersistStatus,
  SnapshotController,
  SnapshotMeta,
  SnapshotRecord,
  SaveResult,
  PersistOptions,
  PersistContext,
} from './types.js';
export { isExcludedPath, excludedByInstanceScope } from './exclusions.js';
export { createPersist } from './context.js';
export {
  instancePersistKey,
  getPersist,
  saveSnapshot,
  loadSnapshot,
  clearSnapshot,
  getSnapshotMeta,
  forcePersist,
} from './registry.js';
export {
  BINARY_SNAPSHOT_FORMAT_VERSION,
  DEFAULT_BINARY_CHUNK_BYTES,
  DEFAULT_BINARY_QUOTA_BYTES,
  BinarySnapshotQuotaError,
  BinarySnapshotCorruptionError,
  createBinarySnapshotStore,
  createWebContainerBinarySnapshotStore,
} from './binary-v2.js';
export type {
  BinarySnapshotManifest,
  BinarySnapshotPointer,
  BinarySnapshotExport,
  BinarySnapshotOptions,
  BinarySnapshotStore,
} from './binary-v2.js';
export {
  SESSION_SEGMENT_FORMAT_VERSION,
  DEFAULT_SESSION_SEGMENT_EVENTS,
  DEFAULT_SESSION_SEGMENT_BYTES,
  SessionSegmentCorruptionError,
  SessionSequenceError,
  SegmentedSessionLog,
} from './session-segments.js';
export type {
  SessionSegmentEvent,
  SessionSegmentDescriptor,
  SessionSegmentManifest,
  SegmentedSessionOptions,
} from './session-segments.js';
