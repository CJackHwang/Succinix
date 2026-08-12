// 自动快照（每 ~2.5s 保存一次；persist 内部去重 + 空闲退避）（O2 拆分）。
import { saveSnapshot, type PersistContext } from '@succinix/engine';
import type { FileSystemAPI } from '@webcontainer/api';

// ─── 自动快照（每 ~2.5s 保存一次；persist 内部去重 + 空闲退避）───
const AUTO_SNAPSHOT_BASE_MS = 2500;
const AUTO_SNAPSHOT_MAX_MS = 15000;

// M5：持久化主循环按实例键（demo 传 instance.persist；缺省 = 模块级默认实例，现状全等）。
export function startAutoSnapshot(fs: FileSystemAPI, persist?: Pick<PersistContext, 'save'>): void {
  const save = persist ? (force?: boolean) => persist.save(fs, force) : (force?: boolean) => saveSnapshot(fs, force);
  let interval = AUTO_SNAPSHOT_BASE_MS;
  let idleTicks = 0;
  const tick = async () => {
    try {
      const r = await save();
      if (r.reason === 'changed') {
        idleTicks = 0;
        interval = AUTO_SNAPSHOT_BASE_MS;
      } else {
        idleTicks++;
        if (idleTicks >= 2) interval = Math.min(interval * 2, AUTO_SNAPSHOT_MAX_MS);
      }
    } catch (e) {
      console.warn('[persist] auto snapshot failed:', e);
    }
    setTimeout(tick, interval);
  };
  setTimeout(tick, AUTO_SNAPSHOT_BASE_MS);
  const flush = () => {
    void save(true).catch(() => {});
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}
