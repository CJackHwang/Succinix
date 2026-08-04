// 浏览器侧命令拦截：以下命令在浏览器处理，不进容器。
//   help / clear / sysinfo / ports / db start|status|stop / snapshot / version / whoami
// 其余命令返回 false，由调用方原样发 host（TerminalExecutor 路由）。
import type { Terminal } from '@xterm/xterm';
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from './terminal-client.js';
import { detectSystemInfo } from './boot.js';
import { saveSnapshot, clearSnapshot, getSnapshotMeta } from './persist.js';

export interface CommandContext {
  wc: WebContainer;
  client: TerminalClient;
  /** 端口注册表：port → 预览 URL */
  ports: Map<number, string>;
  term: Terminal;
}

const RED = '\x1b[31m';
const AMBER = '\x1b[33m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const VERSION = 'WebUnix 0.1.0 (browser-native Linux)';
const DB_PORT = 3001;
const DB_PKG = 'tinbase';

function printHelp(term: Terminal): void {
  term.writeln('WebUnix built-in commands');
  term.writeln(`  help         show this help`);
  term.writeln(`  clear        clear the screen (Ctrl+L also works)`);
  term.writeln(`  sysinfo      re-print system information`);
  term.writeln(`  ports        list service ports that are ready`);
  term.writeln(`  db start     start the tinbase database (auto-installs in-container when missing)`);
  term.writeln(`  db status    show tinbase status`);
  term.writeln(`  db stop      stop tinbase (data persists in workspace)`);
  term.writeln(`  snapshot     show persistent storage status`);
  term.writeln(`  snapshot now  save a snapshot immediately (auto-saves every ~2.5s)`);
  term.writeln(`  snapshot clear  clear snapshot (= reset system, next boot fresh)`);
  term.writeln(`  version      show version`);
  term.writeln(`  whoami       show current user`);
  term.writeln('');
  term.writeln('host side (TerminalExecutor unified routing)');
  term.writeln(`  node|npm|npx ...   real node subprocess (spawn for long-running background)`);
  term.writeln(`  other commands      Lifo sandbox: grep / cat / wc / echo / curl ...`);
  term.writeln(`  ps / kill <pid>    process table management`);
  term.writeln(`  cwd / ping / exit  protocol commands`);
}

function printPorts(term: Terminal, ports: Map<number, string>): void {
  if (ports.size === 0) {
    term.writeln('(no service ports ready yet)');
    return;
  }
  term.writeln('PORT  URL');
  for (const [port, url] of ports) {
    term.writeln(`${port}  ${url}`);
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
  term.writeln('Checking whether tinbase is installed in the container...');

  // 1. 检查 node_modules/tinbase 是否存在
  let installed = false;
  try {
    const r = await client.terminal('ls node_modules/tinbase', undefined, 15000);
    installed = r.ok && String(r.stdout ?? '').includes('tinbase');
  } catch {
    installed = false;
  }

  if (!installed) {
    term.writeln('not installed -> npm install tinbase --no-audit --no-fund (real node route, may take 30-90s)...');
    try {
      const r = await client.terminal('npm install tinbase --no-audit --no-fund', { timeout: 120000 }, 150000);
      if (!r.ok) {
        const why = r.stderr || r.stdout || r.error || 'npm install exited non-zero';
        term.writeln(`${RED}tinbase: install failed: ${String(why).slice(0, 300)}${RESET}`);
        term.writeln(`${RED}tinbase: failed to start (engine wasm): install failed, check container network.${RESET}`);
        return;
      }
    } catch (e) {
      term.writeln(`${RED}tinbase: install failed: ${String(e)}${RESET}`);
      term.writeln(`${RED}tinbase: failed to start (engine wasm): install failed, check container network.${RESET}`);
      return;
    }
    term.writeln('tinbase installed');
  }

  // 2. 已在运行则直接报告
  if (ctx.ports.has(DB_PORT)) {
    term.writeln(`tinbase is already running: ${ctx.ports.get(DB_PORT)}`);
    return;
  }

  // 3. spawn 后台启动（端口选 3001，避免常见冲突）
  //    --engine wasm: WebContainer 无原生二进制，必须 PGlite/WASM 引擎；
  //    去 --memory：data-dir 落容器 FS，随快照持久化（TASK5）。
  term.writeln('Starting npx tinbase start --port 3001 --engine wasm (background process)...');
  let pid: number | undefined;
  try {
    const r = await client.spawn('npx tinbase start --port 3001 --engine wasm', undefined, 8000);
    if (!r.ok || !r.pid) {
      term.writeln(`${RED}tinbase: failed to start (engine wasm): ${r.error || r.stderr || 'spawn returned failure'}${RESET}`);
      term.writeln(`${RED}tinbase: failed to start (engine wasm): check container compatibility.${RESET}`);
      return;
    }
    pid = r.pid;
    term.writeln(`started in background (pid=${pid}); waiting for port 3001 to be ready...`);
  } catch (e) {
    term.writeln(`${RED}tinbase: failed to start (engine wasm): ${String(e)}${RESET}`);
    term.writeln(`${RED}tinbase: failed to start (engine wasm): check container network/compatibility.${RESET}`);
    return;
  }

  // 4. 等待 server-ready 事件（boot.ts 的处理器会打印暗橙 [preview] 行）
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const url = ctx.ports.get(DB_PORT);
    if (url) {
      term.writeln(`${AMBER}Database ready: ${url}${RESET}`);
      term.writeln(`Open ${url} in the browser, or curl ${url} through Lifo.`);
      term.writeln('Database data persists in the workspace (.tinbase) and survives refresh via snapshots.');
      return;
    }
    await sleep(500);
  }
  term.writeln(`${RED}tinbase: failed to start (engine wasm): port 3001 not ready within 30s.${RESET}`);
  term.writeln(
    `${RED}tinbase: failed to start (engine wasm): WebContainer may not run WASM servers. ` +
      `Run db stop and retry, or use an external service.${RESET}`
  );
}

async function dbStatus(ctx: CommandContext): Promise<void> {
  const { client, ports, term } = ctx;
  const url = ports.get(DB_PORT);
  term.writeln(url ? `Port 3001: in ready list -> ${url}` : 'Port 3001: not in ready list (not running)');

  let procs: Array<Record<string, unknown>> = [];
  try {
    const ps = await client.terminal('ps');
    procs = Array.isArray(ps.processes) ? ps.processes : [];
  } catch (e) {
    term.writeln(`${RED}failed to query process table: ${String(e)}${RESET}`);
    return;
  }
  const tinbase = procs.filter((p) => String(p.cmd ?? '').includes(DB_PKG));
  if (tinbase.length === 0) {
    term.writeln('process table: no tinbase process');
  } else {
    for (const p of tinbase) {
      term.writeln(`process table: pid=${p.pid} "${p.cmd}" [${p.status}]`);
    }
  }
}

async function dbStop(ctx: CommandContext): Promise<void> {
  const { term } = ctx;
  let proc: Record<string, unknown> | undefined;
  try {
    proc = await findRunningProc(ctx, DB_PKG);
  } catch (e) {
    term.writeln(`${RED}failed to query process table: ${String(e)}${RESET}`);
    return;
  }
  if (!proc) {
    term.writeln('no running tinbase process');
    return;
  }
  const pid = Number(proc.pid);
  const k = await ctx.client.terminal(`kill ${pid}`);
  if (k.ok && k.killed) {
    term.writeln(`tinbase stopped (pid=${pid}); database data persisted in workspace (.tinbase)`);
    ctx.ports.delete(DB_PORT);
  } else {
    term.writeln(`${RED}failed to stop: ${k.message ?? 'unknown reason'}${RESET}`);
  }
}

// snapshot 命令：查看持久化状态 / 立即保存 / 清除（重置系统）。
function formatKB(n: number): string {
  return `${Math.round(n / 1024)} KB`;
}

async function snapshotStatus(term: Terminal): Promise<void> {
  const meta = await getSnapshotMeta();
  if (!meta || meta.savedAt === 0) {
    term.writeln('Persistent storage: no snapshot yet (fresh workspace)');
    return;
  }
  term.writeln('Persistent storage: snapshot found');
  term.writeln(`  saved at:  ${new Date(meta.savedAt).toISOString()}`);
  term.writeln(`  files:     ${meta.fileCount}`);
  term.writeln(`  bytes:     ${meta.totalBytes} (${formatKB(meta.totalBytes)})`);
}

async function snapshotCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === '') {
    await snapshotStatus(term);
    return;
  }
  if (sub === 'now') {
    const meta = await saveSnapshot(ctx.wc.fs, true);
    term.writeln(`Snapshot saved: ${meta.fileCount} files, ${formatKB(meta.totalBytes)} (${new Date(meta.savedAt).toISOString()})`);
    return;
  }
  if (sub === 'clear') {
    if (args[1] !== '--yes') {
      term.writeln('This will clear the persisted snapshot; the next boot starts fresh.');
      term.writeln('Confirm with: snapshot clear --yes');
      return;
    }
    await clearSnapshot();
    term.writeln('Snapshot cleared; next boot will initialize a fresh workspace.');
    return;
  }
  term.writeln('usage: snapshot | snapshot now | snapshot clear --yes');
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
      else term.writeln('usage: db start | db status | db stop');
      return true;
    }
    case 'snapshot': {
      await snapshotCmd(ctx, rest);
      return true;
    }
    default:
      return false;
  }
}
