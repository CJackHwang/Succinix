// 服务文件 I/O（O8 拆分自 services.ts）：/etc/succinix.services（服务定义）与
// /etc/succinix.autostart（自启清单）的路径、解析、读写与增删。
import type { FileSystemAPI } from '@webcontainer/api';
import { log } from '../log.js';
import { getPersist } from '../persist.js';
import { ensureParentDir } from '../util.js';
import { DEFAULT_INSTANCE_ID, statePath } from '../instance/paths.js';
import type { ServiceDef } from './types.js';

export const SERVICES_FILE = statePath(DEFAULT_INSTANCE_ID, 'etc/succinix.services');
export const AUTOSTART_FILE = statePath(DEFAULT_INSTANCE_ID, 'etc/succinix.autostart');

// M2：实例化状态文件路径（缺省实例 = /etc 现状；实例 = <stateRoot>/etc/<name>）。
// statePrefix（M5）：覆盖状态根前缀（缺省 = DM-12 内置前缀）。
export function servicesFilePath(instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): string {
  return statePath(instanceId, 'etc/succinix.services', statePrefix);
}
export function autostartFilePath(instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): string {
  return statePath(instanceId, 'etc/succinix.autostart', statePrefix);
}

// 内置预置：文件缺失时回落 / boot 初始化写入。${PORT} 占位符在启动时替换为 settings 的 preview-port。
export const DEFAULT_SERVICES_TEXT =
  '# Succinix service definitions (name|command|port)\n' +
  'tinbase|npx tinbase start --port ${PORT} --engine wasm|3001\n';

// 门控回归防护：自动快照的目录签名门控（persist collectDir）只看目录结构+总字节，
// 捕捉不到"内容变更但大小不变"的写入。定义/自启文件的写入靠此强制落盘一次
// （与 config/motd 的 forcePersist 一致：try/catch + console.warn 降级，不打断命令）。
// 实现收敛到 persist.forcePersist（P2-6），tag 标注模块名便于定位。

export async function ensureServicesFiles(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  const svcFile = servicesFilePath(instanceId, statePrefix);
  const autoFile = autostartFilePath(instanceId, statePrefix);
  await ensureParentDir(fs, svcFile);
  try {
    await fs.readFile(svcFile, 'utf8');
  } catch {
    try {
      await fs.writeFile(svcFile, DEFAULT_SERVICES_TEXT);
    } catch {
      /* 写入失败不影响 boot，读取仍回落内置预置 */
    }
  }
  try {
    await fs.readFile(autoFile, 'utf8');
  } catch {
    try {
      await fs.writeFile(autoFile, '');
    } catch {
      /* 同上 */
    }
  }
}

export async function readServicesRaw(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<string> {
  try {
    return await fs.readFile(servicesFilePath(instanceId, statePrefix), 'utf8');
  } catch {
    return DEFAULT_SERVICES_TEXT;
  }
}

// 解析服务定义：空行 / # 注释跳过；缺 name 或 command 的行跳过；port 非法或缺失 → null；重名最后定义生效。
export function parseServices(text: string): ServiceDef[] {
  const map = new Map<string, ServiceDef>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 2) continue;
    const name = parts[0];
    const command = parts[1];
    if (!name || !command) continue;
    const port = parsePort(parts[2] ?? '');
    map.set(name, { name, command, port });
  }
  return [...map.values()];
}

function parsePort(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export async function readServices(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<ServiceDef[]> {
  return parseServices(await readServicesRaw(fs, instanceId, statePrefix));
}

export async function writeServicesText(fs: FileSystemAPI, text: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  await ensureParentDir(fs, servicesFilePath(instanceId, statePrefix));
  await fs.writeFile(servicesFilePath(instanceId, statePrefix), text);
}

// 注册一条服务定义（追加到文件，供自检用临时服务）。
export async function addServiceDef(fs: FileSystemAPI, name: string, command: string, port: number | null, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  const text = (await readServicesRaw(fs, instanceId, statePrefix)).trimEnd();
  await writeServicesText(fs, `${text}${text ? '\n' : ''}${name}|${command}|${port ?? ''}\n`, instanceId, statePrefix);
  await getPersist(instanceId).force(fs, 'services'); // 内容变更门控回归：写盘成功后强制落盘
}

// 按名字过滤移除定义（保留注释与其他行）；返回是否真有移除。
export async function removeServiceDef(fs: FileSystemAPI, name: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<boolean> {
  const text = await readServicesRaw(fs, instanceId, statePrefix);
  const kept = text
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      if (!t || t.startsWith('#')) return true;
      return t.split('|')[0]?.trim() !== name;
    })
    .join('\n');
  if (kept === text) return false;
  await writeServicesText(fs, kept, instanceId, statePrefix);
  await getPersist(instanceId).force(fs, 'services'); // 内容变更门控回归：写盘成功后强制落盘
  return true;
}

// ─── 自启清单（每行一个服务名，去重）───

export async function readAutostart(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(autostartFilePath(instanceId, statePrefix), 'utf8');
  } catch {
    return []; // 文件不存在 → 空自启清单
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!seen.has(line)) {
      seen.add(line);
      names.push(line);
    }
  }
  return names;
}

async function writeAutostart(fs: FileSystemAPI, names: string[], instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  await ensureParentDir(fs, autostartFilePath(instanceId, statePrefix));
  await fs.writeFile(autostartFilePath(instanceId, statePrefix), names.map((n) => `${n}\n`).join(''));
}

// 启用自启：写入清单并去重；返回是否新增。
export async function enableAutostart(fs: FileSystemAPI, name: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<boolean> {
  const names = await readAutostart(fs, instanceId, statePrefix);
  if (names.includes(name)) {
    void log('INFO', `service enable: ${name} already enabled`);
    return false;
  }
  names.push(name);
  await writeAutostart(fs, names, instanceId, statePrefix);
  await getPersist(instanceId).force(fs, 'services'); // 内容变更门控回归：写盘成功后强制落盘
  void log('INFO', `service enable: ${name}`);
  return true;
}

// 取消自启：从清单移除；返回是否原本存在。
export async function disableAutostart(fs: FileSystemAPI, name: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<boolean> {
  const names = await readAutostart(fs, instanceId, statePrefix);
  if (!names.includes(name)) {
    void log('INFO', `service disable: ${name} not enabled`);
    return false;
  }
  await writeAutostart(fs, names.filter((n) => n !== name), instanceId, statePrefix);
  await getPersist(instanceId).force(fs, 'services'); // 内容变更门控回归：写盘成功后强制落盘
  void log('INFO', `service disable: ${name}`);
  return true;
}
