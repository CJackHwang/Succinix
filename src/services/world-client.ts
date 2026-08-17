// 执行世界服务客户端：浏览器/SDK 只传输命令与读取结果，unit、生命周期和 enablement
// 始终由同一实例的 Lifo ServiceManager 持有，避免浏览器侧镜像状态分叉。
import type { ExecResult } from '../engine/index.js';
import { DEFAULT_INSTANCE_ID } from '../instance/paths.js';
import { instancePorts } from '../instance/ports.js';
import type { ServiceActionResult, ServiceContext, ServiceDef, ServiceState } from './types.js';

interface ServiceInspection extends ServiceDef {
  description: string;
  enabled: boolean;
  state: 'running' | 'stopped';
  pid?: number;
}

function quote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function failure(result: ExecResult): string {
  return String(result.stderr || result.error || result.message || result.stdout || 'service command failed').trim();
}

async function invoke(ctx: ServiceContext, args: string[]): Promise<ExecResult> {
  return ctx.client.terminal(`succinix service ${args.map(quote).join(' ')}`.trim(), undefined, 120000);
}

function parseInspection(result: ExecResult): ServiceInspection[] | ServiceInspection | null {
  if (!result.ok) throw new Error(failure(result));
  try {
    return JSON.parse(String(result.stdout ?? '')) as ServiceInspection[] | ServiceInspection | null;
  } catch {
    throw new Error('invalid execution-world service inspection response');
  }
}

async function inspect(ctx: ServiceContext, name?: string): Promise<ServiceInspection[] | ServiceInspection | null> {
  return parseInspection(await invoke(ctx, name ? ['inspect', name] : ['inspect']));
}

function toState(ctx: ServiceContext, item: ServiceInspection): ServiceState {
  const effectivePort = item.port;
  return {
    def: { name: item.name, command: item.command, port: item.port },
    state: item.state,
    ...(item.pid === undefined ? {} : { pid: item.pid }),
    effectivePort,
    ...(item.state === 'running' && effectivePort !== null && ctx.ports.get(effectivePort)
      ? { url: ctx.ports.get(effectivePort) }
      : {}),
  };
}

function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function readExecutionServices(ctx: ServiceContext): Promise<ServiceDef[]> {
  const units = await inspect(ctx);
  if (!Array.isArray(units)) throw new Error('invalid execution-world service list response');
  return units.map(({ name, command, port }) => ({ name, command, port }));
}

export async function listExecutionServiceStates(ctx: ServiceContext): Promise<ServiceState[]> {
  const units = await inspect(ctx);
  if (!Array.isArray(units)) throw new Error('invalid execution-world service list response');
  return units.map((unit) => toState(ctx, unit));
}

export async function executionServiceState(ctx: ServiceContext, name: string): Promise<ServiceState> {
  const unit = await inspect(ctx, name);
  if (!unit || Array.isArray(unit)) throw new Error(`unknown service: ${name}`);
  return toState(ctx, unit);
}

async function action(ctx: ServiceContext, operation: 'start' | 'stop' | 'restart', name: string): Promise<ServiceActionResult> {
  const result = await invoke(ctx, [operation, name]);
  const message = String(result.stdout || result.stderr || result.error || result.message || '').trim();
  if (!result.ok) return { ok: false, message: message || `failed to ${operation} '${name}'` };
  try {
    const state = await executionServiceState(ctx, name);
    return { ok: true, message: message || `service '${name}' ${operation}ed`, ...(state.pid === undefined ? {} : { pid: state.pid }) };
  } catch {
    return { ok: true, message: message || `service '${name}' ${operation}ed` };
  }
}

export function startExecutionService(ctx: ServiceContext, name: string): Promise<ServiceActionResult> {
  return actionWithPortOwnership(ctx, 'start', name);
}

export function stopExecutionService(ctx: ServiceContext, name: string): Promise<ServiceActionResult> {
  return actionWithPortOwnership(ctx, 'stop', name);
}

export function restartExecutionService(ctx: ServiceContext, name: string): Promise<ServiceActionResult> {
  return actionWithPortOwnership(ctx, 'restart', name);
}

/**
 * 服务在执行世界运行，但 WebContainer 的预览事件不携带实例 id。启动/重启前登记
 * 声明端口，使独立 SDK 嵌入获得与应用宿主相同的实例级端口视图；宿主控制桥存在时
 * 会镜像这项登记。
 */
async function actionWithPortOwnership(
  ctx: ServiceContext,
  operation: 'start' | 'stop' | 'restart',
  name: string,
): Promise<ServiceActionResult> {
  let port: number | null = null;
  try {
    port = (await executionServiceState(ctx, name)).effectivePort;
  } catch {
    // Let the execution-world command produce the authoritative unknown-unit error.
  }
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  if (port !== null && operation !== 'stop') instancePorts.expect(instanceId, port);

  const result = await action(ctx, operation, name);
  if (port === null) return result;
  if (operation === 'stop' && result.ok) {
    instancePorts.release(instanceId, port);
    ctx.ports.delete(port);
  } else if (operation === 'start' && !result.ok) {
    instancePorts.release(instanceId, port);
  }
  return result;
}

export async function enableExecutionService(ctx: ServiceContext, name: string): Promise<boolean> {
  const before = await inspect(ctx, name);
  if (!before || Array.isArray(before)) throw new Error(`unknown service: ${name}`);
  const result = await invoke(ctx, ['enable', name]);
  if (!result.ok) throw new Error(failure(result));
  const after = await inspect(ctx, name);
  return !before.enabled && !!after && !Array.isArray(after) && after.enabled;
}

export async function disableExecutionService(ctx: ServiceContext, name: string): Promise<boolean> {
  const before = await inspect(ctx, name);
  if (!before || Array.isArray(before)) throw new Error(`unknown service: ${name}`);
  const result = await invoke(ctx, ['disable', name]);
  if (!result.ok) throw new Error(failure(result));
  const after = await inspect(ctx, name);
  return before.enabled && !!after && !Array.isArray(after) && !after.enabled;
}

export async function addExecutionService(ctx: ServiceContext, name: string, command: string, port: number | null): Promise<void> {
  const result = await invoke(ctx, ['add', base64url(JSON.stringify({ name, command, port }))]);
  if (!result.ok) throw new Error(failure(result));
}

export async function removeExecutionService(ctx: ServiceContext, name: string): Promise<boolean> {
  const current = await inspect(ctx, name);
  if (!current || Array.isArray(current)) return false;
  const result = await invoke(ctx, ['remove', name]);
  if (!result.ok) throw new Error(failure(result));
  return true;
}

export async function executionAutostart(ctx: ServiceContext): Promise<string[]> {
  const units = await inspect(ctx);
  if (!Array.isArray(units)) throw new Error('invalid execution-world service list response');
  return units.filter((unit) => unit.enabled).map((unit) => unit.name);
}

export async function ensureExecutionServices(ctx: ServiceContext): Promise<void> {
  const result = await invoke(ctx, ['daemon-reload']);
  if (!result.ok) throw new Error(failure(result));
}
