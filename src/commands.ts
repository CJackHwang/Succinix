// 浏览器侧命令拦截：以下命令在浏览器处理，不进容器。
//   help / clear / sysinfo / ports / db start|status|stop / snapshot / free / top /
//   reboot / shutdown / cache / workspace / env / settings / version / whoami
// 其余命令返回 false，由调用方原样发 host（TerminalExecutor 路由）。
import type { Terminal } from '@xterm/xterm';
import type { FileSystemAPI, WebContainer } from '@webcontainer/api';
import type { TerminalClient } from './terminal-client.js';
import { detectSystemInfo } from './boot.js';
import { saveSnapshot, clearSnapshot, getSnapshotMeta } from './persist.js';
import {
  isValidWorkspaceName,
  readEnvFile,
  getEnvVar,
  setEnvVar,
  unsetEnvVar,
  getSetting,
  setSetting,
  resetSetting,
  listSettings,
  validateSetting,
  SETTING_KEYS,
  DEFAULT_SETTINGS,
} from './config.js';

export interface CommandContext {
  wc: WebContainer;
  client: TerminalClient;
  /** 端口注册表：port → 预览 URL */
  ports: Map<number, string>;
  term: Terminal;
  /** 字号等布局变更后重建 xterm 视图（main.ts 注入 FitAddon.fit） */
  fit: () => void;
}

const RED = '\x1b[31m';
const AMBER = '\x1b[33m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const VERSION = 'WebUnix 0.1.0 (browser-native Linux)';
const DB_PORT_DEFAULT = 3001;
const DB_PKG = 'tinbase';

// 内存单位：二进制换算，1 KB = 1024 B。
const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
/** 每个运行中容器进程的粗略内存占用（POC：进程表无 RSS，纯估算，输出以 ~ 前缀注明） */
const PROC_EST_MB = 50;

// 二进制换算：MB/GB 保留 1 位小数，整数尾数 .0 去掉（与 Linux free 观感一致）。
function fmtUnit(bytes: number, unit: 'MB' | 'GB'): string {
  const v = bytes / (unit === 'GB' ? GIB : MIB);
  const s = v.toFixed(1);
  return `${s.endsWith('.0') ? s.slice(0, -2) : s} ${unit}`;
}

// 本地时间 YYYY-MM-DD HH:MM:SS（top 头部时间戳）。
function fmtDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

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
  term.writeln(`  free         show memory overview (device + JS heap; estimates marked ~)`);
  term.writeln(`  top          live process table — 3 snapshots, 2s apart`);
  term.writeln(`  reboot       restart the system (browser reload; persistent data survives)`);
  term.writeln(`  shutdown     power off (you can close this tab)`);
  term.writeln(`  cache        show cache usage; 'cache clear' cleans rebuildable caches`);
  term.writeln(`  workspace    list workspaces; create/switch/rm manage isolated workspaces`);
  term.writeln(`  env          list / set / unset environment variables (persisted in /etc/webunix.env)`);
  term.writeln(`  settings     view / set / reset system settings (persisted in /etc/webunix.settings)`);
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

// db 端口：读 settings preview-port，缺省 3001；值被手改非法时回落默认。
async function resolveDbPort(fs: FileSystemAPI): Promise<number> {
  const raw = await getSetting(fs, 'preview-port');
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DB_PORT_DEFAULT;
}

// db start：容器内按需安装 tinbase，然后 spawn 后台启动，等待端口就绪。
async function dbStart(ctx: CommandContext): Promise<void> {
  const { client, term, wc } = ctx;
  const port = await resolveDbPort(wc.fs);
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
  if (ctx.ports.has(port)) {
    term.writeln(`tinbase is already running: ${ctx.ports.get(port)}`);
    return;
  }

  // 3. spawn 后台启动（端口取 settings preview-port，缺省 3001）
  //    --engine wasm: WebContainer 无原生二进制，必须 PGlite/WASM 引擎；
  //    去 --memory：data-dir 落容器 FS，随快照持久化（TASK5）。
  term.writeln(`Starting npx tinbase start --port ${port} --engine wasm (background process)...`);
  let pid: number | undefined;
  try {
    const r = await client.spawn(`npx tinbase start --port ${port} --engine wasm`, undefined, 8000);
    if (!r.ok || !r.pid) {
      term.writeln(`${RED}tinbase: failed to start (engine wasm): ${r.error || r.stderr || 'spawn returned failure'}${RESET}`);
      term.writeln(`${RED}tinbase: failed to start (engine wasm): check container compatibility.${RESET}`);
      return;
    }
    pid = r.pid;
    term.writeln(`started in background (pid=${pid}); waiting for port ${port} to be ready...`);
  } catch (e) {
    term.writeln(`${RED}tinbase: failed to start (engine wasm): ${String(e)}${RESET}`);
    term.writeln(`${RED}tinbase: failed to start (engine wasm): check container network/compatibility.${RESET}`);
    return;
  }

  // 4. 等待 server-ready 事件（boot.ts 的处理器会打印暗橙 [preview] 行）
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const url = ctx.ports.get(port);
    if (url) {
      term.writeln(`${AMBER}Database ready: ${url}${RESET}`);
      term.writeln(`Open ${url} in the browser, or curl ${url} through Lifo.`);
      term.writeln('Database data persists in the workspace (.tinbase) and survives refresh via snapshots.');
      return;
    }
    await sleep(500);
  }
  term.writeln(`${RED}tinbase: failed to start (engine wasm): port ${port} not ready within 30s.${RESET}`);
  term.writeln(
    `${RED}tinbase: failed to start (engine wasm): WebContainer may not run WASM servers. ` +
      `Run db stop and retry, or use an external service.${RESET}`
  );
}

async function dbStatus(ctx: CommandContext): Promise<void> {
  const { client, ports, term, wc } = ctx;
  const port = await resolveDbPort(wc.fs);
  const url = ports.get(port);
  term.writeln(url ? `Port ${port}: in ready list -> ${url}` : `Port ${port}: not in ready list (not running)`);

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
  const { term, wc } = ctx;
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
    ctx.ports.delete(await resolveDbPort(wc.fs));
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

// free：内存概览（类似 Linux free）。浏览器沙箱拿不到系统级 used/available ——
// used 用 JS heap 真实值 + 容器进程估算，available 为 total - used 估算；
// 估算值一律 ~ 前缀，并脚注诚实标注。
async function freeCmd(ctx: CommandContext): Promise<void> {
  const { term } = ctx;
  const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  const devMem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;

  // 容器进程估算：进程表各进程无 RSS，按运行中进程数 × 固定基数额估算。
  let procEstBytes = 0;
  try {
    const ps = await ctx.client.terminal('ps');
    const procs = Array.isArray(ps.processes) ? ps.processes : [];
    procEstBytes = procs.filter((p) => p.status === 'running').length * PROC_EST_MB * MIB;
  } catch {
    /* 进程表不可达时估算为 0，输出仍标注 estimated */
  }

  const hasPerf = perfMem !== undefined;
  const hasSys = devMem !== undefined && hasPerf;
  const sysUsedBytes = (perfMem?.usedJSHeapSize ?? 0) + procEstBytes;
  const devMemGB = typeof devMem === 'number' ? devMem : 0;

  const sysTotal = devMem !== undefined ? `${devMem} GB` : '--';
  const sysUsed = hasSys ? `~${fmtUnit(sysUsedBytes, 'GB')}` : '--';
  const sysAvail = hasSys ? `~${fmtUnit(Math.max(0, devMemGB * GIB - sysUsedBytes), 'GB')}` : '--';

  const heapTotal = perfMem ? fmtUnit(perfMem.totalJSHeapSize, 'MB') : '--';
  const heapUsed = perfMem ? fmtUnit(perfMem.usedJSHeapSize, 'MB') : '--';
  const heapAvail = perfMem ? fmtUnit(Math.max(0, perfMem.totalJSHeapSize - perfMem.usedJSHeapSize), 'MB') : '--';

  const col = (s: string) => s.padEnd(13);
  term.writeln('              total        used         available');
  term.writeln('Memory'.padEnd(14) + col(sysTotal) + col(sysUsed) + col(sysAvail));
  term.writeln('JS heap'.padEnd(14) + col(heapTotal) + col(heapUsed) + col(heapAvail));
  if (hasSys) {
    term.writeln(`${GRAY}(estimated — browser sandbox has no OS-level memory stats)${RESET}`);
  }
  if (devMem === undefined) {
    term.writeln(`${GRAY}(navigator.deviceMemory unavailable — system total shown as --)${RESET}`);
  }
  if (!hasPerf) {
    term.writeln(`${GRAY}(performance.memory unavailable — JS heap values shown as --)${RESET}`);
  }
}

// top：进程表实时视图（复用 ps）。POC 不做交互式常驻 —— 2s 间隔快照 3 次后自动结束。
async function topCmd(ctx: CommandContext): Promise<void> {
  const { term } = ctx;
  for (let round = 0; round < 3; round++) {
    if (round > 0) await sleep(2000);
    let procs: Array<Record<string, unknown>> = [];
    try {
      const ps = await ctx.client.terminal('ps');
      procs = Array.isArray(ps.processes) ? ps.processes : [];
    } catch (e) {
      term.writeln(`${RED}failed to query process table: ${String(e)}${RESET}`);
      return;
    }
    const plural = procs.length === 1 ? '' : 'es';
    term.writeln(`top — ${fmtDateTime(new Date())}  (${procs.length} process${plural})`);
    term.writeln(`${'PID'.padStart(6)}  ${'STATE'.padEnd(9)}COMMAND`);
    for (const p of procs) {
      const st = String(p.status ?? '');
      const state = st === 'running' ? `${AMBER}${st}${RESET}` : `${GRAY}${st}${RESET}`;
      term.writeln(`${String(p.pid).padStart(6)}  ${state}${' '.repeat(Math.max(0, 9 - st.length))}${String(p.cmd ?? '')}`);
    }
    if (round < 2) term.writeln('');
  }
}

// reboot：重启系统 = 重建容器释放内存。最简单可靠的方式是 location.reload()——
// 浏览器释放旧容器全部内存，重新 boot；持久化在 IndexedDB（浏览器侧），reload 保留。
function rebootCmd(term: Terminal): void {
  term.writeln('Rebooting WebUnix...');
  setTimeout(() => location.reload(), 300);
}

// shutdown：POC 不真关 tab，输出提示即可。
function shutdownCmd(term: Terminal): void {
  term.writeln('Powering off. You can close this tab.');
}

// cache：查看缓存占用（npm cache / 容器 /tmp，走 Lifo du）；cache clear 清理可重建缓存
// （npm 缓存可重建，~/.npm 其余目录保留）。绝不清理 /workspace —— 用户数据不碰。
async function cacheCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === '') {
    term.writeln('Cache usage (container-side, via Lifo du):');
    try {
      const r = await ctx.client.terminal('du -sh /tmp ~/.npm 2>/dev/null', undefined, 20000);
      const out = String(r.stdout ?? '').trim();
      if (out) term.writeln(out);
      else term.writeln(`${GRAY}cache usage unavailable (--)${RESET}`);
    } catch (e) {
      term.writeln(`${GRAY}cache usage unavailable (--) — ${String(e).slice(0, 120)}${RESET}`);
    }
    return;
  }
  if (sub === 'clear') {
    term.writeln('Clearing rebuildable caches (npm cache, container /tmp)...');
    try {
      const r = await ctx.client.terminal('rm -rf /tmp/* ~/.npm/_cacache 2>/dev/null', undefined, 30000);
      if (r.ok) term.writeln('Cache cleared (npm cache and /tmp are rebuildable).');
      else term.writeln(`${RED}cache clear failed: ${String(r.stderr || r.stdout || r.error || 'rm exited non-zero').slice(0, 200)}${RESET}`);
      term.writeln(`${GRAY}(/workspace untouched — user data is never cleared)${RESET}`);
    } catch (e) {
      term.writeln(`${RED}cache clear failed: ${String(e)}${RESET}`);
    }
    return;
  }
  term.writeln('usage: cache | cache clear');
}

// ─── 工作区（workspace，TASK7）：/ws/<name> 子目录 = 一个工作区，
// /ws/.current 记录当前工作区名（随快照持久，host 零改动）。
// 全部走 wc.fs 原生 API：mkdir / readFile / writeFile / rm(recursive)。

const WS_ROOT = '/ws';
const WS_CURRENT_FILE = '/ws/.current';
const DEFAULT_WORKSPACE = 'main';

// 读当前工作区名；.current 缺失或不可读返回 null。
export async function getCurrentWorkspace(fs: FileSystemAPI): Promise<string | null> {
  try {
    const raw = await fs.readFile(WS_CURRENT_FILE, 'utf8');
    const name = raw.trim();
    return name || null;
  } catch {
    return null;
  }
}

// 列出全部工作区目录名（以目录为准；.current 是文件，天然排除）。
export async function listWorkspaces(fs: FileSystemAPI): Promise<string[]> {
  try {
    const entries = await fs.readdir(WS_ROOT, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => String(e.name))
      .sort();
  } catch {
    return []; // /ws 不存在（极端情况），按空列表处理
  }
}

// 组装列表输出：当前工作区置顶，其余按名字排序；表格对齐，
// (current) 列对齐到最长名字 + 5 空格，最小列宽 9。
export function buildWorkspaceList(current: string | null, names: string[]): string[] {
  const lines = ['Workspaces'];
  if (names.length === 0) {
    lines.push('  (none)');
    return lines;
  }
  const ordered = [...names].sort();
  if (current && ordered.includes(current)) {
    ordered.splice(ordered.indexOf(current), 1);
    ordered.unshift(current);
  }
  const width = Math.max(9, ...ordered.map((n) => n.length + 5));
  for (const name of ordered) {
    const marker = name === current ? '(current)' : '';
    lines.push(`  ${name.padEnd(width)}${marker}`);
  }
  return lines;
}

// 创建工作区：目录已存在则报错。
export async function workspaceCreate(fs: FileSystemAPI, name: string): Promise<{ ok: boolean; message: string }> {
  if (!isValidWorkspaceName(name)) {
    return { ok: false, message: `invalid workspace name: '${name}' (letters, digits, dot, dash, underscore only)` };
  }
  if ((await listWorkspaces(fs)).includes(name)) {
    return { ok: false, message: `Workspace '${name}' already exists` };
  }
  try {
    await fs.mkdir(WS_ROOT, { recursive: true }); // 兜底：确保 /ws 存在
    await fs.mkdir(`${WS_ROOT}/${name}`, { recursive: false });
  } catch (e) {
    return { ok: false, message: `failed to create workspace: ${String(e).slice(0, 120)}` };
  }
  return { ok: true, message: `Workspace '${name}' created. Switch with: workspace switch ${name}` };
}

// 切换工作区：更新 /ws/.current；不存在则报错。
export async function workspaceSwitch(fs: FileSystemAPI, name: string): Promise<{ ok: boolean; message: string }> {
  if (!(await listWorkspaces(fs)).includes(name)) {
    return { ok: false, message: `Workspace '${name}' does not exist` };
  }
  try {
    await fs.writeFile(WS_CURRENT_FILE, name);
  } catch (e) {
    return { ok: false, message: `failed to switch workspace: ${String(e).slice(0, 120)}` };
  }
  return { ok: true, message: `Switched to workspace '${name}'. Your files live in /ws/${name}. cd /ws/${name} to start working.` };
}

// 删除工作区：需 --yes；禁止删当前工作区与 main。
export async function workspaceRemove(
  fs: FileSystemAPI,
  name: string,
  current: string | null,
  yes: boolean
): Promise<{ ok: boolean; message: string }> {
  if (name === DEFAULT_WORKSPACE) {
    return { ok: false, message: `cannot remove 'main' (default workspace)` };
  }
  if (name === current) {
    return { ok: false, message: `cannot remove the current workspace (switch first: workspace switch main)` };
  }
  if (!(await listWorkspaces(fs)).includes(name)) {
    return { ok: false, message: `Workspace '${name}' does not exist` };
  }
  if (!yes) {
    return { ok: false, message: `This will permanently remove workspace '${name}' and its files. Confirm with: workspace rm ${name} --yes` };
  }
  try {
    await fs.rm(`${WS_ROOT}/${name}`, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, message: `failed to remove workspace: ${String(e).slice(0, 120)}` };
  }
  return { ok: true, message: `Workspace '${name}' removed` };
}

// workspace 命令族：workspace | create <name> | switch <name> | rm <name> --yes
async function workspaceCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === '') {
    const current = await getCurrentWorkspace(ctx.wc.fs);
    const names = await listWorkspaces(ctx.wc.fs);
    for (const line of buildWorkspaceList(current, names)) term.writeln(line);
    return;
  }
  if (sub === 'create') {
    const name = args[1] ?? '';
    if (!name) {
      term.writeln('usage: workspace create <name>');
      return;
    }
    const r = await workspaceCreate(ctx.wc.fs, name);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }
  if (sub === 'switch') {
    const name = args[1] ?? '';
    if (!name) {
      term.writeln('usage: workspace switch <name>');
      return;
    }
    const r = await workspaceSwitch(ctx.wc.fs, name);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }
  if (sub === 'rm') {
    const name = args[1] ?? '';
    if (!name) {
      term.writeln('usage: workspace rm <name> --yes');
      return;
    }
    const current = await getCurrentWorkspace(ctx.wc.fs);
    const r = await workspaceRemove(ctx.wc.fs, name, current, args.includes('--yes'));
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }
  term.writeln('usage: workspace | workspace create <name> | workspace switch <name> | workspace rm <name> --yes');
}

// ─── 系统配置（TASK10）：env / settings ───
// 两者都落在容器 FS（/etc/webunix.env、/etc/webunix.settings），随快照持久，重启保留。

// env：查看 / 设置 / 删除环境变量。
//   env              列出全部（key=value 对齐，值可含 =）
//   env <key>        查看单个（不存在显示 not set）
//   env <key>=<val>  设置
//   env -u <key>     删除
async function envCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term, wc } = ctx;
  if (args.length === 0) {
    const map = await readEnvFile(wc.fs);
    if (map.size === 0) {
      term.writeln('(no environment variables set)');
      return;
    }
    const keys = [...map.keys()].sort();
    const width = Math.max(...keys.map((k) => k.length));
    for (const key of keys) {
      term.writeln(`${key.padEnd(width)}=${map.get(key) ?? ''}`);
    }
    return;
  }
  const arg = args[0];
  if (arg === '-u' || arg === '--unset') {
    const key = args[1];
    if (!key) {
      term.writeln('usage: env -u <key>');
      return;
    }
    const removed = await unsetEnvVar(wc.fs, key);
    term.writeln(removed ? `unset ${key}` : `${key} is not set`);
    return;
  }
  const eq = arg.indexOf('=');
  if (eq === -1) {
    // 查看单个
    const value = await getEnvVar(wc.fs, arg);
    term.writeln(value !== undefined ? `${arg}=${value}` : `${arg} is not set`);
    return;
  }
  // 设置：按第一个 = 切分，值允许含 =
  const key = arg.slice(0, eq);
  const value = arg.slice(eq + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    term.writeln(`${RED}env: invalid variable name '${key}'${RESET}`);
    return;
  }
  await setEnvVar(wc.fs, key, value);
  term.writeln(`set ${key}=${value}`);
}

// settings：查看 / 设置 / 恢复系统设置。
//   settings               列出全部
//   settings <key>         查看
//   settings <key> <val>   设置
//   settings reset <key>   恢复默认
async function settingsCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term, wc } = ctx;
  if (args.length === 0) {
    const entries = await listSettings(wc.fs);
    const width = Math.max(...entries.map((e) => e.key.length), 1);
    for (const e of entries) {
      const marker = e.isDefault ? `${GRAY}(default)${RESET}` : '';
      term.writeln(`  ${e.key.padEnd(width)}  ${e.value}${marker ? '  ' + marker : ''}`);
    }
    return;
  }
  if (args[0] === 'reset') {
    const key = args[1];
    if (!key) {
      term.writeln('usage: settings reset <key>');
      return;
    }
    if (!(key in DEFAULT_SETTINGS)) {
      term.writeln(`${RED}unknown setting: ${key}${RESET}`);
      return;
    }
    const removed = await resetSetting(wc.fs, key);
    const def = DEFAULT_SETTINGS[key];
    term.writeln(removed ? `reset ${key} to default (${def})` : `${key} is already at default (${def})`);
    applySettingRuntime(ctx, key, def);
    return;
  }
  const key = args[0];
  if (!(key in DEFAULT_SETTINGS)) {
    term.writeln(`${RED}unknown setting: ${key}${RESET}`);
    term.writeln(`known settings: ${SETTING_KEYS.join(', ')}`);
    return;
  }
  if (args.length === 1) {
    const value = await getSetting(wc.fs, key);
    const def = DEFAULT_SETTINGS[key];
    term.writeln(`${key}=${value}${value === def ? ' (default)' : ''}`);
    return;
  }
  const value = args.slice(1).join(' ');
  const err = validateSetting(key, value);
  if (err) {
    term.writeln(`${RED}settings: ${err}${RESET}`);
    return;
  }
  await setSetting(wc.fs, key, value);
  term.writeln(`set ${key}=${value}`);
  applySettingRuntime(ctx, key, value);
}

// 运行时应用设置：font-size 立即改 xterm 字号并重算布局（FitAddon）。
// preview-port / default-workspace 在各自消费点生效（db start / boot），无需即时动作。
function applySettingRuntime(ctx: CommandContext, key: string, value: string): void {
  if (key !== 'font-size') return;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 8 && n <= 72) {
    ctx.term.options.fontSize = n;
    ctx.fit();
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
      else term.writeln('usage: db start | db status | db stop');
      return true;
    }
    case 'snapshot': {
      await snapshotCmd(ctx, rest);
      return true;
    }
    case 'free':
      await freeCmd(ctx);
      return true;
    case 'top':
      await topCmd(ctx);
      return true;
    case 'reboot':
      rebootCmd(term);
      return true;
    case 'shutdown':
      shutdownCmd(term);
      return true;
    case 'cache': {
      await cacheCmd(ctx, rest);
      return true;
    }
    case 'workspace': {
      await workspaceCmd(ctx, rest);
      return true;
    }
    case 'env': {
      await envCmd(ctx, rest);
      return true;
    }
    case 'settings': {
      await settingsCmd(ctx, rest);
      return true;
    }
    default:
      return false;
  }
}
