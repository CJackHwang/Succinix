// 登录横幅模块（TASK15）：/etc/succinix.motd（可编辑，随快照持久）。
// boot 完成、进入终端前打印（main.ts 读取）；motd 命令查看 / 设置 / 恢复默认。
// 文件落在容器共享 FS（wc.fs 读写），与 config/services 同一模式：缺失时 boot 落默认内容。
import type { FileSystemAPI } from '@webcontainer/api';
import { getPersist } from './persist.js';
import { ensureParentDir } from './util.js';
import { SUCCINIX_VERSION } from './version.js';
import { DEFAULT_INSTANCE_ID, statePath } from './instance/paths.js';

export const MOTD_FILE = statePath(DEFAULT_INSTANCE_ID, 'etc/succinix.motd');

// M2：实例化状态文件路径（缺省实例 = /etc 现状；实例 = <stateRoot>/etc/<name>）。
export function motdFilePath(instanceId = DEFAULT_INSTANCE_ID): string {
  return statePath(instanceId, 'etc/succinix.motd');
}

// 默认内容（一条欢迎行；英文，无 emoji）。版本号构建期注入（P2-7，随 package.json 单一来源）。
export const DEFAULT_MOTD = `Welcome to Succinix ${SUCCINIX_VERSION} — browser-native Linux. Type 'help' for commands.`;

// 确保文件存在：缺失时写默认内容（boot 调用；用户可随后 motd <text> 编辑）。
export async function ensureMotd(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID): Promise<void> {
  const file = motdFilePath(instanceId);
  await ensureParentDir(fs, file);
  try {
    await fs.readFile(file, 'utf8');
  } catch {
    try {
      await fs.writeFile(file, DEFAULT_MOTD);
    } catch {
      /* 写入失败不影响 boot：命令读取时回落默认 */
    }
  }
}

// 读当前 motd 原文；文件缺失 / 不可读返回 null（调用方决定回落）。
export async function readMotd(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID): Promise<string | null> {
  try {
    return await fs.readFile(motdFilePath(instanceId), 'utf8');
  } catch {
    return null;
  }
}

// 设置 motd：写文件并强制落盘（随快照持久）。
// 等长编辑防护 + 门控回归与 config 一致（见 persist.forcePersist）。
export async function writeMotd(fs: FileSystemAPI, text: string, instanceId = DEFAULT_INSTANCE_ID): Promise<void> {
  const file = motdFilePath(instanceId);
  await ensureParentDir(fs, file);
  await fs.writeFile(file, text);
  await getPersist(instanceId).force(fs, 'motd');
}

// 恢复默认：写回 DEFAULT_MOTD 并强制落盘。
export async function resetMotd(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID): Promise<void> {
  await writeMotd(fs, DEFAULT_MOTD, instanceId);
}
