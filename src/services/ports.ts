// 服务端口视图与命令渲染（O8 拆分自 services.ts）。
import type { FileSystemAPI } from '@webcontainer/api';
import { getSetting } from '../config.js';
import { DEFAULT_INSTANCE_ID } from '../instance/paths.js';
import { instancePorts } from '../instance/ports.js';
import type { ServiceContext, ServiceDef } from './types.js';

const DEFAULT_PORT = 3001;

// 有效端口 = settings 的 preview-port（整数 1-65535），否则回落默认 3001。
export async function resolvePreviewPort(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<number> {
  const raw = await getSetting(fs, 'preview-port', instanceId, statePrefix);
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

// 渲染命令模板：${PORT} 占位符替换为当前 preview-port（启动时读最新设置）。
export async function renderCommand(fs: FileSystemAPI, def: ServiceDef, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<string> {
  const port = await resolvePreviewPort(fs, instanceId, statePrefix);
  return def.command.replace(/\$\{PORT\}/g, String(port));
}

// M4：实例端口视图（服务就绪判定 / URL 展示按实例收窄；默认实例 = 页面级全部）。
export function portsView(ctx: ServiceContext): Map<number, string> {
  return instancePorts.portsFor(ctx.instanceId ?? DEFAULT_INSTANCE_ID, ctx.ports);
}
