// Projection of Lifo's per-Sandbox process tables into the host-wide process
// contract. Lifo allocates PIDs from 2 for every Sandbox, so exposing those
// numbers directly would collide across instances and with real child PIDs.
import type { ProcessRuntime, ProcInfo } from '../host-procs.js';

export interface LifoProcessLike {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startTime: number;
  status: 'running' | 'sleeping' | 'stopped' | 'zombie';
  isForeground: boolean;
  exitCode: number | null;
}
interface LifoProcessKey {
  kind: 'process';
  instanceId: string;
  localPid: number;
}

export interface LifoServiceLike {
  name: string;
  pid: number;
  command: string;
  startedAt: number;
  active: 'active' | 'activating';
}

interface LifoServiceKey {
  kind: 'service';
  instanceId: string;
  localPid: number;
  name: string;
}

export type ProjectedLifoProcessKey = LifoProcessKey | LifoServiceKey;

const PUBLIC_PID_START = 1_000_000_000;

function processKeyOf(instanceId: string, localPid: number): string {
  return `process\u0000${instanceId}\u0000${localPid}`;
}

function serviceKeyOf(instanceId: string, localPid: number, name: string): string {
  return `service\u0000${instanceId}\u0000${localPid}\u0000${name}`;
}

function baseCommand(command: string): string {
  const value = command.trim().split(/\s+/, 1)[0] ?? '';
  const slash = value.lastIndexOf('/');
  return slash >= 0 ? value.slice(slash + 1) : value;
}

/** Map the command adapter used by a Lifo process to the v0.7 runtime label. */
export function lifoProcessRuntime(command: string): ProcessRuntime {
  switch (baseCommand(command)) {
    case 'node':
    case 'npm':
    case 'npx':
      return 'node';
    case 'python':
    case 'python3':
    case 'pip':
    case 'pip3':
      return 'python';
    case 'ruby':
      return 'ruby';
    case 'wasi-run':
    case 'wasi-info':
      return 'wasi';
    default:
      return 'lifo';
  }
}

function commandLine(process: LifoProcessLike): string {
  return process.args.length > 0 ? process.args.join(' ') : process.command;
}

/**
 * Keeps the public PID mapping stable while a Lifo process remains in its
 * ProcessRegistry. The mapping is deliberately host-local and opaque: callers
 * must only feed the returned PID back to the same host instance.
 */
export class LifoProcessProjection {
  private nextPublicPid = PUBLIC_PID_START;
  private readonly byKey = new Map<string, number>();
  private readonly byPublicPid = new Map<number, ProjectedLifoProcessKey>();

  project(
    instanceId: string,
    processes: readonly LifoProcessLike[],
    terminalSessionId?: string,
  ): ProcInfo[] {
    const seen = new Set<string>();
    const result: ProcInfo[] = [];
    for (const process of processes) {
      // PID 1 is the Lifo shell itself. It is a transport-owned process, not a
      // user-manageable command, and must not be duplicated in host ps output.
      if (process.command === 'shell' || !Number.isInteger(process.pid) || process.pid <= 1) continue;
      const key = processKeyOf(instanceId, process.pid);
      seen.add(key);
      let publicPid = this.byKey.get(key);
      if (publicPid === undefined) {
        publicPid = this.allocatePublicPid();
        this.byKey.set(key, publicPid);
        this.byPublicPid.set(publicPid, { kind: 'process', instanceId, localPid: process.pid });
      }
      const running = process.status === 'running' || process.status === 'sleeping';
      const scope = instanceId === 'default' ? 'unknown' as const : 'container' as const;
      result.push({
        pid: publicPid,
        cmd: commandLine(process),
        status: running ? 'running' : 'exited',
        startTime: process.startTime,
        ...(process.exitCode !== null ? { exitCode: process.exitCode } : {}),
        scope,
        ...(instanceId !== 'default' ? { containerId: `.succinix-${instanceId}` } : {}),
        runtime: lifoProcessRuntime(process.command),
        instanceId,
        cwd: process.cwd,
        state: process.status,
        startedAt: process.startTime,
        interactive: terminalSessionId !== undefined && process.isForeground,
        ...(terminalSessionId !== undefined && process.isForeground ? { terminalSessionId } : {}),
      });
    }
    this.pruneKind(instanceId, 'process', seen);
    return result;
  }

  /** 在后续 `ps` 刷新前为服务分配稳定的公共 PID。 */
  projectServicePid(instanceId: string, name: string, localPid: number): number | undefined {
    if (!Number.isInteger(localPid) || localPid <= 0) return undefined;
    return this.publicServicePid(instanceId, name, localPid);
  }

  /**
   * 服务由 Lifo ServiceManager 管理，其 PID 分配器独立于 ProcessRegistry。
   * 将服务投影为一等公共进程，令 `systemctl`、`ps` 与 `kill` 共用命名空间。
   */
  projectServices(instanceId: string, services: readonly LifoServiceLike[]): ProcInfo[] {
    const seen = new Set<string>();
    const scope = instanceId === 'default' ? 'unknown' as const : 'container' as const;
    const result: ProcInfo[] = [];
    for (const service of services) {
      if (!Number.isInteger(service.pid) || service.pid <= 0) continue;
      const key = serviceKeyOf(instanceId, service.pid, service.name);
      seen.add(key);
      result.push({
        pid: this.publicServicePid(instanceId, service.name, service.pid),
        cmd: service.command,
        status: 'running',
        startTime: service.startedAt,
        scope,
        ...(instanceId !== 'default' ? { containerId: `.succinix-${instanceId}` } : {}),
        runtime: lifoProcessRuntime(service.command),
        instanceId,
        cwd: '/workspace',
        state: service.active === 'activating' ? 'sleeping' : 'running',
        startedAt: service.startedAt,
        interactive: false,
      });
    }
    this.pruneKind(instanceId, 'service', seen);
    return result;
  }

  resolve(publicPid: number): ProjectedLifoProcessKey | undefined {
    return this.byPublicPid.get(publicPid);
  }

  forgetInstance(instanceId: string): void {
    for (const [key, publicPid] of this.byKey) {
      if (this.byPublicPid.get(publicPid)?.instanceId !== instanceId) continue;
      this.byKey.delete(key);
      this.byPublicPid.delete(publicPid);
    }
  }

  private allocatePublicPid(): number {
    while (this.byPublicPid.has(this.nextPublicPid)) this.nextPublicPid++;
    return this.nextPublicPid++;
  }

  private publicServicePid(instanceId: string, name: string, localPid: number): number {
    const key = serviceKeyOf(instanceId, localPid, name);
    let publicPid = this.byKey.get(key);
    if (publicPid === undefined) {
      publicPid = this.allocatePublicPid();
      this.byKey.set(key, publicPid);
      this.byPublicPid.set(publicPid, { kind: 'service', instanceId, localPid, name });
    }
    return publicPid;
  }

  private pruneKind(instanceId: string, kind: ProjectedLifoProcessKey['kind'], seen: Set<string>): void {
    for (const [key, publicPid] of this.byKey) {
      const entry = this.byPublicPid.get(publicPid);
      if (entry?.instanceId !== instanceId || entry.kind !== kind || seen.has(key)) continue;
      this.byKey.delete(key);
      this.byPublicPid.delete(publicPid);
    }
  }
}
