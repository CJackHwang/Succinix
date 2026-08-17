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
interface ProcessKey {
  instanceId: string;
  localPid: number;
}

const PUBLIC_PID_START = 1_000_000_000;

function keyOf(instanceId: string, localPid: number): string {
  return `${instanceId}\u0000${localPid}`;
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
  private readonly byPublicPid = new Map<number, ProcessKey>();

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
      const key = keyOf(instanceId, process.pid);
      seen.add(key);
      let publicPid = this.byKey.get(key);
      if (publicPid === undefined) {
        publicPid = this.allocatePublicPid();
        this.byKey.set(key, publicPid);
        this.byPublicPid.set(publicPid, { instanceId, localPid: process.pid });
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
        interactive: terminalSessionId !== undefined,
        ...(terminalSessionId ? { terminalSessionId } : {}),
      });
    }
    this.pruneInstance(instanceId, seen);
    return result;
  }

  resolve(publicPid: number): ProcessKey | undefined {
    return this.byPublicPid.get(publicPid);
  }

  forgetInstance(instanceId: string): void {
    for (const [key, publicPid] of this.byKey) {
      if (!key.startsWith(`${instanceId}\u0000`)) continue;
      this.byKey.delete(key);
      this.byPublicPid.delete(publicPid);
    }
  }

  private allocatePublicPid(): number {
    while (this.byPublicPid.has(this.nextPublicPid)) this.nextPublicPid++;
    return this.nextPublicPid++;
  }

  private pruneInstance(instanceId: string, seen: Set<string>): void {
    for (const [key, publicPid] of this.byKey) {
      if (!key.startsWith(`${instanceId}\u0000`) || seen.has(key)) continue;
      this.byKey.delete(key);
      this.byPublicPid.delete(publicPid);
    }
  }
}
