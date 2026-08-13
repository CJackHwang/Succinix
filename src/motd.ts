// 登录横幅模块（TASK15）：/etc/succinix.motd（可编辑，随快照持久）。
// boot 完成、进入终端前打印（main.ts 读取）；motd 命令查看 / 设置 / 恢复默认。
// 文件落在容器共享 FS（wc.fs 读写），与 config/services 同一模式：缺失时 boot 落默认内容。
import type { FileSystemAPI } from '@webcontainer/api';
import { getPersist } from './persist/index.js';
import { ensureParentDir } from './util.js';
import { SUCCINIX_VERSION } from './version.js';
import { DEFAULT_INSTANCE_ID, statePath } from './instance/paths.js';

export const MOTD_FILE = statePath(DEFAULT_INSTANCE_ID, 'etc/succinix.motd');

// M2：实例化状态文件路径（缺省实例 = /etc 现状；实例 = <stateRoot>/etc/<name>）。
// statePrefix（M5）：覆盖状态根前缀（缺省 = DM-12 内置前缀）。
export function motdFilePath(instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): string {
  return statePath(instanceId, 'etc/succinix.motd', statePrefix);
}

// 默认内容（一条欢迎行；英文，无 emoji）。版本号构建期注入（P2-7，随 package.json 单一来源）。
export const DEFAULT_MOTD = `Welcome to Succinix ${SUCCINIX_VERSION} — browser-native Linux. Type 'help' for commands.`;

// 历史默认横幅（含品牌迁移前的 WebUnix 与旧版本号）：命中时视为默认内容，
// 在读取/恢复时替换为当前版本，避免旧快照里的欢迎横幅把版本号“冻结”在升级前。
const DEFAULT_MOTD_PATTERN =
  /^Welcome to (?:Succinix|WebUnix) [^ \n]+ — browser-native Linux\. Type 'help' for commands\.$/;

function isDefaultMotd(text: string): boolean {
  return DEFAULT_MOTD_PATTERN.test(text);
}

// 确保文件存在：缺失时写默认内容（boot 调用；用户可随后 motd <text> 编辑）。
export async function ensureMotd(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  const file = motdFilePath(instanceId, statePrefix);
  await ensureParentDir(fs, file);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    /* 文件缺失：下面落默认内容 */
  }
  if (existing === null) {
    try {
      await fs.writeFile(file, DEFAULT_MOTD);
    } catch {
      /* 写入失败不影响 boot：命令读取时回落默认 */
    }
    return;
  }
  if (existing !== DEFAULT_MOTD && isDefaultMotd(existing)) {
    try {
      // 旧快照恢复的默认横幅：重写为当前版本并立即落盘，无需清空用户数据。
      await writeMotd(fs, DEFAULT_MOTD, instanceId, statePrefix);
    } catch {
      /* 刷新失败不影响 boot：readMotd 仍会按默认横幅回落当前版本 */
    }
  }
}

// 读当前 motd 原文；文件缺失 / 不可读返回 null（调用方决定回落）。
export async function readMotd(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<string | null> {
  try {
    const text = await fs.readFile(motdFilePath(instanceId, statePrefix), 'utf8');
    // 即使快照尚未被 ensureMotd 重写，读取端也把旧默认横幅渲染为当前版本。
    return isDefaultMotd(text) ? DEFAULT_MOTD : text;
  } catch {
    return null;
  }
}

// 设置 motd：写文件并强制落盘（随快照持久）。
// 等长编辑防护 + 门控回归与 config 一致（见 persist.forcePersist）。
export async function writeMotd(fs: FileSystemAPI, text: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  const file = motdFilePath(instanceId, statePrefix);
  await ensureParentDir(fs, file);
  await fs.writeFile(file, text);
  await getPersist(instanceId).force(fs, 'motd');
}

// 恢复默认：写回 DEFAULT_MOTD 并强制落盘。
export async function resetMotd(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  await writeMotd(fs, DEFAULT_MOTD, instanceId, statePrefix);
}
