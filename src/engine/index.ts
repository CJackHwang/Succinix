// WebUnix TerminalExecutor 引擎 —— 公开 API。
// 前端（boot/main/commands/services/tests）与外部生态统一从本模块导入；目录边界即引擎边界。
// 职责：文件型 RPC 客户端（TerminalClient）+ host 注入/拉起（bootEngineHost）+ 干净的命令式接口
// （createTerminalExecutor，生态消费者用）。路由规则（node|npm|npx → 真 Node / 其余 → Lifo）
// 在 host 侧实现（src/engine/host.ts），引擎是自包含模块：不依赖 persist/log/config 等系统层。
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { TerminalClient, type ExecResult, type CommandLogEntry } from './client.js';
import type { ProcInfo } from './host-procs.js';

export { TerminalClient, type ExecResult, type CommandLogEntry } from './client.js';
export type { ProcInfo } from './host-procs.js';

// ─── 公开选项 / 接口（TASK21 契约）───

export interface TerminalExecutorOptions {
  /** host 资产 URL（默认 /host.js） */
  hostJsUrl?: string;
  /** lifo 内核资产 URL（默认 /lifo-core.js） */
  lifoCoreUrl?: string;
  /** 陈旧 result-*.json 存活上限（host 侧 prune；缺省 120000ms）。经容器内配置文件传给 host */
  resultTtlMs?: number;
  /** 端口就绪回调（host 侧 spawn 的服务端口，供宿主登记预览 URL） */
  onServerReady?: (port: number, url: string) => void;
  /** 端口关闭回调（从预览注册表移除） */
  onServerClosed?: (port: number) => void;
}

export interface TerminalExecutor {
  /** 注入 host 资产 + 拉起 host + 等待就绪。解析时引擎可用 */
  boot(wc: WebContainer, opts?: TerminalExecutorOptions): Promise<void>;
  /** 执行一条命令（统一路由：node|npm|npx → 真 Node，其余 → Lifo；协议命令直接命中）。
   *  返回完整 ExecResult（含 protocol 字段如 processes/cwd/killed，见 docs/PROTOCOL.md）。
   *  超时不再抛异常：返回 { ok:false, timedOut:true }。 */
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** 后台长驻进程（仅 node 系）。返回 ExecResult（含 pid）；是 { pid } 契约的超集 */
  spawn(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** 进程表快照（host 拉起的真实子进程） */
  listProcesses(): Promise<ProcInfo[]>;
  /** 终止真实子进程（SIGTERM）；成功返回 true */
  kill(pid: number): Promise<boolean>;
  /** host 存活探测 */
  ping(): Promise<boolean>;
  /** 释放资源（kill host 进程、清引用）。幂等 */
  dispose(): Promise<void>;
}

// ─── host 拉起（前端 boot 与 createTerminalExecutor 共用）───

export interface EngineBootHooks extends TerminalExecutorOptions {
  /** 预取好的 host.js 文本（前端与 WebContainer.boot() 并行预取，消除网络等待在关键路径上） */
  hostSrc?: string | null;
  /** 预取好的 lifo-core.js 文本（同上；host spawn 后异步写入，不进 boot 关键路径） */
  lifoCoreSrc?: string | null;
  /** host.js 缺失、注入完成后回调 */
  onInjected?: () => void;
  /** host spawn 后回调 */
  onSpawned?: () => void;
  /** 命令执行采集点（引擎只产生条目，宿主决定过滤与落盘） */
  onCommand?: (entry: CommandLogEntry) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 注入 host.js（缺失时从构建产物拉取）→ spawn `node host.js` → 异步写 lifo-core.js → 登记端口回调。
// 不等就绪：就绪由 waitForHostReady 负责（boot.ts 在配置/服务初始化之后调用，保持 boot 日志顺序）。
// 返回 host 进程句柄（前端 host 重启路径 kill 用）。
export async function bootEngineHost(
  wc: WebContainer,
  client: TerminalClient,
  hooks: EngineBootHooks = {}
): Promise<WebContainerProcess> {
  // 引擎配置（仅显式传 resultTtlMs 时写）：host 启动读取 /etc/webunix.engine.json 覆盖默认 TTL。
  // 默认不写 —— 全新工作区零额外文件，行为不变。
  if (hooks.resultTtlMs !== undefined) {
    try {
      await wc.fs.mkdir('/etc', { recursive: true });
      await wc.fs.writeFile('/etc/webunix.engine.json', JSON.stringify({ resultTtlMs: hooks.resultTtlMs }));
    } catch {
      /* 写失败不影响：host 回落默认 TTL */
    }
  }
  // 注入 host.js（轻量 daemon）；容器已有则跳过（随快照不持久，但本次会话 boot 后已注入）。
  try {
    await wc.fs.readFile('/host.js');
  } catch {
    const src = hooks.hostSrc ?? (await (await fetch(hooks.hostJsUrl ?? '/host.js')).text());
    await wc.fs.writeFile('/host.js', src);
    hooks.onInjected?.();
  }
  const hostProc = await wc.spawn('node', ['host.js']);
  hooks.onSpawned?.();
  // lifo-core.js 异步写入（不进 boot 关键路径）：host 首个 Lifo 命令时才需要；
  // 写入失败时 host 侧 getSandbox 会重试（容器已有该文件则跳过）。随快照排除（persist）。
  if (hooks.lifoCoreSrc) {
    void wc.fs.writeFile('/lifo-core.js', hooks.lifoCoreSrc).catch(() => {});
  }
  // 端口事件：宿主经 onServerReady/onServerClosed 更新自己的预览注册表。
  wc.on('server-ready', (port, url) => hooks.onServerReady?.(port, url));
  wc.on('port', (port, type) => {
    if (type === 'close') hooks.onServerClosed?.(port);
  });
  return hostProc;
}

// 等 host 就绪：命令轮询循环可响应（pong）。TASK18：重试间隔 300ms → 100ms。
export async function waitForHostReady(client: TerminalClient, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const p = await client.exec('ping', undefined, 2000);
      if (p.kind === 'pong') return;
    } catch {
      /* host 未就绪 */
    }
    await sleep(100);
  }
  throw new Error('host did not respond');
}

// ─── 命令式接口（生态消费者：import { createTerminalExecutor } from '@webunix/engine'）───

class TerminalExecutorImpl implements TerminalExecutor {
  private wc: WebContainer | null = null;
  private client: TerminalClient | null = null;
  private hostProc: WebContainerProcess | null = null;
  private opts: EngineBootHooks = {};

  async boot(wc: WebContainer, opts: TerminalExecutorOptions = {}): Promise<void> {
    this.wc = wc;
    this.opts = opts;
    const hooks = opts as EngineBootHooks;
    const hostSrc = hooks.hostSrc ?? (await fetch(opts.hostJsUrl ?? '/host.js').then((r) => r.text()).catch(() => null));
    const lifoCoreSrc = hooks.lifoCoreSrc ?? (await fetch(opts.lifoCoreUrl ?? '/lifo-core.js').then((r) => r.text()).catch(() => null));
    this.client = new TerminalClient(wc, { onCommand: hooks.onCommand });
    this.hostProc = await bootEngineHost(wc, this.client, { ...hooks, hostSrc, lifoCoreSrc });
    await waitForHostReady(this.client);
  }

  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const client = this.requireClient();
    try {
      const res = await client.terminal(command, undefined, opts.timeoutMs);
      return { ...res, timedOut: false };
    } catch (e) {
      return { ok: false, exitCode: -1, stdout: '', stderr: String(e), runtime: 'browser', timedOut: true };
    }
  }

  async spawn(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return this.requireClient().spawn(command, undefined, opts.timeoutMs);
  }

  async listProcesses(): Promise<ProcInfo[]> {
    const res = await this.requireClient().terminal('ps');
    return (Array.isArray(res.processes) ? res.processes : []) as unknown as ProcInfo[];
  }

  async kill(pid: number): Promise<boolean> {
    const res = await this.requireClient().terminal(`kill ${pid}`);
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

  async dispose(): Promise<void> {
    if (this.hostProc) {
      try {
        this.hostProc.kill();
      } catch {
        /* 句柄失效：忽略 */
      }
      this.hostProc = null;
    }
    this.client = null;
    this.wc = null;
  }

  /** 前端需要：host 进程句柄（main.ts 重启路径 kill 旧 host 用） */
  getHostProc(): WebContainerProcess | null {
    return this.hostProc;
  }

  private requireClient(): TerminalClient {
    if (!this.client) throw new Error('TerminalExecutor not booted — call boot(wc) first');
    return this.client;
  }
}

export function createTerminalExecutor(): TerminalExecutor {
  return new TerminalExecutorImpl();
}
