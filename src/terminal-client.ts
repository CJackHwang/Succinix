// TerminalExecutor 客户端：浏览器侧单一入口，内部走文件型 RPC。
// 通道与 host 保持一致：/cmd.json {id,cmd,opts} → /result-<id>.json（每请求独立结果文件）。
import type { WebContainer } from '@webcontainer/api';
import { log } from './log.js';

// host 响应统一形状；具体字段依 cmd 而定（run/ps/kill/spawn/cwd/ping/exit）。
export interface ExecResult {
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  runtime?: 'node' | 'lifo';
  kind?: string;
  cwd?: string;
  pid?: number;
  processes?: Array<Record<string, unknown>>;
  killed?: boolean;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 只读/幂等协议命令：RPC 传输失败时允许重试 1 次（TASK16 稳定性）。
// ping/ps/cwd 重发安全；kill / run / spawn 等非幂等命令一律不重试。
const READONLY_PROTO = new Set(['ping', 'ps', 'cwd']);

export class TerminalClient {
  private id = 0;
  // 请求互斥队列（TASK16）：/cmd.json 是单槽通道，host 一次只处理一个请求，
  // 并行调用会让后写覆盖先写的 cmd.json、先发请求等不到结果。所有 exec 串行化
  // —— host 本就串行处理，浏览器侧排队不损失吞吐，只让失败变得确定。
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private wc: WebContainer) {}

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
        res = await this.exec('run', { command, ...opts }, timeoutMs);
      }
    }
    // TASK12：命令执行采集点（INFO）——cmd/exit/runtime。协议命令无 runtime 字段，标 protocol。
    // TASK16 R2 降噪：纯轮询 ps（top/service 内部高频调用）跳过命令日志，避免刷屏；kill 保留。
    if (trimmed !== 'ps') {
      void log('INFO', `cmd: ${command} exit=${res.exitCode ?? (res.ok ? 0 : 1)} runtime=${res.runtime ?? 'protocol'}`);
    }
    return res;
  }

  // spawn：后台长驻进程（仅 node 系）。host 立即返回 { ok, pid }，输出持续收集进进程表。
  async spawn(command: string, opts?: Record<string, unknown>, timeoutMs = 5000): Promise<ExecResult> {
    const res = await this.exec('spawn', { command, ...opts }, timeoutMs);
    // TASK12：spawn 后台进程同样记录（host 返回 runtime: 'node'，缺失时按 node 处理）。
    void log('INFO', `cmd: ${command} exit=${res.exitCode ?? (res.ok ? 0 : 1)} runtime=${res.runtime ?? 'node'}`);
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
    const run = this.chain.then(() => this.doExec(++this.id, cmd, opts, timeoutMs));
    this.chain = run.catch(() => {
      /* 链不中断：单个请求失败不影响后续排队 */
    });
    return run;
  }

  // 单次 RPC：写 /cmd.json，轮询 /result-<id>.json，读到即删。
  private async doExec(id: number, cmd: string, opts: Record<string, unknown> | undefined, timeoutMs: number): Promise<ExecResult> {
    await this.wc.fs.writeFile('/cmd.json', JSON.stringify({ id, cmd, opts }));
    const resultFile = `/result-${id}.json`;
    const start = Date.now();
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
      await sleep(150);
    }
  }
}
