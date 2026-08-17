// Shared fake WebContainer for plugin lifecycle tests.
import { vi } from 'vitest';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { FakeFS } from './fakes.js';

export interface CmdReq {
  protocolVersion?: number;
  id: string | number;
  cmd: string;
  opts?: Record<string, unknown>;
  bootNonce?: string;
  instanceId?: string;
}

export class RpcFakeFS extends FakeFS {
  readonly requests: CmdReq[] = [];

  constructor(private readonly respond: (req: CmdReq) => unknown) {
    super();
  }

  override async writeFile(path: string, content: string): Promise<void> {
    await super.writeFile(path, content);
    if (path === '/cmd.json') {
      const req = JSON.parse(content) as CmdReq;
      this.requests.push(req);
      await super.writeFile(`/ack-${req.id}.json`, JSON.stringify({
        protocolVersion: 2,
        id: req.id,
        bootNonce: req.bootNonce,
        instanceId: req.instanceId ?? 'default',
        acceptedAt: Date.now(),
      }));
      const payload = this.respond(req);
      if (payload !== undefined) {
        await super.writeFile(`/result-${req.id}.json`, JSON.stringify({
          protocolVersion: 2,
          id: req.id,
          bootNonce: req.bootNonce,
          instanceId: req.instanceId ?? 'default',
          ...(payload as object),
        }));
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
  if (req.cmd === 'run') {
    const command = String(req.opts?.command ?? '');
    if (command.startsWith('succinix service ')) {
      if (command.includes("'inspect'")) {
        if (command.includes("'missing'")) return { ok: false, exitCode: 3, stdout: 'null', runtime: 'lifo' };
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify([{ name: 'tinbase', command: 'npx tinbase start --port 3001 --engine wasm', port: 3001, description: 'Tinbase', enabled: false, state: 'stopped' }]),
          runtime: 'lifo',
        };
      }
      if (command.includes("'missing'")) return { ok: false, exitCode: 1, stderr: 'unknown service: missing', runtime: 'lifo' };
    }
  }
  return { ok: true, exitCode: 0, stdout: 'ok', runtime: 'lifo' };
}

export function asWebContainer(wc: FakeWebContainer): WebContainer {
  return wc as unknown as WebContainer;
}
