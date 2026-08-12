// Shared fake WebContainer for plugin lifecycle tests.
import { vi } from 'vitest';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { FakeFS } from './fakes.js';

export interface CmdReq {
  protocol?: number;
  id: number;
  cmd: string;
  opts?: Record<string, unknown>;
}

export class RpcFakeFS extends FakeFS {
  constructor(private readonly respond: (req: CmdReq) => unknown) {
    super();
  }

  override async writeFile(path: string, content: string): Promise<void> {
    await super.writeFile(path, content);
    if (path === '/cmd.json') {
      const req = JSON.parse(content) as CmdReq;
      const payload = this.respond(req);
      if (payload !== undefined) {
        await super.writeFile(`/result-${req.id}.json`, JSON.stringify({ id: req.id, ...(payload as object) }));
      }
    }
  }
}

export class FakeWebContainer {
  readonly fs: RpcFakeFS;
  readonly spawnCalls: Array<{ prog: string; args: string[] }> = [];
  readonly hostProc: WebContainerProcess = { kill: vi.fn() } as unknown as WebContainerProcess;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly spawn = vi.fn(async (prog: string, args: string[]) => {
    this.spawnCalls.push({ prog, args });
    return this.hostProc;
  });
  readonly on = vi.fn((type: string, callback: (...args: unknown[]) => void) => {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(callback);
  });

  constructor(respond?: (req: CmdReq) => unknown) {
    this.fs = new RpcFakeFS(respond ?? defaultRespond);
  }

  emit(type: string, ...args: unknown[]): void {
    for (const callback of this.listeners.get(type) ?? []) callback(...args);
  }

  emitServerReady(port: number, url: string): void {
    this.emit('server-ready', port, url);
  }

  emitPortClosed(port: number): void {
    this.emit('port', port, 'close');
  }
}

function defaultRespond(req: CmdReq): unknown {
  if (req.cmd === 'ping') return { ok: true, kind: 'pong' };
  if (req.cmd === 'ps') return { ok: true, processes: [] };
  if (req.cmd === 'spawn') return { ok: true, pid: 123, runtime: 'node' };
  return { ok: true, exitCode: 0, stdout: 'ok', runtime: 'lifo' };
}

export function asWebContainer(wc: FakeWebContainer): WebContainer {
  return wc as unknown as WebContainer;
}
