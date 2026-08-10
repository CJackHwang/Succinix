// snapshot 命令域：持久化状态查看 / 立即保存 / 清除（O1 拆分）。
import type { Terminal } from '@xterm/xterm';
import type { FileSystemAPI } from '@webcontainer/api';
import { log } from '../log.js';
import { saveSnapshot, loadSnapshot, clearSnapshot, getSnapshotMeta, forcePersist, type PersistContext, type SnapshotMeta } from '../persist.js';
import type { CommandContext } from './types.js';
// M2：snapshot 命令缺省适配（单实例 = 模块级默认实例行为全等）。
async function loadSnapshotDefault(fs: FileSystemAPI): Promise<SnapshotMeta | null> {
  return loadSnapshot(fs);
}

// snapshot 命令：查看持久化状态 / 立即保存 / 清除（重置系统）。
function formatKB(n: number): string {
  return `${Math.round(n / 1024)} KB`;
}

async function snapshotStatus(term: Terminal, persist: PersistContext): Promise<void> {
  const meta = await persist.meta();
  if (!meta || meta.savedAt === 0) {
    term.writeln('Persistent storage: no snapshot yet (fresh workspace)');
    return;
  }
  term.writeln('Persistent storage: snapshot found');
  term.writeln(`  saved at:  ${new Date(meta.savedAt).toISOString()}`);
  term.writeln(`  files:     ${meta.fileCount}`);
  term.writeln(`  bytes:     ${meta.totalBytes} (${formatKB(meta.totalBytes)})`);
}

export async function snapshotCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  // M2：按实例持久化上下文存取（缺省 = 模块级默认实例，行为全等现状）。
  const persist = ctx.persist ?? { save: saveSnapshot, load: loadSnapshotDefault, clear: clearSnapshot, meta: getSnapshotMeta, force: forcePersist };
  const sub = args[0] ?? '';
  if (sub === '') {
    await snapshotStatus(term, persist);
    return;
  }
  if (sub === 'now') {
    const { meta, skipped } = await persist.save(ctx.wc.fs, true);
    if (skipped) {
      // 超过 50MB 上限：persist 跳过本次写，明确输出 skipped，不伪装成成功。
      term.writeln('Snapshot skipped (over 50MB limit)');
      void log('WARN', 'snapshot skipped: over 50MB limit');
      return;
    }
    term.writeln(`Snapshot saved: ${meta.fileCount} files, ${formatKB(meta.totalBytes)} (${new Date(meta.savedAt).toISOString()})`);
    void log('INFO', `snapshot saved: ${meta.fileCount} files, ${meta.totalBytes} bytes`);
    return;
  }
  if (sub === 'clear') {
    if (args[1] !== '--yes') {
      term.writeln('This will clear the persisted snapshot; the next boot starts fresh.');
      term.writeln('Confirm with: snapshot clear --yes');
      return;
    }
    await persist.clear();
    term.writeln('Snapshot cleared; next boot will initialize a fresh workspace.');
    void log('WARN', 'snapshot cleared: next boot initializes a fresh workspace');
    return;
  }
  term.writeln('usage: snapshot | snapshot now | snapshot clear --yes');
}
