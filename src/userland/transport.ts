import {
  USERLAND_REGISTRY_FORMAT_VERSION,
  createUserlandRegistry,
  type UserlandRegistrySnapshot,
} from './registry.js';

/** 浏览器控制面与 WebContainer host 共享的只含声明数据的邮箱。 */
export const USERLAND_REGISTRY_PATH = '/.succinix-userland/registry.json';

export interface UserlandRegistryFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * 只接受注册表公开快照。验证时重新走注册 API，阻断函数、未知 runtime
 * 和重复名称；内建能力没有 source，保留用于 capabilities 展示而不执行。
 */
export function parseUserlandRegistrySnapshot(value: unknown): UserlandRegistrySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<UserlandRegistrySnapshot>;
  if (candidate.formatVersion !== USERLAND_REGISTRY_FORMAT_VERSION ||
    !Array.isArray(candidate.commands) || !Array.isArray(candidate.packages) || !Array.isArray(candidate.serviceTemplates)) {
    return null;
  }
  try {
    const validator = createUserlandRegistry();
    for (const command of candidate.commands) {
      if (!command || typeof command !== 'object') return null;
      if ('source' in command && command.source !== undefined) validator.registerCommand(command);
    }
    for (const source of candidate.packages) validator.registerPackage(source);
    for (const template of candidate.serviceTemplates) validator.registerServiceTemplate(template);
    return clone({
      formatVersion: USERLAND_REGISTRY_FORMAT_VERSION,
      commands: candidate.commands,
      packages: candidate.packages,
      serviceTemplates: candidate.serviceTemplates,
    } as UserlandRegistrySnapshot);
  } catch {
    return null;
  }
}

/** 通过临时文件和 rename 发布新快照，host 永远读取完整 JSON。 */
export async function writeUserlandRegistrySnapshot(
  fs: UserlandRegistryFs,
  snapshot: UserlandRegistrySnapshot,
): Promise<void> {
  const parsed = parseUserlandRegistrySnapshot(snapshot);
  if (!parsed) throw new TypeError('invalid userland registry snapshot');
  const parent = USERLAND_REGISTRY_PATH.slice(0, USERLAND_REGISTRY_PATH.lastIndexOf('/'));
  const temporary = `${USERLAND_REGISTRY_PATH}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(parsed));
  await fs.rename(temporary, USERLAND_REGISTRY_PATH);
}
