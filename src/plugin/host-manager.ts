// invariant: page-level HostManager singleton, independent of Cordis fibers.
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import {
  bootEngineHost,
  TerminalClient,
  waitForHostReady,
  type CommandLogEntry,
} from '../engine/index.js';
import { sleep } from '../engine/sleep.js';
import { pagePorts } from '../engine/ports.js';
import { instancePorts } from '../instance/ports.js';
import { invariant } from './invariant.js';

export type HostContainerState = 'unattached' | 'booting' | 'ready' | 'disposed';
export type HostMode = 'internal' | 'external';

export interface HostManagerHandle {
  readonly mode: HostMode | null;
  readonly state: HostContainerState;
  readonly wc: WebContainer | null;
  readonly hostPid: number | null;
  readonly startedAt: number | null;
}

export interface HostManagerBootOptions {
  mode: HostMode;
  bootRetries: number;
  bootIntervalMs: number;
  hostReadyDeadlineMs: number;
  resultTtlMs?: number;
  hostJsUrl: string;
  lifoCoreUrl: string;
  hostSrc?: string | null;
  lifoCoreSrc?: string | null;
  onCommand?: (entry: CommandLogEntry) => void;
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

  /** Internal container mode: WebContainer is booted by the plugin. */
  async boot(wc: WebContainer, opts: HostManagerBootOptions): Promise<void> {
    return this.ensureHost(wc, { ...opts, mode: 'internal' });
  }

  /** External container mode: the host application owns the WebContainer. */
  async attach(wc: WebContainer, opts: HostManagerBootOptions): Promise<void> {
    return this.ensureHost(wc, { ...opts, mode: 'external' });
  }

  /** Hard shutdown: kill the host and reset page-level state. */
  async shutdown(): Promise<void> {
    if (this.hostProc) {
      try {
        this.hostProc.kill();
      } catch {
        /* stale host handle: ignore */
      }
    }
    this.hostProc = null;
    this.wc = null;
    this.mode = null;
    this.startedAt = null;
    this.state = 'disposed';
  }

  resetForTests(): void {
    this.mode = null;
    this.state = 'unattached';
    this.wc = null;
    this.hostProc = null;
    this.startedAt = null;
  }

  private async ensureHost(wc: WebContainer, opts: HostManagerBootOptions): Promise<void> {
    invariant(wc && typeof wc.spawn === 'function', 'HostManager requires a WebContainer');
    if (this.state === 'ready' && this.mode === opts.mode) return;
    if ((this.state === 'ready' || this.state === 'booting') && this.mode && this.mode !== opts.mode) {
      throw new Error(`ERR_MODE_MISMATCH: cannot switch from ${this.mode} to ${opts.mode} mode`);
    }

    this.mode = opts.mode;
    this.wc = wc;
    this.state = 'booting';
    const client = new TerminalClient(wc, { onCommand: opts.onCommand });
    const readyAttempts = Math.max(1, Math.ceil(opts.hostReadyDeadlineMs / 100));
    let lastError: unknown = null;

    for (let attempt = 0; attempt < opts.bootRetries; attempt++) {
      try {
        if (this.hostProc) {
          try {
            this.hostProc.kill();
          } catch {
            /* stale host handle: ignore */
          }
          this.hostProc = null;
        }
        this.hostProc = await bootEngineHost(wc, client, {
          resultTtlMs: opts.resultTtlMs,
          hostJsUrl: opts.hostJsUrl,
          lifoCoreUrl: opts.lifoCoreUrl,
          hostSrc: opts.hostSrc,
          lifoCoreSrc: opts.lifoCoreSrc,
        });
        await waitForHostReady(client, readyAttempts);
        this.startedAt = Date.now();
        this.state = 'ready';
        return;
      } catch (error) {
        lastError = error;
        if (this.hostProc) {
          try {
            this.hostProc.kill();
          } catch {
            /* stale host handle: ignore */
          }
          this.hostProc = null;
        }
        if (attempt < opts.bootRetries - 1) await sleep(opts.bootIntervalMs);
      }
    }

    this.state = 'unattached';
    throw lastError ?? new Error('host boot failed');
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
