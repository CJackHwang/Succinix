// TerminalExecutor command-line facade (split from index.ts for the 450-line gate).
// Public entry remains @succinix/engine; this module holds the executor class and
// its private helpers. The boot/wait helpers live in index.ts (circular import is
// call-time only and safe in ESM).
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { TerminalClient, type ExecResult } from './client.js';
import type { ProcInfo } from './host-procs.js';
import { RpcTerminalClient, createTerminalIdentity, type TerminalTransportFs } from '../terminal/transport.js';
import {
  USERLAND_DENYLIST,
  USERLAND_PROFILE,
  defaultUserlandCapabilities,
  type UserlandCapabilitySnapshot,
} from '../userland/index.js';
import type {
  DegradationStatus,
  ExecOptions,
  InteractiveTerminalService,
  KillOptions,
  PersistenceStatus,
  ProcessListOptions,
  RuntimeStatus,
  SpawnOptions,
} from './api-types.js';
import {
  bootEngineHost,
  waitForHostReady,
  type EngineBootHooks,
  type TerminalExecutor,
  type TerminalExecutorSeed,
} from './index.js';

const HOST_SHUTDOWN_TIMEOUT_MS = 5000;

function waitForHostExit(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function stopHost(client: TerminalClient, hostProc: WebContainerProcess | null): Promise<void> {
  if (!hostProc) return;
  const fenced = await client.requestHostShutdown(HOST_SHUTDOWN_TIMEOUT_MS);
  if (!fenced) client.prepareHostEpoch(true);
  const exit = (hostProc as unknown as { exit?: Promise<number> }).exit;
  if (exit) {
    await Promise.race([exit.catch(() => undefined), waitForHostExit(HOST_SHUTDOWN_TIMEOUT_MS)]);
  }
  try {
    hostProc.kill();
  } catch {
    /* The process may already have exited after its shutdown acknowledgement. */
  }
}

class TerminalExecutorImpl implements TerminalExecutor {
  private wc: WebContainer | null = null;
  private client: TerminalClient | null = null;
  private hostProc: WebContainerProcess | null = null;
  private sharedHost = false;
  private opts: EngineBootHooks = {};
  private readonly statuses = new Map<string, RuntimeStatus>([
    ['node', { runtime: 'node', state: 'ready', cached: true }],
    ['lifo', { runtime: 'lifo', state: 'loading', cached: false }],
    ['python', { runtime: 'python', state: 'unavailable', cached: false }],
    ['ruby', { runtime: 'ruby', state: 'unavailable', cached: false }],
    ['wasi', { runtime: 'wasi', state: 'unavailable', cached: false }],
  ]);
  private readonly degradationList: DegradationStatus[] = [];

  /** 复用已 boot 的 client / host（createTerminalExecutor(seed) 用；避免双 host） */
  seed(s: TerminalExecutorSeed): void {
    this.wc = s.wc ?? null;
    this.client = s.client ?? null;
    this.hostProc = s.hostProc ?? null;
    this.sharedHost = s.sharedHost ?? false;
  }

  async boot(wc: WebContainer, opts: EngineBootHooks = {}): Promise<void> {
    this.wc = wc;
    this.opts = opts;
    const hooks = opts;
    const hostSrc = hooks.hostSrc ?? (await fetch(opts.hostJsUrl ?? '/host.js').then((r) => r.text()).catch(() => null));
    const lifoCoreSrc = hooks.lifoCoreSrc ?? (await fetch(opts.lifoCoreUrl ?? '/lifo-core.js').then((r) => r.text()).catch(() => null));
    // M5：已 seed 的 client 复用（实例工厂先建带 instanceId 的 client 再 boot，避免双客户端）；
    // 未 seed 时自建（缺省 = 现状，instanceId 经 hooks 透传）。
    if (!this.client) {
      this.client = new TerminalClient(wc, { onCommand: hooks.onCommand, instanceId: hooks.instanceId });
    }
    this.hostProc = await bootEngineHost(wc, this.client, { ...hooks, hostSrc, lifoCoreSrc });
    await waitForHostReady(this.client);
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const client = this.requireClient();
    if (opts.signal?.aborted) return abortedResult();
    let aborting = false;
    const abort = () => {
      aborting = true;
      void client.interruptDirect(Math.min(opts.timeoutMs ?? 2000, 2000));
    };
    opts.signal?.addEventListener('abort', abort, { once: true });
    try {
      const res = await client.terminal(command, {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
      }, opts.timeoutMs);
      this.noteRuntime(command, res);
      if (aborting || opts.signal?.aborted) return { ...abortedResult(), runtime: res.runtime ?? runtimeForCommand(command) };
      return { ...res, timedOut: false };
    } catch (e) {
      if (aborting || opts.signal?.aborted) return abortedResult();
      return { ok: false, exitCode: -1, stdout: '', stderr: String(e), runtime: 'browser', timedOut: true };
    } finally {
      opts.signal?.removeEventListener('abort', abort);
    }
  }

  async spawn(command: string, opts: SpawnOptions = {}): Promise<ExecResult> {
    if (opts.signal?.aborted) return abortedResult();
    const result = await this.requireClient().spawn(command, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
      ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
    }, opts.timeoutMs);
    this.noteRuntime(command, result);
    return result;
  }

  async listProcesses(options: ProcessListOptions = {}): Promise<ProcInfo[]> {
    const res = await this.requireClient().exec('ps', {
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
    });
    const processes = (Array.isArray(res.processes) ? res.processes : []) as unknown as ProcInfo[];
    // Filtering is repeated client-side for compatibility with a v0.6 host.
    return processes.filter((process) =>
      (options.runtime === undefined || process.runtime === options.runtime) &&
      (options.scope === undefined || process.scope === options.scope) &&
      (options.instanceId === undefined || process.instanceId === options.instanceId || process.scope === 'system')
    );
  }

  async kill(pid: number, options: KillOptions = {}): Promise<boolean> {
    const res = await this.requireClient().exec('kill', {
      pid,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.forceAfterMs !== undefined ? { forceAfterMs: options.forceAfterMs } : {}),
      ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
    });
    return res.killed === true;
  }

  async ping(): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    try {
      const res = await client.exec('ping');
      return res.kind === 'pong';
    } catch {
      return false;
    }
  }

  async pingDirect(timeoutMs = 30000): Promise<boolean | null> {
    const client = this.client;
    if (!client) return false;
    return client.pingDirect(timeoutMs);
  }

  async interruptDirect(timeoutMs = 2000): Promise<ExecResult | null> {
    return this.requireClient().interruptDirect(timeoutMs);
  }

  runtimeStatus(): RuntimeStatus[] {
    return [...this.statuses.values()].map((status) => ({ ...status, error: status.error ? { ...status.error } : undefined }));
  }

  persistenceStatus(): PersistenceStatus {
    return { formatVersion: 2, state: 'clean', legacyDetected: false };
  }

  degradations(): DegradationStatus[] {
    return this.degradationList.map((item) => ({ ...item, details: item.details ? { ...item.details } : undefined }));
  }

  capabilities(): UserlandCapabilitySnapshot {
    return {
      profile: USERLAND_PROFILE,
      commands: defaultUserlandCapabilities(),
      denylist: [...USERLAND_DENYLIST],
    };
  }

  // 重启 host（P1-3）：先请求旧 host 收敛并等待退出，再 spawn 新 host（单 host 不变量，防双 host 同时轮询
  // cmd.json），重新注入资产并等待就绪。引擎自包含 —— stop-before-spawn 就地实现，
  // 不依赖系统层 host-restart.ts。
  async respawn(): Promise<void> {
    const wc = this.wc;
    const client = this.client;
    if (!wc || !client) throw new Error('TerminalExecutor not booted — call boot(wc) first');
    const hooks = this.opts as EngineBootHooks;
    // 资产源：boot 时预取的文本优先，否则按配置 URL 拉取（容器内 host.js 已存在则跳过写入）。
    const hostSrc = hooks.hostSrc ?? (await fetch(hooks.hostJsUrl ?? '/host.js').then((r) => r.text()).catch(() => null));
    const lifoCoreSrc = hooks.lifoCoreSrc ?? (await fetch(hooks.lifoCoreUrl ?? '/lifo-core.js').then((r) => r.text()).catch(() => null));
    await stopHost(client, this.hostProc);
    this.hostProc = null;
    client.prepareHostEpoch();
    this.hostProc = await bootEngineHost(wc, client, { ...hooks, hostSrc, lifoCoreSrc });
    client.resumeHostDelivery();
    await waitForHostReady(client);
  }

  async dispose(): Promise<void> {
    if (this.hostProc && !this.sharedHost) {
      await stopHost(this.requireClient(), this.hostProc);
    }
    this.hostProc = null;
    this.client = null;
    this.wc = null;
  }

  async shutdown(): Promise<void> {
    await this.dispose();
  }

  /** 前端需要：host 进程句柄（main.ts 重启路径 kill 旧 host 用） */
  getHostProc(): WebContainerProcess | null {
    return this.hostProc;
  }

  get interactive(): InteractiveTerminalService | undefined {
    const wc = this.wc;
    if (!wc) return undefined;
    return {
      open: async (options) => {
        const fs: TerminalTransportFs = {
          readFile: (path, encoding) => wc.fs.readFile(path, encoding as 'utf8'),
          writeFile: (path, content) => wc.fs.writeFile(path, content),
          readdir: async (path) => (await wc.fs.readdir(path, { withFileTypes: true })).map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
          })),
          mkdir: async (path, options) => {
            if (options?.recursive) await wc.fs.mkdir(path, { recursive: true });
            else await wc.fs.mkdir(path);
          },
          rm: (path, options) => wc.fs.rm(path, options),
          rename: (from, to) => wc.fs.rename(from, to),
        };
        const terminal = new RpcTerminalClient({
          fs,
          identity: createTerminalIdentity(options.instanceId),
          cols: options.cols,
          rows: options.rows,
        });
        await terminal.open();
        return {
          id: terminal.sessionId,
          send: (data: string) => terminal.sendData(data),
          resize: async (cols: number, rows: number) => { terminal.resize(cols, rows); },
          onData: (listener: (data: string) => void) => terminal.onOutput(listener),
          signal: async (signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL') => {
            if (signal === 'SIGINT') {
              await terminal.sendData('\u0003');
              return;
            }
            if (signal === 'SIGTERM' || signal === 'SIGKILL') {
              try { await this.killTerminalSession(terminal.sessionId, options.instanceId, signal); } finally { await terminal.dispose(); }
            }
          },
          close: () => terminal.dispose(),
        };
      },
    };
  }

  private async killTerminalSession(_sessionId: string, _instanceId: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    // Lifo owns the interactive process; the terminal control byte is the
    // portable public seam.  Closing the mailbox after SIGTERM/SIGKILL makes
    // the lifecycle deterministic even when the command has no PID adapter.
    if (signal === 'SIGKILL') {
      try { await this.interruptDirect(1000); } catch { /* best effort */ }
    } else {
      try { await this.interruptDirect(2000); } catch { /* best effort */ }
    }
  }

  private requireClient(): TerminalClient {
    if (!this.client) throw new Error('TerminalExecutor not booted — call boot(wc) first');
    return this.client;
  }

  private noteRuntime(command: string, result: ExecResult): void {
    const runtime = runtimeForCommand(command, result.runtime);
    const failed = result.ok === false && (runtime === 'ruby' || runtime === 'python' || runtime === 'wasi');
    this.statuses.set(runtime, {
      runtime,
      state: failed ? 'failed' : 'ready',
      cached: !failed,
      ...(failed ? {
        error: {
          code: 'RUNTIME_EXEC_FAILED',
          message: String(result.stderr ?? result.error ?? `${runtime} execution failed`).slice(0, 500),
          runtime,
          retryable: true,
          degraded: false,
        },
      } : {}),
    });
  }
}

function runtimeForCommand(command: string, reported?: string): NonNullable<ExecResult['runtime']> {
  const first = command.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (first === 'python' || first === 'python3' || first === 'pip' || first === 'pip3') return 'python';
  if (first === 'ruby') return 'ruby';
  if (first === 'wasi-run' || first === 'wasi-info') return 'wasi';
  if (reported === 'node' || reported === 'python' || reported === 'lifo' || reported === 'wasi' || reported === 'ruby') return reported;
  return first === 'node' || first === 'npm' || first === 'npx' ? 'node' : 'lifo';
}

function abortedResult(): ExecResult {
  return {
    ok: false,
    exitCode: 130,
    stdout: '',
    stderr: 'command aborted',
    error: 'ABORT_ERR',
    runtime: 'browser',
    timedOut: false,
  };
}

/** 构造命令式通道。可选 seed 复用已 boot 的 client（宿主 boot 流程已拉起 host 时，
 *  直接包装既有 TerminalClient，避免双 host；未传时行为不变 —— boot(wc) 自建 client）。 */
export function createTerminalExecutor(seed?: TerminalExecutorSeed): TerminalExecutor {
  const impl = new TerminalExecutorImpl();
  if (seed) {
    impl.seed(seed);
  }
  return impl;
}
