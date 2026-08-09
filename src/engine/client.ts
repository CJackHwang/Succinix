// TerminalExecutor 客户端：浏览器侧单一入口，内部走文件型 RPC。
// 通道与 host 保持一致：/cmd.json {id,cmd,opts} → /result-<id>.json（每请求独立结果文件）。
import type { WebContainer } from '@webcontainer/api';
import { sleep } from './sleep.js';

// host 响应统一形状；具体字段依 cmd 而定（run/ps/kill/spawn/cwd/ping/exit）。
export interface ExecResult {
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  runtime?: 'node' | 'lifo' | 'browser';
  kind?: string;
  cwd?: string;
  pid?: number;
  processes?: Array<Record<string, unknown>>;
  killed?: boolean;
  message?: string;
  error?: string;
  /** 引擎 exec 超时时置 true（原始 RPC 超时抛异常，引擎层捕获转结果） */
  timedOut?: boolean;
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
}

// 只读/幂等协议命令：RPC 传输失败时允许重试 1 次（TASK16 稳定性）。
// ping/ps/cwd 重发安全；kill / run / spawn 等非幂等命令一律不重试。
const READONLY_PROTO = new Set(['ping', 'ps', 'cwd']);

// host 轮询 /cmd.json 的间隔（host.ts setInterval 50ms）。看门狗直接探活要保证
// 覆盖的不是 host"尚未读取"的在途请求：距上次写 /cmd.json 超过该余量才允许覆盖。
const HOST_POLL_MARGIN_MS = 250;

export class TerminalClient {
  private id = 0;
  private options: TerminalClientOptions;
  // 请求互斥队列（TASK16）：/cmd.json 是单槽通道，host 一次只处理一个请求，
  // 并行调用会让后写覆盖先写的 cmd.json、先发请求等不到结果。所有 exec 串行化
  // —— host 本就串行处理，浏览器侧排队不损失吞吐，只让失败变得确定。
  private chain: Promise<unknown> = Promise.resolve();
  /** 已入队未完成请求数（含在途）——看门狗直接探活判断通道是否可能被下一拍覆盖 */
  private pending = 0;
  /** 在途 doExec 数（已开始轮询结果，cmd.json 已写入） */
  private active = 0;
  /** 最近一次写 /cmd.json 的时间戳（看门狗覆盖安全窗口判断） */
  private lastCmdWrite = 0;

  constructor(
    private wc: WebContainer,
    options: TerminalClientOptions = {}
  ) {
    this.options = options;
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
        res = await this.exec('kill', { pid: Number(killMatch[1]) }, timeoutMs);
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

  // 排队执行：同一时刻只有一个在途请求（前一个完成或超时才轮到下一个）。
  private enqueue(cmd: string, opts: Record<string, unknown> | undefined, timeoutMs: number): Promise<ExecResult> {
    this.pending++;
    const run = this.chain.then(() => this.doExec(++this.id, cmd, opts, timeoutMs));
    // 请求 settle（成功或失败）后释放 pending 计数；链不中断（单个请求失败不影响后续排队）。
    this.chain = run.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      }
    );
    return run;
  }

  // 单次 RPC：写 /cmd.json，轮询 /result-<id>.json，读到即删。
  // TASK21：请求带 protocol 版本字段（向后兼容 —— host 忽略缺失/未知字段，按 v1 处理）。
  private async doExec(id: number, cmd: string, opts: Record<string, unknown> | undefined, timeoutMs: number): Promise<ExecResult> {
    this.active++;
    try {
      await this.wc.fs.writeFile('/cmd.json', JSON.stringify({ protocol: 1, id, cmd, opts }));
      this.lastCmdWrite = Date.now();
      const resultFile = `/result-${id}.json`;
      const start = Date.now();
      // TASK18 自适应轮询：快命令（echo / ls / ps）密集轮询尽快拿到结果（往返减半）；
      // 长命令（npm install / curl）指数退避到 150ms 上限，避免对结果文件做无谓的 FS 读。
      let delay = 25;
      for (;;) {
        try {
          const raw = await this.wc.fs.readFile(resultFile, 'utf8');
          const m = JSON.parse(raw) as ExecResult;
          // 读到即删：每个请求独立结果文件，避免与迟到的异步写入互相覆盖
          try {
            await this.wc.fs.rm(resultFile);
          } catch {
            /* 清理失败不影响 */
          }
          return m;
        } catch {
          /* 结果未就绪 */
        }
        if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${cmd}`);
        await sleep(delay);
        delay = Math.min(delay * 2, 150);
      }
    } finally {
      this.active--;
    }
  }

  // 看门狗直接探活（r4 B）：绕过互斥队列——长命令（node 子进程等待 30-150s 期间
  // 队列被占）排队时也能及时确认 host 存活，不再延迟数分钟。
  // 安全前提：不覆盖 host 可能还没读取的在途 /cmd.json；不与被吞结果的 ping 浪费时间。
  // 返回：true=host 存活（pong）；false=超时（host 无响应）；null=通道忙，本轮跳过（中性）。
  async pingDirect(timeoutMs = 30000): Promise<boolean | null> {
    // 队列里还有未开始的请求：下一拍 doExec 会写 /cmd.json 覆盖本 ping → 必然被吞，跳过。
    if (this.pending > this.active) return null;
    // 刚写过 /cmd.json（host 轮询周期内可能还没读取）：覆盖会吞掉在途请求 → 跳过。
    if (Date.now() - this.lastCmdWrite < HOST_POLL_MARGIN_MS) return null;
    const id = ++this.id;
    try {
      await this.wc.fs.writeFile('/cmd.json', JSON.stringify({ protocol: 1, id, cmd: 'ping' }));
    } catch {
      return false; // FS 不可写：按 host 不可达处理
    }
    const resultFile = `/result-${id}.json`;
    const start = Date.now();
    for (;;) {
      try {
        const raw = await this.wc.fs.readFile(resultFile, 'utf8');
        const m = JSON.parse(raw) as ExecResult;
        try {
          await this.wc.fs.rm(resultFile);
        } catch {
          /* 清理失败不影响 */
        }
        return m.kind === 'pong';
      } catch {
        /* 结果未就绪 */
      }
      if (Date.now() - start > timeoutMs) return false;
      await sleep(100); // TASK18：看门狗探活轮询 150→100ms（非热路径，100ms 已足够）
    }
  }

  // P5-15：中断当前在途命令（浏览器 Ctrl+C）。必须绕过互斥队列 —— 当前命令占着队列，
  // 排队的中断要等它 settle 才有用（那正是要避免的）。直接写 /cmd.json 让 host 轮询读到
  // （node run 是 fire-and-forget，host 轮询循环此时空闲，能立刻处理 interrupt）。
  // 复用 pingDirect 的通道安全判定：不覆盖 host 可能还没读的在途 cmd.json（margin），
  // 队列有未开始请求时跳过（中断会被吞）。
  // 返回：ExecResult（pid 为数字 = 已向该进程发 kill；pid 为 null = 无当前 run 可中断）；
  // null = 通道忙 / 无法发送（浏览器侧如实提示，不假装成功）。
  async interruptDirect(timeoutMs = 2000): Promise<ExecResult | null> {
    if (this.pending > this.active) return null;
    if (Date.now() - this.lastCmdWrite < HOST_POLL_MARGIN_MS) return null;
    const id = ++this.id;
    try {
      await this.wc.fs.writeFile('/cmd.json', JSON.stringify({ protocol: 1, id, cmd: 'interrupt' }));
    } catch {
      return null; // FS 不可写：按无法发送处理
    }
    const resultFile = `/result-${id}.json`;
    const start = Date.now();
    for (;;) {
      try {
        const raw = await this.wc.fs.readFile(resultFile, 'utf8');
        const m = JSON.parse(raw) as ExecResult;
        try {
          await this.wc.fs.rm(resultFile);
        } catch {
          /* 清理失败不影响 */
        }
        return m;
      } catch {
        /* 结果未就绪 */
      }
      if (Date.now() - start > timeoutMs) return null;
      await sleep(100);
    }
  }
}
