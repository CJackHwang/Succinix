// 浏览器侧命令拦截：以下命令在浏览器处理，不进容器。
//   help / clear / sysinfo / ports / db start|status|stop / version / whoami
// 其余命令返回 false，由调用方原样发 host（TerminalExecutor 路由）。
import type { Terminal } from '@xterm/xterm';
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from './terminal-client.js';
import { detectSystemInfo } from './boot.js';

export interface CommandContext {
  wc: WebContainer;
  client: TerminalClient;
  /** 端口注册表：port → 预览 URL */
  ports: Map<number, string>;
  term: Terminal;
}

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const VERSION = 'WebUnix 0.1.0 (browser-native Linux)';
const DB_PORT = 3001;
const DB_PKG = 'tinbase';

function printHelp(term: Terminal): void {
  term.writeln('WebUnix 内置命令');
  term.writeln(`  help        显示本帮助`);
  term.writeln(`  clear       清屏（Ctrl+L 同样可以）`);
  term.writeln(`  sysinfo     重新显示系统信息`);
  term.writeln(`  ports       列出已就绪的服务端口`);
  term.writeln(`  db start    启动 tinbase 数据库（缺依赖时浏览器内自动安装）`);
  term.writeln(`  db status   查看 tinbase 状态`);
  term.writeln(`  db stop     停止 tinbase`);
  term.writeln(`  version     显示版本`);
  term.writeln(`  whoami      显示当前用户`);
  term.writeln('');
  term.writeln('host 端（TerminalExecutor 统一路由）');
  term.writeln(`  node|npm|npx ...   真 Node 子进程（后台长驻可用 spawn）`);
  term.writeln(`  其余命令            Lifo sandbox：grep / cat / wc / echo / curl …`);
  term.writeln(`  ps / kill <pid>     进程表管理`);
  term.writeln(`  cwd / ping / exit   协议命令`);
}

function printPorts(term: Terminal, ports: Map<number, string>): void {
  if (ports.size === 0) {
    term.writeln('（暂无已就绪的服务端口）');
    return;
  }
  term.writeln('端口   URL');
  for (const [port, url] of ports) {
    term.writeln(`${port}   ${url}`);
  }
}

// 在进程表里找匹配 cmd 且正在运行的进程。
async function findRunningProc(ctx: CommandContext, needle: string): Promise<Record<string, unknown> | undefined> {
  const ps = await ctx.client.terminal('ps');
  const procs = Array.isArray(ps.processes) ? ps.processes : [];
  return procs.find((p) => String(p.cmd ?? '').includes(needle) && p.status === 'running');
}

// db start：容器内按需安装 tinbase，然后 spawn 后台启动，等待端口就绪。
async function dbStart(ctx: CommandContext): Promise<void> {
  const { client, term } = ctx;
  term.writeln('正在检查容器内是否已安装 tinbase…');

  // 1. 检查 node_modules/tinbase 是否存在
  let installed = false;
  try {
    const r = await client.terminal('ls node_modules/tinbase', undefined, 15000);
    installed = r.ok && String(r.stdout ?? '').includes('tinbase');
  } catch {
    installed = false;
  }

  if (!installed) {
    term.writeln('未安装 → npm install tinbase --no-audit --no-fund（真 Node 路由，可能需要 30–90 秒）…');
    try {
      const r = await client.terminal('npm install tinbase --no-audit --no-fund', { timeout: 120000 }, 150000);
      if (!r.ok) {
        const why = r.stderr || r.stdout || r.error || 'npm install 非零退出';
        term.writeln(`${RED}安装失败：${String(why).slice(0, 300)}${RESET}`);
        term.writeln(`${RED}tinbase 需要 PGlite/WASM 模式，安装或启动失败：${String(why).slice(0, 120)}${RESET}`);
        return;
      }
    } catch (e) {
      term.writeln(`${RED}安装失败：${String(e)}${RESET}`);
      term.writeln(`${RED}tinbase 需要 PGlite/WASM 模式，安装或启动失败：请检查容器网络。${RESET}`);
      return;
    }
    term.writeln('✅ tinbase 安装完成');
  }

  // 2. 已在运行则直接报告
  if (ctx.ports.has(DB_PORT)) {
    term.writeln(`tinbase 已在运行：${ctx.ports.get(DB_PORT)}`);
    return;
  }

  // 3. spawn 后台启动（端口选 3001，避免常见冲突）
  //    --engine wasm: WebContainer 无原生二进制，必须 PGlite/WASM 引擎；--memory: 不落盘，POC 够用
  term.writeln('正在启动 npx tinbase start --port 3001 --engine wasm --memory（后台进程）…');
  let pid: number | undefined;
  try {
    const r = await client.spawn('npx tinbase start --port 3001 --engine wasm --memory', undefined, 8000);
    if (!r.ok || !r.pid) {
      term.writeln(`${RED}启动失败：${r.error || r.stderr || 'spawn 返回失败'}${RESET}`);
      term.writeln(`${RED}tinbase 需要 PGlite/WASM 模式，安装或启动失败：请检查容器兼容性。${RESET}`);
      return;
    }
    pid = r.pid;
    term.writeln(`已后台启动（pid=${pid}），等待 3001 端口就绪…`);
  } catch (e) {
    term.writeln(`${RED}启动失败：${String(e)}${RESET}`);
    term.writeln(`${RED}tinbase 需要 PGlite/WASM 模式，安装或启动失败：请检查容器网络/兼容性。${RESET}`);
    return;
  }

  // 4. 等待 server-ready 事件（boot.ts 的处理器会打印绿色 [preview] 行）
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const url = ctx.ports.get(DB_PORT);
    if (url) {
      term.writeln(`${GREEN}数据库已就绪：${url}${RESET}`);
      term.writeln('访问提示：在浏览器打开 ' + url + '，或 `curl ' + url + '` 走 Lifo。');
      return;
    }
    await sleep(500);
  }
  term.writeln(`${RED}等待超时：3001 端口 30 秒内未就绪。${RESET}`);
  term.writeln(
    `${RED}tinbase 需要 PGlite/WASM 模式，启动失败：可能在 WebContainer 内跑不起来（WASM/网络问题）。` +
      `请 db stop 后重试，或改用外部服务。${RESET}`
  );
}

async function dbStatus(ctx: CommandContext): Promise<void> {
  const { client, ports, term } = ctx;
  const url = ports.get(DB_PORT);
  term.writeln(url ? `端口 3001：在就绪列表 → ${url}` : '端口 3001：不在就绪列表（未运行）');

  let procs: Array<Record<string, unknown>> = [];
  try {
    const ps = await client.terminal('ps');
    procs = Array.isArray(ps.processes) ? ps.processes : [];
  } catch (e) {
    term.writeln(`${RED}查询进程表失败：${String(e)}${RESET}`);
    return;
  }
  const tinbase = procs.filter((p) => String(p.cmd ?? '').includes(DB_PKG));
  if (tinbase.length === 0) {
    term.writeln('进程表：没有 tinbase 进程');
  } else {
    for (const p of tinbase) {
      term.writeln(`进程表：pid=${p.pid} "${p.cmd}" [${p.status}]`);
    }
  }
}

async function dbStop(ctx: CommandContext): Promise<void> {
  const { term } = ctx;
  let proc: Record<string, unknown> | undefined;
  try {
    proc = await findRunningProc(ctx, DB_PKG);
  } catch (e) {
    term.writeln(`${RED}查询进程表失败：${String(e)}${RESET}`);
    return;
  }
  if (!proc) {
    term.writeln('没有正在运行的 tinbase 进程');
    return;
  }
  const pid = Number(proc.pid);
  const k = await ctx.client.terminal(`kill ${pid}`);
  if (k.ok && k.killed) {
    term.writeln(`已停止 tinbase（pid=${pid}）`);
    ctx.ports.delete(DB_PORT);
  } else {
    term.writeln(`${RED}停止失败：${k.message ?? '未知原因'}${RESET}`);
  }
}

// 尝试在浏览器侧处理命令；返回 true 表示已处理，false 表示应发 host。
export async function tryHandleLocalCommand(ctx: CommandContext, input: string): Promise<boolean> {
  const { term } = ctx;
  const trimmed = input.trim();
  const [word, ...rest] = trimmed.split(/\s+/);

  switch (word) {
    case 'help':
      printHelp(term);
      return true;
    case 'clear':
      term.clear();
      return true;
    case 'sysinfo':
      for (const line of detectSystemInfo()) term.writeln(line);
      return true;
    case 'ports':
      printPorts(term, ctx.ports);
      return true;
    case 'version':
      term.writeln(VERSION);
      return true;
    case 'whoami':
      term.writeln('guest');
      return true;
    case 'db': {
      const sub = rest[0] ?? '';
      if (sub === 'start') await dbStart(ctx);
      else if (sub === 'status') await dbStatus(ctx);
      else if (sub === 'stop') await dbStop(ctx);
      else term.writeln('用法：db start | db status | db stop');
      return true;
    }
    default:
      return false;
  }
}
