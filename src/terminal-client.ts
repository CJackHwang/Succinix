// TerminalExecutor 客户端：浏览器侧单一入口，内部走文件型 RPC。
// 通道与 host 保持一致：/cmd.json {id,cmd,opts} → /result-<id>.json（每请求独立结果文件）。
import type { WebContainer } from '@webcontainer/api';

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

export class TerminalClient {
  private id = 0;

  constructor(private wc: WebContainer) {}

  // 统一终端入口：协议命令（ps / kill <pid> / cwd / ping / exit）直接命中；
  // 其余命令作为 run 发送，由 host 统一路由到真 Node 或 Lifo。
  async terminal(command: string, opts?: Record<string, unknown>, timeoutMs = 30000): Promise<ExecResult> {
    const trimmed = command.trim();
    if (trimmed === 'ps' || trimmed === 'cwd' || trimmed === 'ping' || trimmed === 'exit') {
      return this.exec(trimmed, undefined, timeoutMs);
    }
    const killMatch = /^kill\s+(\d+)$/.exec(trimmed);
    if (killMatch) {
      return this.exec('kill', { pid: Number(killMatch[1]) }, timeoutMs);
    }
    return this.exec('run', { command, ...opts }, timeoutMs);
  }

  // spawn：后台长驻进程（仅 node 系）。host 立即返回 { ok, pid }，输出持续收集进进程表。
  async spawn(command: string, opts?: Record<string, unknown>, timeoutMs = 5000): Promise<ExecResult> {
    return this.exec('spawn', { command, ...opts }, timeoutMs);
  }

  // 文件 RPC 核心：写 /cmd.json，轮询 /result-<id>.json，读到即删。
  async exec(cmd: string, opts?: Record<string, unknown>, timeoutMs = 30000): Promise<ExecResult> {
    const id = ++this.id;
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
