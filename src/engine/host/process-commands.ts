import { LifoProcessProjection, type LifoProcessLike, type LifoServiceLike } from './process-world.js';
import type { KillResult, ProcInfo } from '../host-procs.js';
import { serviceCommandFromUnitText } from './service-world.js';

interface LifoProcessContext {
  sandbox: {
    kernel: {
      processRegistry: {
        getAll(): unknown[];
        get(pid: number): unknown;
        kill(pid: number, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): boolean;
      };
      vfs: {
        exists(path: string): boolean;
        readFileString(path: string): string;
      };
      serviceManager: {
        listUnits(): Array<{
          name: string;
          pid: number | null;
          startedAt: number | null;
          active: 'active' | 'inactive' | 'failed' | 'activating';
        }>;
        status(name: string): {
          pid: number | null;
          active: 'active' | 'inactive' | 'failed' | 'activating';
        };
        stop(name: string): Promise<{ ok: boolean; message: string }>;
      } | null;
    };
  };
  terminalSessionId?: string;
}

/** Lifo 内核的进程视图与信号投递，保持 run.ts 只负责路由与上下文生命周期。 */
export async function listProjectedLifoProcesses(
  contexts: ReadonlyMap<string, Promise<LifoProcessContext>>,
  projection: LifoProcessProjection,
  instanceId: string,
  includeAll = instanceId === 'default',
): Promise<ProcInfo[]> {
  const entries: ProcInfo[] = [];
  const selected = [...contexts.entries()].filter(([id]) => includeAll || id === instanceId);
  for (const [id, pending] of selected) {
    try {
      const context = await pending;
      const processes = context.sandbox.kernel.processRegistry.getAll() as LifoProcessLike[];
      entries.push(...projection.project(id, processes, context.terminalSessionId));
      entries.push(...projection.projectServices(id, serviceProcesses(context)));
    } catch {
      // 上下文可在 host respawn 清理时被替换。
    }
  }
  return entries;
}

export async function killProjectedLifoProcess(
  contexts: ReadonlyMap<string, Promise<LifoProcessContext>>,
  projection: LifoProcessProjection,
  publicPid: number,
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
): Promise<KillResult | null> {
  const key = projection.resolve(publicPid);
  if (!key) return null;
  const pending = contexts.get(key.instanceId);
  if (!pending) return { killed: false, message: `process ${publicPid} is no longer available` };
  try {
    const context = await pending;
    if (key.kind === 'service') {
      const serviceManager = context.sandbox.kernel.serviceManager;
      const status = serviceManager?.status(key.name);
      if (!serviceManager || status?.pid !== key.localPid || (status.active !== 'active' && status.active !== 'activating')) {
        return { killed: false, message: `process ${publicPid} is no longer available` };
      }
      const result = await serviceManager.stop(key.name);
      return result.ok
        ? { killed: true, message: `${signal} sent to service ${publicPid}` }
        : { killed: false, message: result.message || `failed to stop service ${publicPid}` };
    }
    const process = context.sandbox.kernel.processRegistry.get(key.localPid) as LifoProcessLike | undefined;
    if (!process) return { killed: false, message: `process ${publicPid} is no longer available` };
    if (process.status === 'zombie' || process.status === 'stopped') {
      return { killed: false, message: `process ${publicPid} already exited (exit=${process.exitCode ?? '?'})` };
    }
    const killed = context.sandbox.kernel.processRegistry.kill(key.localPid, signal);
    return killed
      ? { killed: true, message: `${signal} sent to Lifo process ${publicPid}` }
      : { killed: false, message: `failed to signal Lifo process ${publicPid}` };
  } catch {
    return { killed: false, message: `process ${publicPid} is no longer available` };
  }
}

function serviceProcesses(context: LifoProcessContext): LifoServiceLike[] {
  const { serviceManager, vfs } = context.sandbox.kernel;
  if (!serviceManager) return [];
  return serviceManager.listUnits().flatMap((service) => {
    if (service.pid === null || (service.active !== 'active' && service.active !== 'activating')) return [];
    const path = `/etc/systemd/system/${service.name}.service`;
    const command = vfs.exists(path) ? serviceCommandFromUnitText(vfs.readFileString(path)) : null;
    return [{
      name: service.name,
      pid: service.pid,
      command: command ?? `systemctl ${service.name}`,
      startedAt: service.startedAt ?? Date.now(),
      active: service.active,
    }];
  });
}
