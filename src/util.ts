// 跨模块共享辅助（P2-6）：sleep / ensureParentDir。
// 之前 7 处 sleep、4 处 ensureParentDir 各自重复定义（实现完全一致），收敛到这里。
// 注意 engine/* 自包含原则（引擎不依赖系统层）：engine 内的 sleep 放 src/engine/sleep.ts，
// 不 import 本文件，避免破坏「引擎零依赖系统层」边界。
import type { FileSystemAPI } from '@webcontainer/api';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 确保文件所在目录存在（WebContainer 全新 FS 没有 /etc，首次写前建目录）。
// 调用方在写入前调用；目录已存在等失败情况静默（写入继续，实际写由调用方兜底）。
export async function ensureParentDir(fs: FileSystemAPI, file: string): Promise<void> {
  const idx = file.lastIndexOf('/');
  if (idx <= 0) return;
  try {
    await fs.mkdir(file.slice(0, idx), { recursive: true });
  } catch {
    /* 目录已存在等，写入继续 */
  }
}
