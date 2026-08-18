// Succinix TerminalExecutor 引擎 —— 公开 API。
// 前端（boot/main/commands/services/tests）与外部生态统一从本模块导入；目录边界即引擎边界。
// 职责：文件型 RPC 客户端（TerminalClient）+ host 注入/拉起（bootEngineHost）+ 干净的命令式接口
// （createTerminalExecutor，生态消费者用）。路由规则（node|npm|npx → 真 Node / 其余 → Lifo）
// 在 host 侧实现（src/engine/host/），引擎是自包含模块：不依赖 persist/log/config 等系统层。
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { TerminalClient, type ExecResult, type CommandLogEntry } from './client.js';
import type { ProcInfo } from './host-procs.js';
import { DEFAULT_INSTANCE_ID, instanceStateFile } from './host-route.js';
import { RPC_HOST_EPOCH_FILE, RPC_PROTOCOL_VERSION } from './rpc-v2.js';
import { pagePorts } from './ports.js';
import { sleep } from './sleep.js';
import type { UserlandCapabilitySnapshot } from '../userland/index.js';
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

export type {
  DegradationStatus,
  ExecOptions,
  InteractiveTerminalOpenOptions,
  InteractiveTerminalService,
  InteractiveTerminalSession,
  KillOptions,
  PersistenceStatus,
  ProcessListOptions,
  RuntimeErrorShape,
  RuntimeStatus,
  SpawnOptions,
} from './api-types.js';

export { TerminalClient, type ExecResult, type CommandLogEntry } from './client.js';
export type { ProcInfo } from './host-procs.js';
export { isValidInstanceId, normalizeInstanceId } from './host-route.js';
export { ensurePythonRuntime, PYTHON_RUNTIME_DIR } from './python-assets.js';
export { ensureRubyRuntime, RUBY_RUNTIME_DIR, RUBY_RUNTIME_VERSION } from './ruby-assets.js';
export {
  startRuntimeAssetBridge,
  RUNTIME_REQUEST_ROOT,
  type RuntimeAssetBridgeController,
  type RuntimeAssetBridgeOptions,
} from './runtime-asset-bridge.js';
export {
  startBrowserControlBridge,
  type BrowserControlBridgeController,
  type BrowserControlBridgeHandlers,
  type BrowserControlBridgeOptions,
} from './browser-control-bridge.js';
export {
  CONTROL_REQUEST_ROOT,
  type BrowserControlAction,
  type BrowserControlRequest,
  type BrowserControlResponse,
} from './control-protocol.js';
export { pagePorts, type PortEventHooks } from './ports.js';
export {
  RpcTerminalClient,
  createTerminalIdentity,
  type BrowserRpcTerminalOptions,
  type TerminalTransportFs,
} from '../terminal/transport.js';
export { TERMINAL_MAX_BUFFER_BYTES, TerminalBackpressureError } from '../terminal/transport-protocol.js';
export type {
  TerminalIdentity,
  TerminalOutputFrame,
} from '../terminal/transport-protocol.js';
export {
  USERLAND_PROFILE,
  USERLAND_DENY_EXIT_CODE,
  USERLAND_DENYLIST,
  defaultUserlandCapabilities,
  deniedCommandCapability,
  denylistedCommandResult,
  isDenylistedCommand,
  createUserlandRegistry,
  type UserlandCommandStatus,
  type UserlandRuntime,
  type UserlandExecution,
  type UserlandCommandCapability,
  type UserlandCapabilitySnapshot,
  type UserlandRegistry,
  type UserlandCommandDefinition,
  type UserlandPackageSource,
  type UserlandServiceTemplate,
} from '../userland/index.js';

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

export interface TerminalExecutorSeed {
  wc?: WebContainer | null;
  client?: TerminalClient | null;
  hostProc?: WebContainerProcess | null;
  /** Shared host mode: the page owns the host, so dispose clears references only. */
  sharedHost?: boolean;
}

export interface TerminalExecutor {
  /** 注入 host 资产 + 拉起 host + 等待就绪。解析时引擎可用。
   *  opts 即 EngineBootHooks（在 TerminalExecutorOptions 之上额外支持预取的 hostSrc / lifoCoreSrc /
   *  onInjected / onSpawned / onCommand 采集点）。 */
  boot(wc: WebContainer, opts?: EngineBootHooks): Promise<void>;
  /** 执行一条命令（统一路由：node|npm|npx → 真 Node，其余 → Lifo；协议命令直接命中）。
   *  返回完整 ExecResult（含 protocol 字段如 processes/cwd/killed，见 docs/PROTOCOL.md）。
   *  超时不再抛异常：返回 { ok:false, timedOut:true }。 */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** 后台长驻进程（仅 node 系）。返回 ExecResult（含 pid）；是 { pid } 契约的超集 */
  spawn(command: string, opts?: SpawnOptions): Promise<ExecResult>;
  /** 进程表快照（host 拉起的真实子进程） */
  listProcesses(options?: ProcessListOptions): Promise<ProcInfo[]>;
  /** 终止真实子进程（SIGTERM）；成功返回 true */
  kill(pid: number, options?: KillOptions): Promise<boolean>;
  /** host 存活探测 */
  ping(): Promise<boolean>;
  /** 看门狗直接探活（P1-3）：绕过互斥队列 —— 长命令占着队列时也能及时确认 host 存活。
   *  true=host 存活（pong）；false=超时；null=通道忙（有排队未启动请求 / 刚写入在途 cmd.json），本轮跳过（中性）。 */
  pingDirect(timeoutMs?: number): Promise<boolean | null>;
  /** Ctrl+C 真中断（P5-15）：绕过互斥队列直接发 interrupt；pid 为数字 = 已向该进程发 kill；
   *  pid 为 null = 无当前 run 可中断；null = 通道忙 / 无法发送。 */
  interruptDirect(timeoutMs?: number): Promise<ExecResult | null>;
  /** Current runtime readiness snapshot (v0.7). */
  runtimeStatus(): RuntimeStatus[];
  /** Persistence health snapshot supplied by the host/application. */
  persistenceStatus(): PersistenceStatus;
  /** Registered capability degradations, if any. */
  degradations(): DegradationStatus[];
  /** Stable execution-world capability profile (v0.7). */
  capabilities(): UserlandCapabilitySnapshot;
  /** Open a WebContainer-native interactive terminal session. */
  readonly interactive?: InteractiveTerminalService;
  /** 重启 host（P1-3）：kill 旧 host 再 spawn 新 host（单 host 不变量，防双 host 同时轮询
   *  cmd.json），重新注入资产并等待就绪。返回后 host 可立即接受命令。 */
  respawn(): Promise<void>;
  /** 当前 host 进程句柄（宿主重启路径 / M5 实例聚合返回用）；未 boot / 已 dispose 返回 null */
  getHostProc(): WebContainerProcess | null;
  /** 释放资源（kill host 进程、清引用）。幂等 */
  dispose(): Promise<void>;
  /** Alias for dispose() used by SDK consumers. */
  shutdown(): Promise<void>;
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

// 注入 host.js（缺失时从构建产物拉取）→ spawn `node host.js` → 异步写 lifo-core.js → 登记端口回调。
// 不等就绪：就绪由 waitForHostReady 负责（boot.ts 在配置/服务初始化之后调用，保持 boot 日志顺序）。
// 返回 host 进程句柄（前端 host 重启路径 kill 用）。
export async function bootEngineHost(
  wc: WebContainer,
  client: TerminalClient,
  hooks: EngineBootHooks = {}
): Promise<WebContainerProcess> {
  const bootNonce = client.takeHostEpoch();
  await writeHostEpoch(wc, bootNonce);
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
  forwardHostOutput(hostProc);
  hooks.onSpawned?.();
  // lifo-core.js 异步写入（不进 boot 关键路径）：host 首个 Lifo 命令时才需要；
  // 写入失败时 host 侧 getSandbox 会重试（容器已有该文件则跳过）。随快照排除（persist）。
  if (hooks.lifoCoreSrc) {
    void wc.fs.writeFile('/lifo-core.js', hooks.lifoCoreSrc).catch(() => {});
  }
  // 端口事件（D2）：页面级分发 —— bind 只对当前 wc 执行一次（R3.2 重试复用同一 wc，
  // 不再叠加监听器；重试传的 hooks 不含端口回调，也不会覆盖首次订阅）。
  // 携带端口回调的调用按实例订阅/覆盖钩子；同页多个实例各自订阅，事件按期望归属分发。
  pagePorts.bind(wc);
  if (hooks.onServerReady || hooks.onServerClosed) {
    pagePorts.subscribe(hooks.instanceId ?? DEFAULT_INSTANCE_ID, hooks);
  }
  return hostProc;
}

async function writeHostEpoch(wc: WebContainer, bootNonce: string): Promise<void> {
  const payload = JSON.stringify({ protocolVersion: RPC_PROTOCOL_VERSION, bootNonce, createdAt: Date.now() });
  const temp = `${RPC_HOST_EPOCH_FILE}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await wc.fs.writeFile(temp, payload);
  const fs = wc.fs as unknown as { rename?: (from: string, to: string) => Promise<void>; writeFile(path: string, data: string): Promise<void> };
  if (fs.rename) await fs.rename(temp, RPC_HOST_EPOCH_FILE);
  else await fs.writeFile(RPC_HOST_EPOCH_FILE, payload);
}

// WebContainer 子进程的输出流必须持续消费；否则启动失败的堆栈会被静默丢失，
// 也可能因未消费的输出产生背压。正常 host 不输出，故只在异常时写入浏览器控制台。
function forwardHostOutput(hostProc: WebContainerProcess): void {
  const output = hostProc.output as unknown;
  if (!output || typeof (output as { pipeTo?: unknown }).pipeTo !== 'function') return;
  void (output as ReadableStream<string>).pipeTo(new WritableStream<string>({
    write(chunk) {
      if (chunk.trim()) console.error(`[succinix host] ${chunk.trimEnd()}`);
    },
  })).catch(() => {
    /* Host 退出会关闭输出流；这里无需浏览器侧恢复。 */
  });
}

export interface HostReadyWaitOptions {
  /** 兼容旧调用的最多探测次数；未设置 deadline 时默认 60 次。 */
  attempts?: number;
  /** 从调用开始计算的硬截止时间，避免每次 ping 的超时累加突破配置上限。 */
  deadlineMs?: number;
}

// 等 host 就绪：命令轮询循环可响应（pong）。TASK18：重试间隔 300ms → 100ms。
export async function waitForHostReady(
  client: TerminalClient,
  options: number | HostReadyWaitOptions = 60,
): Promise<void> {
  const attempts = typeof options === 'number' ? options : options.attempts;
  const deadline = typeof options === 'number' || options.deadlineMs === undefined
    ? undefined
    : Date.now() + options.deadlineMs;
  let count = 0;
  while (attempts === undefined || count < attempts) {
    const remaining = deadline === undefined ? 2_000 : deadline - Date.now();
    if (remaining <= 0) break;
    count += 1;
    try {
      const p = await client.exec('ping', undefined, Math.min(2_000, remaining));
      if (p.kind === 'pong') return;
    } catch {
      /* host 未就绪 */
    }
    const retryDelay = deadline === undefined ? 100 : Math.min(100, Math.max(0, deadline - Date.now()));
    if (retryDelay > 0) await sleep(retryDelay);
  }
  throw new Error('host did not respond');
}

// ─── 命令式接口（生态消费者：import { createTerminalExecutor } from '@succinix/engine'）───


// 命令式接口（生态消费者）：实现已拆到 terminal-executor.ts（文件规模门禁）。
export { createTerminalExecutor } from './terminal-executor.js';
