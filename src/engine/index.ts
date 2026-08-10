// Succinix TerminalExecutor 引擎 —— 公开 API。
// 前端（boot/main/commands/services/tests）与外部生态统一从本模块导入；目录边界即引擎边界。
// 职责：文件型 RPC 客户端（TerminalClient）+ host 注入/拉起（bootEngineHost）+ 干净的命令式接口
// （createTerminalExecutor，生态消费者用）。路由规则（node|npm|npx → 真 Node / 其余 → Lifo）
// 在 host 侧实现（src/engine/host.ts），引擎是自包含模块：不依赖 persist/log/config 等系统层。
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { TerminalClient, type ExecResult, type CommandLogEntry } from './client.js';
import type { ProcInfo } from './host-procs.js';
import { DEFAULT_INSTANCE_ID, instanceStateFile } from './host-route.js';
import { sleep } from './sleep.js';

export { TerminalClient, type ExecResult, type CommandLogEntry } from './client.js';
export type { ProcInfo } from './host-procs.js';
export { ensurePythonRuntime, PYTHON_RUNTIME_DIR } from './python-assets.js';

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
  /** 注入 host 资产 + 拉起 host + 等待就绪。解析时引擎可用。
   *  opts 即 EngineBootHooks（在 TerminalExecutorOptions 之上额外支持预取的 hostSrc / lifoCoreSrc /
   *  onInjected / onSpawned / onCommand 采集点）。 */
  boot(wc: WebContainer, opts?: EngineBootHooks): Promise<void>;
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
  /** 看门狗直接探活（P1-3）：绕过互斥队列 —— 长命令占着队列时也能及时确认 host 存活。
   *  true=host 存活（pong）；false=超时；null=通道忙（有排队未启动请求 / 刚写入在途 cmd.json），本轮跳过（中性）。 */
  pingDirect(timeoutMs?: number): Promise<boolean | null>;
  /** Ctrl+C 真中断（P5-15）：绕过互斥队列直接发 interrupt；pid 为数字 = 已向该进程发 kill；
   *  pid 为 null = 无当前 run 可中断；null = 通道忙 / 无法发送。 */
  interruptDirect(timeoutMs?: number): Promise<ExecResult | null>;
  /** 重启 host（P1-3）：kill 旧 host 再 spawn 新 host（单 host 不变量，防双 host 同时轮询
   *  cmd.json），重新注入资产并等待就绪。返回后 host 可立即接受命令。 */
  respawn(): Promise<void>;
  /** 当前 host 进程句柄（宿主重启路径 / M5 实例聚合返回用）；未 boot / 已 dispose 返回 null */
  getHostProc(): WebContainerProcess | null;
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
  /** 实例上下文（M5，additive）：客户端请求写入 /cmd.json 时回带 instanceId（host 按实例
   *  路由）；host 引擎配置（resultTtlMs）按实例状态根落盘。缺省 = 默认实例（现状全等）。 */
  instanceId?: string;
}

// M1：端口事件（server-ready / port）只对同一 wc 实例注册一次。R3.2 重试会再次调用
// bootEngineHost（kill 旧 host 再 spawn），若每次都 wc.on(...) 会累积重复监听器；
// 重试传的 hooks 不含 onServerReady/onServerClosed（空安全调用），重复注册的监听器
// 是 no-op 且永不注销。WeakSet 按实例去重：正常多实例 boot 各自注册，重试同实例跳过。
const wcListenersBound = new WeakSet<WebContainer>();

// 注入 host.js（缺失时从构建产物拉取）→ spawn `node host.js` → 异步写 lifo-core.js → 登记端口回调。
// 不等就绪：就绪由 waitForHostReady 负责（boot.ts 在配置/服务初始化之后调用，保持 boot 日志顺序）。
// 返回 host 进程句柄（前端 host 重启路径 kill 用）。
export async function bootEngineHost(
  wc: WebContainer,
  client: TerminalClient,
  hooks: EngineBootHooks = {}
): Promise<WebContainerProcess> {
  // 引擎配置（仅显式传 resultTtlMs 时写）：host 启动读取 /etc/succinix.engine.json 覆盖默认 TTL。
  // 默认不写 —— 全新工作区零额外文件，行为不变。
  // M2/M5：多实例下 host 按请求 instanceId 解析自身配置路径（全局单份 /etc 配置会串扰），
  // 这里落到该实例的 <stateRoot>/etc/succinix.engine.json（缺省实例 = /etc，现状全等）。
  if (hooks.resultTtlMs !== undefined) {
    const cfgPath = instanceStateFile(hooks.instanceId ?? DEFAULT_INSTANCE_ID, '', 'etc/succinix.engine.json');
    try {
      const parent = cfgPath.slice(0, cfgPath.lastIndexOf('/')) || '/';
      await wc.fs.mkdir(parent, { recursive: true });
      await wc.fs.writeFile(cfgPath, JSON.stringify({ resultTtlMs: hooks.resultTtlMs }));
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
  // 只对当前 wc 注册一次（M1：R3.2 重试 bootEngineHost 复用同一 wc，不再叠加监听器）。
  if (!wcListenersBound.has(wc)) {
    wcListenersBound.add(wc);
    wc.on('server-ready', (port, url) => hooks.onServerReady?.(port, url));
    wc.on('port', (port, type) => {
      if (type === 'close') hooks.onServerClosed?.(port);
    });
  }
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

// ─── 命令式接口（生态消费者：import { createTerminalExecutor } from '@succinix/engine'）───

class TerminalExecutorImpl implements TerminalExecutor {
  private wc: WebContainer | null = null;
  private client: TerminalClient | null = null;
  private hostProc: WebContainerProcess | null = null;
  private opts: EngineBootHooks = {};

  /** 复用已 boot 的 client / host（createTerminalExecutor(seed) 用；避免双 host） */
  seed(s: { wc?: WebContainer | null; client?: TerminalClient | null; hostProc?: WebContainerProcess | null }): void {
    this.wc = s.wc ?? null;
    this.client = s.client ?? null;
    this.hostProc = s.hostProc ?? null;
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

  async pingDirect(timeoutMs = 30000): Promise<boolean | null> {
    const client = this.client;
    if (!client) return false;
    return client.pingDirect(timeoutMs);
  }

  async interruptDirect(timeoutMs = 2000): Promise<ExecResult | null> {
    return this.requireClient().interruptDirect(timeoutMs);
  }

  // 重启 host（P1-3）：kill 旧 host 再 spawn 新 host（单 host 不变量，防双 host 同时轮询
  // cmd.json），重新注入资产并等待就绪。引擎自包含 —— kill-before-spawn 就地实现，
  // 不依赖系统层 host-restart.ts。
  async respawn(): Promise<void> {
    const wc = this.wc;
    const client = this.client;
    if (!wc || !client) throw new Error('TerminalExecutor not booted — call boot(wc) first');
    const hooks = this.opts as EngineBootHooks;
    // 资产源：boot 时预取的文本优先，否则按配置 URL 拉取（容器内 host.js 已存在则跳过写入）。
    const hostSrc = hooks.hostSrc ?? (await fetch(hooks.hostJsUrl ?? '/host.js').then((r) => r.text()).catch(() => null));
    const lifoCoreSrc = hooks.lifoCoreSrc ?? (await fetch(hooks.lifoCoreUrl ?? '/lifo-core.js').then((r) => r.text()).catch(() => null));
    // kill 旧 host 必须在 spawn 新 host 之前（单 host 不变量）。旧句柄失效时 kill 是 no-op。
    try {
      this.hostProc?.kill();
    } catch {
      /* 旧句柄失效：忽略 */
    }
    this.hostProc = await bootEngineHost(wc, client, { ...hooks, hostSrc, lifoCoreSrc });
    await waitForHostReady(client);
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

/** 构造命令式通道。可选 seed 复用已 boot 的 client（宿主 boot 流程已拉起 host 时，
 *  直接包装既有 TerminalClient，避免双 host；未传时行为不变 —— boot(wc) 自建 client）。 */
export function createTerminalExecutor(seed?: {
  wc?: WebContainer | null;
  client?: TerminalClient | null;
  hostProc?: WebContainerProcess | null;
}): TerminalExecutor {
  const impl = new TerminalExecutorImpl();
  if (seed) {
    impl.seed(seed);
  }
  return impl;
}
