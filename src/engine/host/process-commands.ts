import { LifoProcessProjection, type LifoProcessLike } from './process-world.js';
import type { KillResult, ProcInfo } from '../host-procs.js';

interface LifoProcessContext {
  sandbox: {
    kernel: {
      processRegistry: {
        getAll(): unknown[];
        get(pid: number): unknown;
        kill(pid: number, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): boolean;
      };
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
