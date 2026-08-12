// invariant: page-level HostManager singleton, independent of Cordis fibers.
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { pagePorts } from '../engine/ports.js';
import { instancePorts } from '../instance/ports.js';

export type HostContainerState = 'unattached' | 'booting' | 'ready' | 'disposed';
export type HostMode = 'internal' | 'external';

export interface HostManagerHandle {
  readonly mode: HostMode | null;
  readonly state: HostContainerState;
  readonly wc: WebContainer | null;
  readonly hostPid: number | null;
  readonly startedAt: number | null;
}

export class HostManager {
  private mode: HostMode | null = null;
  private state: HostContainerState = 'unattached';
  private wc: WebContainer | null = null;
  private hostProc: WebContainerProcess | null = null;
  private startedAt: number | null = null;

  handle(): HostManagerHandle {
    return {
      mode: this.mode,
      state: this.state,
      wc: this.wc,
      hostPid: this.hostPid(),
      startedAt: this.startedAt,
    };
  }

  hostPid(): number | null {
    return null;
  }

  /** C2 implements single-host boot/attach semantics. */
  async boot(_wc: WebContainer, _opts?: unknown): Promise<void> {
    throw new Error('HostManager.boot is implemented in engine 0.5.0 C2');
  }

  /** C2 implements external attach semantics. */
  async attach(_wc: WebContainer, _opts?: unknown): Promise<void> {
    throw new Error('HostManager.attach is implemented in engine 0.5.0 C2');
  }

  /** C2 implements hard shutdown. */
  async shutdown(): Promise<void> {
    this.state = 'disposed';
    this.wc = null;
    this.hostProc = null;
    this.startedAt = null;
  }

  resetForTests(): void {
    this.mode = null;
    this.state = 'unattached';
    this.wc = null;
    this.hostProc = null;
    this.startedAt = null;
  }
}

let singleton: HostManager | null = null;

export function getHostManager(): HostManager {
  if (!singleton) singleton = new HostManager();
  return singleton;
}

export function resetPageSingletons(): void {
  singleton = null;
  pagePorts.reset();
  instancePorts.clear();
}
