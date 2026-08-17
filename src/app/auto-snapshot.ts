// 执行世界的 dirty 信号驱动正常快照路径；未暴露文件监听的旧嵌入方走有界回退。
import { saveSnapshot, type PersistContext, type SaveResult } from '@succinix/engine';
import type { FileSystemAPI } from '@webcontainer/api';
import type { SnapshotController } from '../persist/types.js';

const AUTO_SNAPSHOT_DEBOUNCE_MS = 5000;
const AUTO_SNAPSHOT_MAX_MS = 30000;
const activeControllers = new Set<SnapshotController>();

/** 在 host/container 销毁时停止所有页面级快照循环。 */
export function stopAutoSnapshots(): void {
  for (const controller of [...activeControllers]) controller.stop();
  activeControllers.clear();
}

// M5：持久化主循环按实例键（demo 传 instance.persist；缺省 = 模块级默认实例，现状全等）。
export function startAutoSnapshot(fs: FileSystemAPI, persist?: Pick<PersistContext, 'save' | 'onDirty'>): SnapshotController {
  const save = persist ? (force?: boolean) => persist.save(fs, force) : (force?: boolean) => saveSnapshot(fs, force);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = true;
  let inFlight: Promise<SaveResult> | undefined;
  let dirty = false;
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') void controller.flush();
  };
  const clearDirtyTimers = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (maxTimer) clearTimeout(maxTimer);
    debounceTimer = maxTimer = undefined;
  };
  const flush = async (force = true): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      await inFlight.catch(() => undefined);
      if (dirty) await flush(force);
      return;
    }
    clearDirtyTimers();
    dirty = false;
    try {
      inFlight = save(force);
      await inFlight;
    } catch (e) {
      console.warn('[persist] auto snapshot failed:', e);
    } finally {
      inFlight = undefined;
      if (dirty && !stopped) scheduleDirty();
    }
  };
  const scheduleDirty = () => {
    if (stopped) return;
    dirty = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void flush(), AUTO_SNAPSHOT_DEBOUNCE_MS);
    if (!maxTimer) maxTimer = setTimeout(() => void flush(), AUTO_SNAPSHOT_MAX_MS);
  };
  const scheduleFallback = () => {
    if (persist?.onDirty || stopped) return;
    fallbackTimer = setTimeout(async () => {
      await flush(false);
      scheduleFallback();
    }, AUTO_SNAPSHOT_MAX_MS);
  };
  const onPageLifecycle = () => { void flush(); };
  const unsubscribeDirty = persist?.onDirty?.(scheduleDirty);
  const controller: SnapshotController = {
    stop() {
      if (stopped) return;
      stopped = true;
      running = false;
      clearDirtyTimers();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
      unsubscribeDirty?.();
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageLifecycle);
        window.removeEventListener('beforeunload', onPageLifecycle);
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisibility);
      activeControllers.delete(controller);
    },
    flush: () => flush(),
    running: () => running && !stopped,
  };
  scheduleFallback();
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageLifecycle);
    window.addEventListener('beforeunload', onPageLifecycle);
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisibility);
  activeControllers.add(controller);
  return controller;
}
