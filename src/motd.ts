// 登录横幅模块（TASK15）：/etc/webunix.motd（可编辑，随快照持久）。
// boot 完成、进入终端前打印（main.ts 读取）；motd 命令查看 / 设置 / 恢复默认。
// 文件落在容器共享 FS（wc.fs 读写），与 config/services 同一模式：缺失时 boot 落默认内容。
import type { FileSystemAPI } from '@webcontainer/api';
import { saveSnapshot } from './persist.js';

export const MOTD_FILE = '/etc/webunix.motd';

// 默认内容（一条欢迎行；英文，无 emoji）。
export const DEFAULT_MOTD = "Welcome to WebUnix 0.1.0 — browser-native Linux. Type 'help' for commands.";

async function ensureParentDir(fs: FileSystemAPI, file: string): Promise<void> {
  const idx = file.lastIndexOf('/');
  if (idx <= 0) return;
  try {
    await fs.mkdir(file.slice(0, idx), { recursive: true });
  } catch {
    /* 目录已存在等，写入继续 */
  }
}

// 确保文件存在：缺失时写默认内容（boot 调用；用户可随后 motd <text> 编辑）。
export async function ensureMotd(fs: FileSystemAPI): Promise<void> {
  await ensureParentDir(fs, MOTD_FILE);
  try {
    await fs.readFile(MOTD_FILE, 'utf8');
  } catch {
    try {
      await fs.writeFile(MOTD_FILE, DEFAULT_MOTD);
    } catch {
      /* 写入失败不影响 boot：命令读取时回落默认 */
    }
  }
}

// 读当前 motd 原文；文件缺失 / 不可读返回 null（调用方决定回落）。
export async function readMotd(fs: FileSystemAPI): Promise<string | null> {
  try {
    return await fs.readFile(MOTD_FILE, 'utf8');
  } catch {
    return null;
  }
}

// H1 等长编辑防护：与 config 一致，写盘成功后强制落盘（快照内容盲，等长替换不会自动收录）。
async function forcePersist(fs: FileSystemAPI): Promise<void> {
  try {
    await saveSnapshot(fs, true);
    await saveSnapshot(fs, true);
  } catch (e) {
    // 文件已写盘成功，快照失败只记日志，不打断 motd 命令（与自动快照的降级一致）。
    console.warn('[motd] force snapshot after write failed:', e);
  }
}

// 设置 motd：写文件并强制落盘（随快照持久）。
export async function writeMotd(fs: FileSystemAPI, text: string): Promise<void> {
  await ensureParentDir(fs, MOTD_FILE);
  await fs.writeFile(MOTD_FILE, text);
  await forcePersist(fs);
}

// 恢复默认：写回 DEFAULT_MOTD 并强制落盘。
export async function resetMotd(fs: FileSystemAPI): Promise<void> {
  await writeMotd(fs, DEFAULT_MOTD);
}
