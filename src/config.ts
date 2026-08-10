// 系统配置模块（TASK10）：/etc/succinix.env（环境变量）与 /etc/succinix.settings（系统设置）。
// 两者都是 KEY=value 纯文本，落在容器共享 FS（浏览器 wc.fs 读写，host 经 node:fs 读），
// 随快照持久化（persist.ts 遍历 / 时天然收录，重启保留）。
// 解析要健壮：空行 / # 注释跳过；值可含 =（按第一个 = 切分）；读取失败一律按空处理。
import type { FileSystemAPI } from '@webcontainer/api';
import { getPersist } from './persist.js';
import { ensureParentDir } from './util.js';
import { DEFAULT_INSTANCE_ID, statePath } from './instance/paths.js';

export const ENV_FILE = statePath(DEFAULT_INSTANCE_ID, 'etc/succinix.env');
export const SETTINGS_FILE = statePath(DEFAULT_INSTANCE_ID, 'etc/succinix.settings');

// M2：实例化状态文件路径（缺省实例 = /etc 现状；实例 = <stateRoot>/etc/<name>）。
// statePrefix（M5）：覆盖状态根前缀（缺省 = DM-12 内置前缀）。
export function envFilePath(instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): string {
  return statePath(instanceId, 'etc/succinix.env', statePrefix);
}
export function settingsFilePath(instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): string {
  return statePath(instanceId, 'etc/succinix.settings', statePrefix);
}

// 工作区名白名单（TASK7 原有规则，移入共享模块供 settings 校验 default-workspace 复用）：
// 字母/数字开头，后续可含 . _ -（拒绝空、路径分隔、隐藏名）。
export function isValidWorkspaceName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

// ─── 解析 / 序列化（KEY=value 纯文本）───

// 解析：空行、# 注释跳过；键值按第一个 = 切分（值可含 =）；空键行丢弃。
export function parseKeyValue(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (!key) continue;
    map.set(key, value);
  }
  return map;
}

// 序列化：按键名排序、行尾统一 \n（内容稳定，便于快照去重与 diff）。
export function serializeKeyValue(map: Map<string, string>): string {
  if (map.size === 0) return '';
  return (
    [...map.keys()]
      .sort()
      .map((k) => `${k}=${map.get(k) ?? ''}`)
      .join('\n') + '\n'
  );
}

// ─── env 文件 ───

export async function readEnvFile(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<Map<string, string>> {
  try {
    return parseKeyValue(await fs.readFile(envFilePath(instanceId, statePrefix), 'utf8'));
  } catch {
    return new Map(); // 文件不存在 / 不可读 → 空（首次使用）
  }
}

export async function writeEnvFile(fs: FileSystemAPI, map: Map<string, string>, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  await ensureParentDir(fs, envFilePath(instanceId, statePrefix));
  await fs.writeFile(envFilePath(instanceId, statePrefix), serializeKeyValue(map));
}

export async function getEnvVar(fs: FileSystemAPI, key: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<string | undefined> {
  return (await readEnvFile(fs, instanceId, statePrefix)).get(key);
}

export async function setEnvVar(fs: FileSystemAPI, key: string, value: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  const map = await readEnvFile(fs, instanceId, statePrefix);
  map.set(key, value);
  await writeEnvFile(fs, map, instanceId, statePrefix);
  await getPersist(instanceId).force(fs, 'config'); // 写盘成功后强制落盘（H1：等长修改也要持久）
}

// 删除变量；返回是否原本存在（供输出 removed / not set）。
export async function unsetEnvVar(fs: FileSystemAPI, key: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<boolean> {
  const map = await readEnvFile(fs, instanceId, statePrefix);
  const had = map.delete(key);
  if (had) {
    await writeEnvFile(fs, map, instanceId, statePrefix);
    await getPersist(instanceId).force(fs, 'config'); // 门控回归：删除是内容变更（等长/结构不变），自动快照目录签名捕捉不到，写盘后强制落盘
  }
  return had;
}

// ─── settings 文件 ───

// 首批设置项（有序，列表展示按此顺序）。theme-accent 明确不做（暗橙是品牌色，不开放改色）。
export const SETTING_KEYS = ['preview-port', 'default-workspace', 'font-size'] as const;

export const DEFAULT_SETTINGS: Record<string, string> = {
  'preview-port': '3001', // tinbase 端口（db start 读取）
  'default-workspace': 'main', // boot 初始工作区名（全新系统初始化用）
  'font-size': '14', // xterm 字号（运行时生效，boot 亦应用）
};

export async function readSettingsFile(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<Map<string, string>> {
  try {
    return parseKeyValue(await fs.readFile(settingsFilePath(instanceId, statePrefix), 'utf8'));
  } catch {
    return new Map();
  }
}

export async function writeSettingsFile(fs: FileSystemAPI, map: Map<string, string>, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  await ensureParentDir(fs, settingsFilePath(instanceId, statePrefix));
  await fs.writeFile(settingsFilePath(instanceId, statePrefix), serializeKeyValue(map));
}

// 读取生效值：未设置回退默认。
export async function getSetting(fs: FileSystemAPI, key: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<string> {
  const map = await readSettingsFile(fs, instanceId, statePrefix);
  return map.get(key) ?? DEFAULT_SETTINGS[key] ?? '';
}

export async function setSetting(fs: FileSystemAPI, key: string, value: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<void> {
  const map = await readSettingsFile(fs, instanceId, statePrefix);
  map.set(key, value);
  await writeSettingsFile(fs, map, instanceId, statePrefix);
  await getPersist(instanceId).force(fs, 'config'); // 写盘成功后强制落盘（H1）
}

// 恢复默认 = 删除存储值；返回是否原本存在自定义值。
export async function resetSetting(fs: FileSystemAPI, key: string, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<boolean> {
  const map = await readSettingsFile(fs, instanceId, statePrefix);
  const had = map.delete(key);
  if (had) {
    await writeSettingsFile(fs, map, instanceId, statePrefix);
    await getPersist(instanceId).force(fs, 'config'); // 写盘成功后强制落盘（H1）
  }
  return had;
}

export interface SettingEntry {
  key: string;
  value: string;
  isDefault: boolean;
}

// 列出全部设置：按 SETTING_KEYS 顺序，附是否默认值标记。
export async function listSettings(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<SettingEntry[]> {
  const map = await readSettingsFile(fs, instanceId, statePrefix);
  return SETTING_KEYS.map((key) => ({
    key,
    value: map.get(key) ?? DEFAULT_SETTINGS[key] ?? '',
    isDefault: !map.has(key),
  }));
}

// 设置值校验：返回错误信息或 null。preview-port / font-size 需整数区间；
// default-workspace 复用工作区名校验。
export function validateSetting(key: string, value: string): string | null {
  switch (key) {
    case 'preview-port': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return `preview-port must be an integer between 1 and 65535 (got '${value}')`;
      }
      return null;
    }
    case 'default-workspace': {
      if (!isValidWorkspaceName(value)) {
        return `default-workspace must match letters/digits/dot/dash/underscore (got '${value}')`;
      }
      return null;
    }
    case 'font-size': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 8 || n > 72) {
        return `font-size must be an integer between 8 and 72 (got '${value}')`;
      }
      return null;
    }
    default:
      return `unknown setting: ${key}`;
  }
}
