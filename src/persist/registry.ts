import type { FileSystemAPI } from '@webcontainer/api';
import { createPersist } from './context.js';
import type { PersistContext, PersistOptions, SaveResult, SnapshotMeta } from './types.js';

/** 实例持久化上下文注册表：默认实例保留既有公开 facade。 */
export function instancePersistKey(instanceId: string): string {
  return instanceId === 'default' ? 'current' : `instance:${instanceId}`;
}

const persistContexts = new Map<string, PersistContext>();

export function getPersist(instanceId = 'default', scope?: PersistOptions): PersistContext {
  let context = persistContexts.get(instanceId);
  if (!context) {
    context = createPersist(
      instanceId === 'default' ? { ...scope } : { storeKey: instancePersistKey(instanceId), ...scope },
    );
    persistContexts.set(instanceId, context);
  }
  return context;
}

const defaultPersist = getPersist();

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
