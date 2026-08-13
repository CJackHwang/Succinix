// 终端交互核心（无 UI，纯逻辑可单测）：SuccinixTerminalSession。
// 从 main.ts 的 REPL 状态机提取：历史 / Tab 补全 / 真中断 / 命令队列 / 提示符 cwd 跟随 /
// boot 门禁。不依赖 xterm / DOM / log —— 输出走注入的 TerminalOutput，命令日志经
// onCommand 采集（应用层决定落盘），host 通信走注入的 TerminalRpc（createTerminalExecutor
// 实例天然满足）。本模块属于终端 SDK 层：可被任何宿主（独立应用 / SunamAI）复用。
import { sessionCwdPromptLabel, sessionCwdToBrowserPath } from '../engine/host-route.js';
import type { ExecResult } from '../engine/client.js';
import type { CommandLogEntry } from '../engine/client.js';

// ─── RPC 依赖面（窄接口；可选方法安全降级）───
export interface DirEntry {
  name: string;
  isDirectory(): boolean;
}

export interface TerminalRpc {
  /** 执行一条命令（统一路由；协议命令直接命中）。实现来源：createTerminalExecutor().exec */
  exec(cmd: string, opts?: Record<string, unknown>, timeoutMs?: number): Promise<ExecResult>;
  /** 后台长驻进程（可选；宿主有 spawn 语义时注入） */
  spawn?(command: string, opts?: Record<string, unknown>, timeoutMs?: number): Promise<ExecResult>;
  /** 进程表快照（可选；宿主有进程表时注入） */
  listProcesses?(): Promise<unknown[]>;
  /** 终止真实子进程（可选） */
  kill?(pid: number): Promise<boolean>;
  /** host 存活探测 */
  ping(): Promise<boolean>;
  /** 看门狗直接探活（可选）：绕过互斥队列 */
  pingDirect?(timeoutMs?: number): Promise<boolean | null>;
  /** Ctrl+C 真中断（可选；缺失时降级为仅清队列） */
  interruptDirect?(timeoutMs?: number): Promise<ExecResult | null>;
  /** 目录列表（可选；缺失时 Tab 补全降级为仅命令名）。dir 为浏览器视角绝对路径 */
  readdir?(dir: string): Promise<DirEntry[]>;
}

// 输出契约：SDK 只定义 write/clear；xterm 适配器在应用层写薄适配（≤10 行）。
export interface TerminalOutput {
  write(data: string): void;
  clear(): void;
}

export interface LocalCommandCtx {
  output: TerminalOutput;
  cwd: string;
  session: SuccinixTerminalSession;
}

export type LocalCommandHandler = (ctx: LocalCommandCtx, args: string[]) => Promise<string | void> | string | void;

export interface TerminalSessionOptions {
  /** 初始 cwd（缺省 /workspace） */
  cwd?: string;
  /** 命令超时（缺省 60000） */
  timeoutMs?: number;
  /** boot 前静默忽略输入（缺省 true） */
  bootGate?: boolean;
  /** 本地命令表：命令名 → 处理器；未命中原样走 RPC */
  localHandlers?: Record<string, LocalCommandHandler>;
  /** 命令历史（缺省 true） */
  history?: boolean;
  /** Tab 补全（缺省 true） */
  tabComplete?: boolean;
  /** Ctrl+C 真中断（缺省 true，无 interruptDirect 降级） */
  interrupt?: boolean;
  /** 提示符前缀（缺省 'guest@succinix:'） */
  promptPrefix?: string;
  /** 用户 home（Lifo 视图，缺省 /workspace = guest 现状）：cwd === home → 提示符 `~`，
   *  home 下 → `~/...`。多用户模式由宿主注入（createSuccinixInstance 的 home 选项派生） */
  home?: string;
  /** 命令日志采集（对齐 engine onCommand；缺省不写日志，由应用层注入落盘） */
  onCommand?: (entry: CommandLogEntry) => void;
  /** RPC 前挂钩（应用层预注入，如 python 资产懒加载）；抛错则命令中止并如实显示 */
  beforeRpc?: (command: string) => Promise<void>;
  /** RPC 失败 / 本地命令异常回调（应用层决定 ERROR 日志落盘） */
  onCommandError?: (command: string, error: string, phase: 'local' | 'pre' | 'rpc') => void;
  /** 首提示符 / 每次重绘提示符回调（bench 模式记录首提示符时间戳用） */
  onPrompt?: () => void;
  /** 呈现着色（缺省无色，纯文本；应用层注入主题色） */
  colors?: { red(s: string): string; gray(s: string): string; amber(s: string): string };
}

// ─── 会话核心 ───
export class SuccinixTerminalSession {
  /** 只读访问面（scenarioRun / 宿主复用） */
  readonly rpc: TerminalRpc;
  /** 只读访问面：本地命令表（含内置） */
  readonly localHandlers: Readonly<Record<string, LocalCommandHandler>>;

  private output: TerminalOutput;
  private options: Required<Pick<TerminalSessionOptions, 'timeoutMs' | 'bootGate' | 'history' | 'tabComplete' | 'interrupt' | 'promptPrefix'>> &
    TerminalSessionOptions;
  private cwd: string;
  private line = '';
  private busy = false;
  private queue: string[] = [];
  private history: string[] = [];
  private historyIdx = -1;
  private booted = false;
  private disposed = false;

  constructor(rpc: TerminalRpc, output: TerminalOutput, options: TerminalSessionOptions = {}) {
    this.rpc = rpc;
    this.output = output;
    // 调用方显式传 undefined 时不能覆盖默认前缀（独立宿主 / 第三方集成常见）。
    const mergedOptions = { ...options, promptPrefix: options.promptPrefix ?? 'guest@succinix:' };
    this.options = {
      cwd: '/workspace',
      timeoutMs: 60000,
      bootGate: true,
      history: true,
      tabComplete: true,
      interrupt: true,
      ...mergedOptions,
    };
    this.cwd = options.cwd ?? '/workspace';
    this.localHandlers = Object.freeze({
      help: (ctx) => {
        const names = Object.keys(this.localHandlers).sort().join(' ');
        ctx.output.write(`Succinix built-in commands: ${names}\r\n`);
      },
      clear: (ctx) => {
        ctx.output.clear();
      },
      pwd: (ctx) => {
        ctx.output.write(`${ctx.cwd}\r\n`);
      },
      echo: (_ctx, args) => {
        // echo 语义：原样回显参数（Lifo 的 echo 不带引号处理，这里与 Lifo 对齐）。
        return args.join(' ');
      },
      ...options.localHandlers,
    });
  }

  // boot 完成：解锁门禁 + 首提示符。
  async boot(): Promise<void> {
    this.booted = true;
    this.prompt();
  }

  // 丢弃队列、抑制后续输出（宿主卸载 / 实例 dispose 用）。幂等。
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  getPrompt(): string {
    return `${this.options.promptPrefix}${sessionCwdPromptLabel(this.cwd, this.options.home)}$ `;
  }

  getCwd(): string {
    return this.cwd;
  }

  /** 显式设置会话 cwd（boot 后从 host 取一次真实值 / 实例工厂注入初始 cwd 用） */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  // 重绘提示符（清行 + 新提示符 + 当前输入）。公开供宿主在外部状态变化后调用。
  prompt(): void {
    if (this.disposed) return;
    this.output.write('\r\n' + this.getPrompt());
    this.line = '';
    this.options.onPrompt?.();
  }

  // 浏览器侧输入处理：回车执行、Ctrl+L 清屏、Ctrl+C 中断、支持粘贴。
  handleData(data: string): void {
    if (this.disposed) return;
    // R1：boot 门禁 —— boot 完成前静默忽略一切输入。
    if (this.options.bootGate && !this.booted) return;
    // 完整转义序列：xterm 把箭头/Tab 作为单条 data 交付（onData 合并字节）。
    if (data === '\x1b[A') {
      this.historyNavigate(-1);
      return;
    }
    if (data === '\x1b[B') {
      this.historyNavigate(1);
      return;
    }
    if (data === '\t' || data === '\x1b[Z') {
      if (this.options.tabComplete) void this.handleTab();
      return;
    }
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\x1b') {
        // 残缺/未知转义序列（顶部已处理完整箭头/Tab）：丢弃整段，避免把 '[' / 字母回显成乱码。
        i = data.length;
        continue;
      }
      if (ch === '\r') {
        this.output.write('\r\n');
        const cmd = this.line;
        this.line = '';
        const trimmed = cmd.trim();
        if (this.options.history && trimmed) {
          this.history.push(cmd);
          this.historyIdx = this.history.length;
        }
        if (this.busy) {
          if (trimmed) {
            this.queue.push(trimmed);
            this.output.write(`${this.gray('queued: will run after the current command finishes')}\r\n`);
          }
          return;
        }
        if (!trimmed) {
          // 空命令：只换到下一行提示符，不发 host（否则 host 会回一个 "empty command" 错误）。
          this.output.write(this.getPrompt());
          return;
        }
        void this.runCommand(cmd);
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.output.write('\b \b');
        }
        continue;
      }
      if (ch === '\u0003') {
        if (this.busy) {
          this.output.write('^C\r\n');
          void this.interruptCommand();
        } else {
          this.output.write('^C\r\n');
          this.prompt();
        }
        continue;
      }
      if (ch === '\u000c') {
        this.output.clear();
        this.output.write(this.getPrompt() + this.line);
        continue;
      }
      // 单个 Tab 已在循环前整体处理（补全）。粘贴内容里的嵌入式 tab（0x09 < ' '）由下方
      // `ch >= ' '` 守卫一并丢弃，不进入命令行 —— 无需单独分支。
      if (ch >= ' ') {
        this.line += ch;
        this.output.write(ch);
      }
    }
  }

  // 上下箭头浏览命令历史。方向 dir：-1=上（旧），+1=下（新）。
  private historyNavigate(dir: -1 | 1): void {
    if (!this.options.history || this.history.length === 0) return;
    const next = this.historyIdx + dir;
    if (next < 0 || next > this.history.length) return; // 越界忽略
    this.historyIdx = next;
    const entry = this.historyIdx < this.history.length ? this.history[this.historyIdx] ?? '' : '';
    this.output.write(`\r${this.getPrompt()}${' '.repeat(this.line.length)}\r${this.getPrompt()}`);
    this.line = entry;
    this.output.write(entry);
  }

  // 公共前缀（Tab 补全多候选合并用）。
  private commonPrefix(xs: string[]): string {
    if (xs.length === 0) return '';
    let p = xs[0];
    for (const x of xs.slice(1)) {
      while (!x.startsWith(p)) p = p.slice(0, -1);
    }
    return p;
  }

  // Tab 补全：首 token 补命令名；含 / 的 token 按目录 readdir 补文件路径；
  // 无 / 的 token 按**会话 cwd**（映射到浏览器可读路径）补当前目录条目。
  // 无 readdir RPC 时降级为仅命令名（应用层可增强）。唯一命中直接补全，多命中列出 + 共同前缀。
  private async handleTab(): Promise<void> {
    if (!this.rpc.readdir) {
      this.completeCommandsOnly();
      return;
    }
    const tokens = this.line.split(/\s+/);
    const token = tokens[tokens.length - 1] ?? '';
    const candidates = new Set<string>();
    if (tokens.length === 1) {
      for (const c of Object.keys(this.localHandlers)) candidates.add(c);
    }
    try {
      const hasSlash = token.includes('/');
      // 无斜杠 token 按会话 cwd 补全（cd /workspace/proj 之后 cat fi<Tab> 补当前目录，
      // 而非根目录）。会话 cwd 是 Lifo 视图，映射到浏览器可读路径后交给宿主 readdir。
      const dir = hasSlash ? token.slice(0, token.lastIndexOf('/') + 1) || '/' : sessionCwdToBrowserPath(this.cwd);
      const entries = await this.rpc.readdir(dir);
      for (const e of entries) {
        const name = String(e.name);
        const isDir = typeof e.isDirectory === 'function' && e.isDirectory();
        // 无斜杠 token：候选是「当前目录下的条目名」（相对），补全后命令在会话 cwd 里执行；
        // 含 / 的 token：候选是 dir + 名称（绝对路径）。
        candidates.add((hasSlash ? dir : '') + name + (isDir ? '/' : ''));
      }
    } catch {
      /* 目录不可读：只保留命令名候选 */
    }
    this.applyCompletion(token, [...candidates]);
  }

  private completeCommandsOnly(): void {
    const tokens = this.line.split(/\s+/);
    const token = tokens[tokens.length - 1] ?? '';
    if (tokens.length !== 1) return;
    this.applyCompletion(token, Object.keys(this.localHandlers));
  }

  private applyCompletion(token: string, candidates: string[]): void {
    const matches = candidates.filter((c) => c.startsWith(token)).sort();
    if (matches.length === 0) return;
    if (matches.length === 1) {
      const add = matches[0]!.slice(token.length);
      this.line += add;
      this.output.write(add);
      return;
    }
    const common = this.commonPrefix(matches);
    if (common.length > token.length) {
      const add = common.slice(token.length);
      this.line += add;
      this.output.write(add);
      return;
    }
    // 多候选且无共同前缀：列出候选并重绘提示符。
    this.output.write(`\r\n${matches.join('  ')}\r\n${this.getPrompt()}${this.line}`);
  }

  // busy 时 Ctrl+C —— 向 host 发 interrupt（杀掉当前 node run 子进程）并清空队列。
  // 清空先做：之后 runCommand 的 finally 从空队列 shift 不到命令 → 回到提示符。
  // 中断只对 node run 子进程生效；Lifo 沙箱无 abort API、后台 spawn 服务不被误杀（如实提示）。
  private async interruptCommand(): Promise<void> {
    const discarded = this.queue.length;
    this.queue.length = 0;
    if (discarded > 0) this.output.write(`${this.gray(`queued commands discarded (${discarded})`)}\r\n`);
    if (!this.options.interrupt || !this.rpc.interruptDirect) {
      this.output.write(`${this.gray('no interrupt channel; waiting for the current command to finish')}\r\n`);
      return;
    }
    const res = await this.rpc.interruptDirect();
    if (res && typeof res.pid === 'number') {
      this.output.write(`${this.gray(`interrupting command (pid=${res.pid})...`)}\r\n`);
    } else if (res) {
      this.output.write(`${this.gray('no running node command to interrupt; waiting for the current command to finish')}\r\n`);
    } else {
      this.output.write(`${this.gray('could not send interrupt (channel busy); waiting for the current command to finish')}\r\n`);
    }
  }

  // 执行一条命令：浏览器侧本地拦截 → 否则发 host；输出前空行分隔，stderr 红色，exit≠0 灰色标注。
  private async execute(cmd: string): Promise<void> {
    this.output.write('\r\n'); // 输出前空行分隔，可读性好
    const [word, ...args] = cmd.trim().split(/\s+/);
    const handler = word ? this.localHandlers[word] : undefined;
    if (handler) {
      try {
        const extra = await handler({ output: this.output, cwd: this.cwd, session: this }, args);
        if (typeof extra === 'string' && extra) this.output.write(extra);
        this.options.onCommand?.({ command: cmd, exit: 0, runtime: 'browser' });
      } catch (e) {
        this.output.write(`${this.red(String(e))}`);
        this.options.onCommandError?.(cmd, String(e), 'local');
      }
      return;
    }

    const rpc = await this.rpcExec(cmd, this.options.timeoutMs);
    if ('error' in rpc) {
      this.output.write(`${this.red(rpc.error)}`);
      this.options.onCommandError?.(cmd, rpc.error, rpc.phase);
      return;
    }
    const res = rpc.res;
    this.options.onCommand?.({
      command: cmd,
      exit: res.exitCode ?? (res.ok ? 0 : 1),
      runtime: res.runtime ?? 'protocol',
    });
    // 提示符跟随：成功的 cd（run 结果带 cwd 字段，Lifo 视图）同步浏览器缓存，
    // 下一次 prompt() 即显示新目录（如 guest@succinix:~/proj$）。仅 exitCode===0 的 cd 带 cwd。
    if (typeof res.cwd === 'string') this.cwd = res.cwd;

    // 协议命令响应直接呈现
    if (Array.isArray(res.processes) || typeof res.pid === 'number' || res.cwd || res.message || res.kind) {
      this.printProtocolResponse(res);
      return;
    }

    const stdout = String(res.stdout ?? '');
    const stderr = String(res.stderr ?? '');
    if (stdout) this.output.write(stdout);
    if (stderr) {
      if (stdout && !stdout.endsWith('\n')) this.output.write('\r\n');
      this.output.write(`${this.red(stderr)}`);
    }
    const code = res.exitCode;
    if (res.ok === false && typeof code === 'number' && code !== 0) {
      if ((stdout || stderr) && !(stderr || '').endsWith('\n')) this.output.write('\r\n');
      this.output.write(`${this.gray(`[exit ${code}]`)}`);
    }
    // TASK3 修复：stdout/stderr 均空但 error 存在时显示 error，杜绝静默失败
    // （如 host 的 { ok:false, error } 协议响应、spawn 的非 node 拒绝、unknown command 等）。
    if (res.ok === false && !stdout && !stderr && res.error) {
      this.output.write(`${this.red(String(res.error))}`);
    }
  }

  // RPC 前置挂钩 + 执行（应用层可注入 python 资产懒加载等）。
  async rpcExec(command: string, timeoutMs: number): Promise<{ res: ExecResult } | { error: string; phase: 'pre' | 'rpc' }> {
    try {
      await this.options.beforeRpc?.(command);
    } catch (e) {
      return { error: String(e), phase: 'pre' };
    }
    try {
      return { res: await this.rpc.exec(command, undefined, timeoutMs) };
    } catch (e) {
      return { error: String(e), phase: 'rpc' };
    }
  }

  // 本地命令分发到指定 output（scenario/bench 捕获式调用复用；未命中返回 false）。
  async dispatchLocal(command: string, args: string[], output: TerminalOutput): Promise<boolean> {
    const handler = this.localHandlers[command];
    if (!handler) return false;
    const extra = await handler({ output, cwd: this.cwd, session: this }, args);
    if (typeof extra === 'string' && extra) output.write(extra);
    return true;
  }

  // 协议命令（ps/cwd/kill/spawn...）没有 stdout，直接呈现字段。
  private printProtocolResponse(res: ExecResult): void {
    if (Array.isArray(res.processes)) {
      this.output.write('PID  STATUS  COMMAND\r\n');
      for (const p of res.processes) {
        const row = p as { pid: number; status: string; cmd: string; outputTail?: string };
        const status = row.status === 'running' ? this.amber('running') : this.gray('exited');
        this.output.write(`${String(row.pid).padEnd(6)}  ${status}  ${row.cmd ?? ''}\r\n`);
        if (row.outputTail) {
          this.output.write(`         ${this.gray(`output tail: ${row.outputTail.slice(-120)}`)}\r\n`);
        }
      }
      return;
    }
    if (typeof res.pid === 'number') {
      this.output.write(`started in background (pid=${res.pid}, runtime=${res.runtime ?? '?'})\r\n`);
      return;
    }
    if (res.cwd) {
      this.output.write(`${String(res.cwd)}\r\n`);
      return;
    }
    if (res.message) {
      this.output.write(`${String(res.message)}\r\n`);
      return;
    }
    if (res.kind === 'bye') this.output.write('bye\r\n');
  }

  // 命令执行主循环：busy 期间排队，settle 出队，空则回到提示符。
  private async runCommand(cmd: string): Promise<void> {
    this.busy = true;
    try {
      await this.execute(cmd);
    } finally {
      this.busy = false;
      const next = this.queue.shift();
      if (next) {
        void this.runCommand(next);
      } else {
        this.prompt();
      }
    }
  }

  private red(s: string): string {
    return this.options.colors?.red(s) ?? s;
  }

  private gray(s: string): string {
    return this.options.colors?.gray(s) ?? s;
  }

  private amber(s: string): string {
    return this.options.colors?.amber(s) ?? s;
  }
}
