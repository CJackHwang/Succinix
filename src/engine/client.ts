// TerminalExecutor 客户端：浏览器侧单一入口，内部走文件型 RPC。
// 通道与 host 保持一致：/cmd.json {id,cmd,opts} → /result-<id>.json（每请求独立结果文件）。
import type { WebContainer } from '@webcontainer/api';
import { sleep } from './sleep.js';
import { DEFAULT_INSTANCE_ID } from './host-route.js';
import {
  RPC_PROTOCOL_VERSION, inferRuntimeHint, makeRpcBootNonce, makeRpcRequestPrefix,
  rpcAckPath, rpcResultPath, type RpcRequestId, type RpcTiming, type RpcV2Envelope,
} from './rpc-v2.js';

// host 响应统一形状；具体字段依 cmd 而定（run/ps/kill/spawn/cwd/ping/exit）。
export interface ExecResult {
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  runtime?: 'node' | 'python' | 'lifo' | 'wasi' | 'ruby' | 'browser';
  kind?: string;
  cwd?: string;
  pid?: number;
  processes?: Array<Record<string, unknown>>;
  killed?: boolean;
  message?: string;
  error?: string;
  /** 引擎 exec 超时时置 true（原始 RPC 超时抛异常，引擎层捕获转结果） */
  timedOut?: boolean;
  timing?: RpcTiming;
  [key: string]: unknown;
}

// 命令执行采集条目（TASK21：日志从引擎解耦 —— 引擎只产生条目，宿主决定是否落盘）。
export interface CommandLogEntry {
  command: string;
  exit: number | null;
  runtime: string;
}

export interface TerminalClientOptions {
  /** 命令执行采集点：terminal/spawn 完成后回调（宿主负责过滤与落盘；缺省不记录） */
  onCommand?: (entry: CommandLogEntry) => void;
  /** 实例上下文（M3/M5，additive）：请求写入 /cmd.json 时回带 instanceId，host 按实例路由。
   *  缺省 = 默认实例（不写字段，旧行为不变）。同页多实例共享单 host 时每个实例一个 client，
   *  各带自己的 instanceId；client 按 wc 共享底层通道（见 channelFor），不会互相覆盖。 */
  instanceId?: string;
}

// 只读/幂等协议命令：RPC 传输失败时允许重试 1 次（TASK16 稳定性）。
// ping/ps/cwd 重发安全；kill / run / spawn 等非幂等命令一律不重试。
const READONLY_PROTO = new Set(['ping', 'ps', 'cwd']);

// ─── 同页共享 RPC 通道（M5）───
// /cmd.json 是单槽信箱：同一页面的多个 TerminalClient（同页多实例，DM-11）若各有独立
// 互斥队列，并发写会互相覆盖（后写吞先写，先发请求等不到结果、30s 超时）。通道按
// WebContainer 实例去重 —— 同 wc 的所有 client 共享同一队列 / 请求 id / 写时序判定
// （看门狗 pingDirect 与 Ctrl+C interruptDirect 的覆盖安全窗口也共享，跨实例不误判）。
// 单 client 时行为与独立队列完全一致（同一通道，无竞争者）。
interface Channel {
  sequence: number;
  requestPrefix: string;
  bootNonce: string;
  normal: DeliveryTask[];
  priority: DeliveryTask[];
  delivering: boolean;
  activeResults: number;
  lastCmdWrite: number;
}

interface DeliveryTask {
  request: RpcV2Envelope;
  timeoutMs: number;
  startedAt: number;
  resolve: (acceptedAt: number) => void;
  reject: (error: Error) => void;
}

const channels = new WeakMap<WebContainer, Channel>();

function channelFor(wc: WebContainer): Channel {
  let ch = channels.get(wc);
  if (!ch) {
    ch = {
      sequence: 0, requestPrefix: makeRpcRequestPrefix(), bootNonce: makeRpcBootNonce(),
      normal: [], priority: [], delivering: false, activeResults: 0, lastCmdWrite: 0,
    };
    channels.set(wc, ch);
  }
  return ch;
}

export class TerminalClient {
  private options: TerminalClientOptions;
  // 同页共享通道（M5）：请求互斥队列 / id / pending / active / 写时序全部在通道上，
  // 同一 wc 的多个 client（多实例）共享一份 —— 互斥队列语义与单 client 完全一致。
  private readonly ch: Channel;

  constructor(
    private wc: WebContainer,
    options: TerminalClientOptions = {}
  ) {
    this.options = options;
    this.ch = channelFor(wc);
  }

  // 请求携带实例上下文（M3/M5）：非默认实例写入 instanceId 字段（additive，旧 host 忽略）。
  private stamp(payload: Record<string, unknown>): Record<string, unknown> {
    if (this.options.instanceId && this.options.instanceId !== DEFAULT_INSTANCE_ID) {
      payload.instanceId = this.options.instanceId;
    }
    return payload;
  }

  // 统一终端入口：协议命令（ps / kill <pid> / cwd / ping / exit）直接命中；
  // 其余命令作为 run 发送，由 host 统一路由到真 Node 或 Lifo。
  async terminal(command: string, opts?: Record<string, unknown>, timeoutMs = 30000): Promise<ExecResult> {
    const trimmed = command.trim();
    let res: ExecResult;
    if (trimmed === 'ps' || trimmed === 'cwd' || trimmed === 'ping' || trimmed === 'exit') {
      res = await this.exec(trimmed, undefined, timeoutMs);
    } else {
      const killMatch = /^kill\s+(\d+)$/.exec(trimmed);
      if (killMatch) {
        res = await this.exec('kill', { pid: Number(killMatch[1]), ...opts }, timeoutMs);
      } else {
        // TASK23：setCwd <dir> 协议命令（显式设置会话 cwd；cd 命令的自动同步已覆盖交互路径）。
        const setCwdMatch = /^setCwd\s+(.+)$/.exec(trimmed);
        if (setCwdMatch) {
          res = await this.exec('setCwd', { cwd: setCwdMatch[1].trim() }, timeoutMs);
        } else {
          res = await this.exec('run', { command, ...opts }, timeoutMs);
        }
      }
    }
    // TASK12：命令执行采集点（INFO）——cmd/exit/runtime。协议命令无 runtime 字段，标 protocol。
    // TASK16 R2 降噪：纯轮询 ps（top/service 内部高频调用）跳过命令日志，避免刷屏；kill 保留。
    // TASK21：日志已从引擎解耦 —— 引擎只产生条目，宿主在 onCommand 里决定过滤（如跳过 ps）与落盘。
    this.options.onCommand?.({
      command,
      exit: res.exitCode ?? (res.ok ? 0 : 1),
      runtime: res.runtime ?? 'protocol',
    });
    return res;
  }

  // D3：实例级重置协议命令（reset-instance）—— host 侧按实例 kill 归属进程 +
  // 清会话 cwd / currentRun 缓存。走常规互斥队列（与在途请求串行，不覆盖 cmd.json）；
  // 非幂等不重试，host 不可达时抛错，由调用方决定是否继续浏览器侧清理。
  async resetInstance(timeoutMs = 30000): Promise<ExecResult> {
    return this.exec('reset-instance', undefined, timeoutMs);
  }

  // spawn：后台长驻进程（仅 node 系）。host 立即返回 { ok, pid }，输出持续收集进进程表。
  async spawn(command: string, opts?: Record<string, unknown>, timeoutMs = 5000): Promise<ExecResult> {
    const res = await this.exec('spawn', { command, ...opts }, timeoutMs);
    // TASK12：spawn 后台进程同样记录（host 返回 runtime: 'node'，缺失时按 node 处理）。
    this.options.onCommand?.({
      command,
      exit: res.exitCode ?? (res.ok ? 0 : 1),
      runtime: res.runtime ?? 'node',
    });
    return res;
  }

  // 文件 RPC 核心：写 /cmd.json，轮询 /result-<id>.json，读到即删。
  // 经互斥队列串行；只读协议命令失败重试 1 次（幂等，重发安全）。
  async exec(cmd: string, opts?: Record<string, unknown>, timeoutMs = 30000): Promise<ExecResult> {
    const first = this.enqueue(cmd, opts, timeoutMs);
    if (!READONLY_PROTO.has(cmd)) return first;
    try {
      return await first;
    } catch {
      // 只读命令：首次传输失败（超时/FS 抖动）→ 排队重试一次。重试也失败则向上抛。
      return await this.enqueue(cmd, opts, timeoutMs);
    }
  }

  private enqueue(cmd: string, opts: Record<string, unknown> | undefined, timeoutMs: number): Promise<ExecResult> {
    const id = `${this.ch.requestPrefix}-${++this.ch.sequence}`;
    return this.doExec(id, cmd, opts, timeoutMs, false);
  }

  private request(id: RpcRequestId, cmd: string, opts: Record<string, unknown> | undefined): RpcV2Envelope {
    return this.stamp({
      protocolVersion: RPC_PROTOCOL_VERSION,
      id,
      cmd,
      opts,
      bootNonce: this.ch.bootNonce,
      runtimeHint: inferRuntimeHint(cmd, opts),
      queuedAt: Date.now(),
    }) as unknown as RpcV2Envelope;
  }

  private deliver(request: RpcV2Envelope, timeoutMs: number, priority: boolean): Promise<number> {
    const startedAt = Date.now();
    return new Promise<number>((resolve, reject) => {
      const task: DeliveryTask = { request, timeoutMs, startedAt, resolve, reject };
      (priority ? this.ch.priority : this.ch.normal).push(task);
      this.pumpDeliveries();
    });
  }

  private pumpDeliveries(): void {
    const ch = this.ch;
    if (ch.delivering) return;
    const task = ch.priority.shift() ?? ch.normal.shift();
    if (!task) return;
    ch.delivering = true;
    void (async () => {
      try {
        await this.wc.fs.writeFile('/cmd.json', JSON.stringify(task.request));
        ch.lastCmdWrite = Date.now();
        const ackFile = rpcAckPath(task.request.id);
        // A cold interactive terminal can trigger Lifo's lazy kernel load in
        // the host process. That work temporarily blocks the file-poll loop,
        // so delivery must use the caller's end-to-end budget rather than an
        // unrelated five-second cap.
        const deadline = task.timeoutMs;
        for (;;) {
          try {
            const ack = JSON.parse(await this.wc.fs.readFile(ackFile, 'utf8')) as {
              protocolVersion?: number;
              id?: RpcRequestId;
              bootNonce?: string;
              instanceId?: string;
            };
            if (!this.matchesIdentity(ack, task.request)) throw new Error('invalid RPC acknowledgement');
            try { await this.wc.fs.rm(ackFile); } catch { /* best effort */ }
            task.resolve(Date.now());
            break;
          } catch {
            if (Date.now() - task.startedAt > deadline) {
              task.reject(new Error(`delivery timeout: ${task.request.cmd}`));
              break;
            }
            await sleep(15);
          }
        }
      } catch (error) {
        task.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        ch.delivering = false;
        this.pumpDeliveries();
      }
    })();
  }

  private async doExec(id: RpcRequestId, cmd: string, opts: Record<string, unknown> | undefined, timeoutMs: number, priority: boolean): Promise<ExecResult> {
    const ch = this.ch;
    const startedAt = Date.now();
    const request = this.request(id, cmd, opts);
    ch.activeResults++;
    try {
      const acceptedAt = await this.deliver(request, timeoutMs, priority);
      const resultFile = rpcResultPath(id);
      let delay = 25;
      for (;;) {
        try {
          const m = JSON.parse(await this.wc.fs.readFile(resultFile, 'utf8')) as ExecResult & {
            protocolVersion?: number;
            id?: RpcRequestId;
            bootNonce?: string;
            instanceId?: string;
          };
          if (!this.matchesIdentity(m, request)) throw new Error('stale or mismatched RPC result ignored');
          try { await this.wc.fs.rm(resultFile); } catch { /* best effort */ }
          const now = Date.now();
          return {
            ...m,
            timing: {
              queueMs: Math.max(0, acceptedAt - startedAt),
              hostMs: typeof m.timing?.hostMs === 'number' ? m.timing.hostMs : undefined,
              resultPollMs: Math.max(0, now - acceptedAt),
              totalMs: Math.max(0, now - startedAt),
            },
          };
        } catch {
          /* result not ready */
        }
        if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout: ${cmd}`);
        await sleep(delay);
        delay = Math.min(delay * 2, 150);
      }
    } finally {
      ch.activeResults--;
    }
  }

  private matchesIdentity(
    message: { protocolVersion?: number; id?: RpcRequestId; bootNonce?: string; instanceId?: string },
    request: RpcV2Envelope,
  ): boolean {
    return message.protocolVersion === RPC_PROTOCOL_VERSION &&
      message.id === request.id &&
      message.bootNonce === request.bootNonce &&
      message.instanceId === (request.instanceId ?? DEFAULT_INSTANCE_ID);
  }

  // 看门狗直接探活（r4 B）：绕过互斥队列——长命令（node 子进程等待 30-150s 期间
  // 队列被占）排队时也能及时确认 host 存活，不再延迟数分钟。
  // 安全前提：不覆盖 host 可能还没读取的在途 /cmd.json；不与被吞结果的 ping 浪费时间。
  // 返回：true=host 存活（pong）；false=超时（host 无响应）；null=通道忙，本轮跳过（中性）。
  async pingDirect(timeoutMs = 30000): Promise<boolean | null> {
    const ch = this.ch;
    if (ch.delivering || ch.normal.length > 0) return null;
    const id = `${ch.requestPrefix}-${++ch.sequence}`;
    try {
      return (await this.doExec(id, 'ping', undefined, timeoutMs, true)).kind === 'pong';
    } catch { return false; }
  }

  // P5-15：中断当前在途命令（浏览器 Ctrl+C）。必须绕过互斥队列 —— 当前命令占着队列，
  // 排队的中断要等它 settle 才有用（那正是要避免的）。直接写 /cmd.json 让 host 轮询读到
  // （node run 是 fire-and-forget，host 轮询循环此时空闲，能立刻处理 interrupt）。
  // 复用 pingDirect 的通道安全判定：不覆盖 host 可能还没读的在途 cmd.json（margin），
  // 队列有未开始请求时跳过（中断会被吞）。
  // 返回：ExecResult（pid 为数字 = 已向该进程发 kill；pid 为 null = 无当前 run 可中断）；
  // null = 通道忙 / 无法发送（浏览器侧如实提示，不假装成功）。
  async interruptDirect(timeoutMs = 2000): Promise<ExecResult | null> {
    const ch = this.ch;
    if (ch.delivering || ch.normal.length > 0) return null;
    const id = `${ch.requestPrefix}-${++ch.sequence}`;
    try { return await this.doExec(id, 'interrupt', undefined, timeoutMs, true); }
    catch { return null; }
  }
}
