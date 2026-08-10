// 快照遍历（O4）：递归 readdir/readFile 收集 + 目录列表签名门控（TASK22 复审 R6）。
// collectWithGate 的去重缓存（lastListingSig/lastCollected）按上下文实例化（makeCollector）。
import type { FileSystemAPI } from '@webcontainer/api';
import { LOG_FILE } from '../log.js';

export interface Collected {
  files: Array<{ path: string; content: string }>;
  totalBytes: number;
  /** 签名用文件数（不含 /var/log/succinix.log —— TASK16 R1：日志每条命令都在增长，计入签名会让自动快照每次全量重写） */
  sigFileCount: number;
  /** 签名用总字节（不含 /var/log/succinix.log） */
  sigTotalBytes: number;
  skipped: number;
  /** 空目录路径（TASK19：空目录要随快照收录，否则刷新后丢失） */
  emptyDirs: string[];
}

export const EMPTY_COLLECT: Collected = { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 0, emptyDirs: [] };

// 日志文件：参与遍历（随快照持久），但不参与签名计算。
function isLogFile(path: string): boolean {
  return path === LOG_FILE;
}

// ─── 遍历：递归 readdir + readFile，排除规则命中即剪枝 ───
async function collectDir(
  fs: FileSystemAPI,
  dir: string,
  shouldSkip: (path: string) => boolean
): Promise<Collected> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return EMPTY_COLLECT; // 目录被并发删除（如 workspace rm 与自动快照竞争）：跳过该分支而非整批 reject
  }
  // TASK19：空目录（无任何条目）也要收录 —— 目录本身是状态（如空工作区），不收录则刷新后丢失。
  if (entries.length === 0) {
    return { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 0, emptyDirs: [dir] };
  }
  const parts = await Promise.all(
    entries.map(async (ent): Promise<Collected> => {
      const name = String(ent.name);
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      if (shouldSkip(path)) return EMPTY_COLLECT;
      if (ent.isDirectory()) return collectDir(fs, path, shouldSkip);
      if (!ent.isFile()) return EMPTY_COLLECT; // symlink/未知类型不收集，避免死循环
      let content: string;
      try {
        content = await fs.readFile(path, 'utf8');
      } catch {
        return { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 1, emptyDirs: [] }; // 不可读（权限/二进制）跳过并计数
      }
      // 二进制启发：utf8 解码出现 U+FFFD 替换字符即视为二进制，跳过并计数（README 注明）
      if (content.includes('\uFFFD')) return { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 1, emptyDirs: [] };
      const excludedFromSig = isLogFile(path);
      return {
        files: [{ path, content }],
        totalBytes: content.length,
        sigFileCount: excludedFromSig ? 0 : 1,
        sigTotalBytes: excludedFromSig ? 0 : content.length,
        skipped: 0,
        emptyDirs: [],
      };
    })
  );
  return parts.reduce(
    (acc, r) => ({
      files: acc.files.concat(r.files),
      totalBytes: acc.totalBytes + r.totalBytes,
      sigFileCount: acc.sigFileCount + r.sigFileCount,
      sigTotalBytes: acc.sigTotalBytes + r.sigTotalBytes,
      skipped: acc.skipped + r.skipped,
      emptyDirs: acc.emptyDirs.concat(r.emptyDirs),
    }),
    { files: [], totalBytes: 0, sigFileCount: 0, sigTotalBytes: 0, skipped: 0, emptyDirs: [] }
  );
}

// ─── 遍历前门控：目录列表签名（TASK22 复审 R6）───
// 自动快照每 ~2.5s 全量遍历容器 FS（readdir + 逐文件 readFile），空闲时是无谓开销。
// 这里加一道 readdir 层面的轻量签名：递归读目录树（路径 + name:type，排除规则命中即剪枝），
// 签名与上次全量遍历一致则直接复用上次结果，跳过遍历与读文件 —— 消除每 2.5s 的全量读。
// 覆盖范围说明：readdir 结果不含文件大小（WebContainer DirEnt 无 size/stat），签名只捕捉
// 目录结构变化（增/删/改名）；纯内容级修改（含等长）由 force 保存收录（config/motd/workspace
// 写盘、snapshot now、pagehide 兜底），与既有内容盲签名的 H1 语义一致，不引入新的丢数据窗口。
// 递归 readdir 树结构签名：每目录输出 "path=name:type,..."（name 排序），子目录递归展开。
async function computeListingSignature(
  fs: FileSystemAPI,
  dir: string,
  shouldSkip: (path: string) => boolean
): Promise<string> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return `${dir}=ERR;`; // 并发删目录：标记该目录变化，门控不命中 → 走全量遍历（其内 try/catch 跳过）
  }
  const list: Array<{ name: string; path: string; isDir: boolean }> = [];
  for (const ent of entries) {
    const name = String(ent.name);
    const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
    if (shouldSkip(path)) continue;
    list.push({ name, path, isDir: ent.isDirectory() });
  }
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const self = list.map((e) => `${e.name}:${e.isDir ? 'd' : 'f'}`).join(',');
  const childSigs = await Promise.all(list.filter((e) => e.isDir).map((e) => computeListingSignature(fs, e.path, shouldSkip)));
  return `${dir}=${self};${childSigs.join('')}`;
}

/**
 * 收集器工厂（O4）：scope 根 + 排除判定固定后，返回带门控缓存的 collectWithGate。
 * 缓存与恢复/清除联动（invalidate）：恢复写回整树后签名已过期，必须重新全量遍历。
 */
export function makeCollector(scopeRoot: string, shouldSkip: (path: string) => boolean) {
  let lastListingSig: string | null = null;
  let lastCollected: Collected | null = null;

  // 带门控的收集：force 或目录列表签名变化时才全量遍历；签名一致则复用上次结果。
  // 存储的是遍历前计算的签名：若遍历期间 FS 又变，存储签名已过期，下次比对不命中 → 自动再全量遍历，
  // 不会复用可能错过最新变更的旧结果。
  async function collectWithGate(fs: FileSystemAPI, force: boolean): Promise<Collected> {
    let sig: string | null;
    try {
      sig = await computeListingSignature(fs, scopeRoot, shouldSkip);
    } catch {
      sig = null; // 签名计算异常：按"不可用"处理，本次与下次都走全量遍历兜底
    }
    if (!force && lastListingSig !== null && lastCollected && sig !== null && sig === lastListingSig) {
      return lastCollected;
    }
    const collected = await collectDir(fs, scopeRoot, shouldSkip);
    lastListingSig = sig;
    lastCollected = collected;
    return collected;
  }

  return {
    collectWithGate,
    /** 恢复/清除后置空缓存：目录列表签名已过期，下一次保存必须重新全量遍历。 */
    invalidate(): void {
      lastListingSig = null;
      lastCollected = null;
    },
  };
}
