// 浏览器侧命令拦截：以下命令在浏览器处理，不进容器。
//   help / clear / sysinfo / ports / db start|status|stop / snapshot / free / top /
//   reboot / shutdown / cache / workspace / env / settings / service / log / pkg /
//   netstat / ip / version / whoami / uname / motd
// 其余命令返回 false，由调用方原样发 host（TerminalExecutor 路由）。
import type { Terminal } from '@xterm/xterm';
import type { FileSystemAPI, WebContainer, WebContainerProcess } from '@webcontainer/api';
import type { TerminalClient } from './engine/index.js';
import { detectSystemInfo } from './boot.js';
import {
  saveSnapshot,
  loadSnapshot,
  clearSnapshot,
  getSnapshotMeta,
  forcePersist,
  type PersistContext,
  type SnapshotMeta,
} from './persist.js';

// M2：snapshot 命令缺省适配（单实例 = 模块级默认实例行为全等）。
async function loadSnapshotDefault(fs: FileSystemAPI): Promise<SnapshotMeta | null> {
  return loadSnapshot(fs);
}
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
import {
  readServices,
  listServiceStates,
  getServiceState,
  startService,
  stopService,
  enableAutostart,
  disableAutostart,
  type ServiceContext,
} from './services.js';
import { readLog, readBootLog, clearLog, log } from './log.js';
import {
  listPackages,
  formatPackageList,
  searchPackages,
  formatSearchResults,
  installPackage,
  removePackage,
  packageInfo,
  type PkgContext,
} from './pkg.js';
import { readMotd, writeMotd, resetMotd } from './motd.js';
import { DEFAULT_INSTANCE_ID, instanceStateRoot, tinbaseDataDir } from './instance/paths.js';
import { instancePorts } from './instance/ports.js';
import { AMBER, RED, GRAY, RESET } from './theme.js';
import { sleep } from './util.js';
import { SUCCINIX_VERSION } from './version.js';

export interface CommandContext {
  wc: WebContainer;
  client: TerminalClient;
  /** 端口注册表：port → 预览 URL */
  ports: Map<number, string>;
  term: Terminal;
  /** 字号等布局变更后重建 xterm 视图（main.ts 注入 FitAddon.fit） */
  fit: () => void;
  /** 当前 host 进程句柄（main.ts 的 host 重启路径 kill 用；自检构造的假 context 可缺省） */
  hostProc?: WebContainerProcess;
  /** 实例上下文（M2/M5，additive）：本地命令的状态文件/持久化按实例解析；缺省 = 默认实例 */
  instanceId?: string;
  /** 状态根前缀覆盖（M5，additive）：缺省 = DM-12 内置前缀 */
  statePrefix?: string;
  /** 实例持久化上下文（M2/M5，additive）：snapshot 命令按实例存取；缺省 = 模块级默认实例 */
  persist?: PersistContext;
  /** 用户标识（U1，additive）：?user=<id> 模式注入；缺省 = guest（独立应用现状）。与
   *  instanceId 等价（内部同一字段），此处仅用于 whoami 等身份展示命令 */
  userId?: string;
  /** 实例级重置回调（M4/M5，additive）：多实例模式 reboot = 清该实例状态并重 boot，不刷新宿主页面；
   *  缺省 = 整页刷新（demo 单页单实例路径，Tab 即实例，刷新 = 实例级重置） */
  onInstanceReset?: () => void | Promise<void>;
  /** 实例停止回调（M4/M5，additive）：多实例模式 shutdown = 停当前实例，不动其他实例 */
  onInstanceStop?: () => void | Promise<void>;
}

// M4：reboot 目标判定 —— 非默认实例 = 实例级重置；缺省/默认实例 = 整页刷新（现状）。
export function rebootMode(instanceId: string | undefined): 'instance' | 'page' {
  return instanceId !== undefined && instanceId !== DEFAULT_INSTANCE_ID ? 'instance' : 'page';
}

const VERSION = `Succinix ${SUCCINIX_VERSION} (browser-native Linux)`;
const DB_PORT_DEFAULT = 3001;
const DB_PKG = 'tinbase';

// TASK27：内置语言运行时版本（lang 命令）。
// python 版本构建期固定：Pyodide 314.0.4 打包的 Python 3.14.2（sys.version 首段实测）；
// node 版本实时查询（node --version）；typescript 走 node 22 的 strip-types。
const PYTHON_BUNDLED_VERSION = '3.14.2 (Pyodide 314.0.4)';
const TS_RUNTIME_NOTE = 'via node --experimental-strip-types (Node 22)';

// M1 修复 / M4：db start 启动时解析的端口按实例记录在案；db status/stop 用记录值而非每次现读
// settings，避免运行中改 preview-port 后 status/stop 操作到错误的端口。未启动过 db 时为
// 无记录，status/stop 回落现读 settings（此时没有在跑实例，读最新设置是合理的）。
const dbActivePortByInstance = new Map<string, number>();

function dbActivePortFor(instanceId: string): number | null {
  return dbActivePortByInstance.get(instanceId) ?? null;
}

// 内存单位：二进制换算，1 KB = 1024 B。
const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
/** 每个运行中容器进程的粗略内存占用（POC：进程表无 RSS，纯估算，输出以 ~ 前缀注明） */
const PROC_EST_MB = 50;

// 二进制换算：MB/GB 保留 1 位小数，整数尾数 .0 去掉（与 Linux free 观感一致）。
export function fmtUnit(bytes: number, unit: 'MB' | 'GB'): string {
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
  term.writeln('Succinix built-in commands');
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
  term.writeln(`  env          list / set / unset environment variables (persisted in /etc/succinix.env)`);
  term.writeln(`  settings     view / set / reset system settings (persisted in /etc/succinix.settings)`);
  term.writeln(`  service      list services; start/stop/status/enable/disable manage them (declarative autostart)`);
  term.writeln(`  log          show recent log entries (last 20); log -n <count> / log clear / log boot`);
  term.writeln(`  pkg          package management: list / search <term> / install <name> / remove <name> / info <name>`);
  term.writeln(`  netstat      list virtual listening ports ('netstat -p' shows associated processes)`);
  term.writeln(`  ip addr      show virtual network identity (browser platform + preview domain)`);
  term.writeln(`  uname        show system identity: kernel / runtime / arch (honest, no fake Linux)`);
  term.writeln(`  motd         view the login banner; 'motd <text>' sets, 'motd reset' restores default`);
  term.writeln(`  lang         list built-in language runtimes (node / python / typescript)`);
  term.writeln(`  pwd          show the session working directory (synced with node/python child cwd)`);
  term.writeln(`  version      show version`);
  term.writeln(`  whoami       show current user`);
  term.writeln('');
  term.writeln('host side (TerminalExecutor unified routing)');
  term.writeln(`  node|npm|npx ...   real node subprocess (spawn for long-running background)`);
  term.writeln(`  python ...         Pyodide runtime (python -c "<code>" | python <script.py> | python -m pip <cmd>)`);
  term.writeln(`  other commands      Lifo sandbox: grep / cat / wc / echo / curl ...`);
  term.writeln(`  ps / kill <pid>    process table management`);
  term.writeln(`  cwd / setCwd / ping / exit  protocol commands`);
  term.writeln('');
  term.writeln('terminal keys');
  term.writeln(`  Ctrl+C             interrupt the running command (node run) and discard queued commands`);
  term.writeln(`  Up / Down arrows   command history (session memory)`);
  term.writeln(`  Tab                complete built-in command names and file paths`);
  term.writeln(`  Ctrl+L             clear the screen`);
}

function printPorts(term: Terminal, ports: Map<number, string>, instanceId?: string): void {
  // M4：按实例视图收窄（期望端口 ∩ 页面级就绪；缺省实例 = 页面级全部，现状不变）。
  const view = instancePorts.portsFor(instanceId ?? DEFAULT_INSTANCE_ID, ports);
  if (view.size === 0) {
    term.writeln('(no service ports ready yet)');
    return;
  }
  term.writeln('PORT  URL');
  for (const [port, url] of view) {
    term.writeln(`${port}  ${url}`);
  }
}

// M4：进程归属过滤（db 的进程匹配与 service 一致）。
function procBelongsToCtxInstance(proc: Record<string, unknown>, instanceId?: string): boolean {
  const scope = String(proc.scope ?? '');
  const containerId = proc.containerId !== undefined ? String(proc.containerId) : undefined;
  if (instanceId === undefined || instanceId === DEFAULT_INSTANCE_ID) {
    return !(containerId !== undefined && containerId.startsWith('.succinix-'));
  }
  return scope === 'system' || containerId === `.succinix-${instanceId}` || containerId === instanceId;
}

async function findRunningProcForInstance(ctx: CommandContext, needle: string): Promise<Record<string, unknown> | undefined> {
  const ps = await ctx.client.terminal('ps');
  const procs = Array.isArray(ps.processes) ? ps.processes : [];
  return procs.find(
    (p) => String(p.cmd ?? '').includes(needle) && p.status === 'running' && procBelongsToCtxInstance(p, ctx.instanceId)
  );
}

// db 端口：读 settings preview-port（M4 按实例 settings），缺省 3001；值被手改非法时回落默认。
async function resolveDbPort(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<number> {
  const raw = await getSetting(fs, 'preview-port', instanceId, statePrefix);
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DB_PORT_DEFAULT;
}

// db start：容器内按需安装 tinbase，然后 spawn 后台启动，等待端口就绪。
async function dbStart(ctx: CommandContext): Promise<void> {
  const { client, term, wc } = ctx;
  const inst = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  const port = await resolveDbPort(wc.fs, inst, ctx.statePrefix);
  dbActivePortByInstance.set(inst, port); // 记录本次启动端口（M1：status/stop 用记录值）
  const view = instancePorts.portsFor(inst, ctx.ports);
  term.writeln('Checking whether tinbase is installed in the container...');

  // P2-9：dbStart 四路失败输出收敛 —— "failed to start (engine wasm): <why>" 骨架只留一处。
  // 各失败路径差异只在 why 文案；输出与旧实现逐字节一致。
  const fail = (why: string): void => term.writeln(`${RED}tinbase: failed to start (engine wasm): ${why}${RESET}`);

  // 1. 检查 /workspace/node_modules/tinbase 是否存在（test -d：不存在时 exit≠0，比 ls+stdout 包含判断可靠，
  //    避免 Lifo 把 "No such file or directory" 打到 stdout 造成误判重复 npm install）
  //    N1（TASK20）：绝对路径 —— npm install 装进 process.cwd()（/workspace）下的 node_modules，
  //    相对路径 `test -d node_modules/tinbase` 被 Lifo 按 VFS 根解析恒判缺失，每次误报重复安装。
  let installed = false;
  try {
    const r = await client.terminal('test -d /workspace/node_modules/tinbase', undefined, 15000);
    installed = r.ok === true;
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
        fail('install failed, check container network.');
        return;
      }
    } catch (e) {
      term.writeln(`${RED}tinbase: install failed: ${String(e)}${RESET}`);
      fail('install failed, check container network.');
      return;
    }
    term.writeln('tinbase installed');
  }

  // 2. 已在运行则直接报告：端口就绪 + 进程表有 tinbase running 进程，交叉验证防占端口误报
  //    （端口被其他进程占用时不再误报 "tinbase is already running"）。
  if (view.has(port)) {
    let running: Record<string, unknown> | undefined;
    try {
      running = await findRunningProcForInstance(ctx, DB_PKG);
    } catch {
      running = undefined; // 进程表不可达：按无 tinbase 进程处理
    }
    if (running) {
      term.writeln(`tinbase is already running: ${view.get(port)}`);
      return;
    }
    term.writeln(`${AMBER}Port ${port} is in the ready list but no tinbase process is running; another process may own it.${RESET}`);
    term.writeln('Attempting to start tinbase anyway (it will fail fast if the port is truly taken)...');
  }

  // 2b. 同页端口冲突拒绝（M4）：端口已被其他实例期望 → 明确拒绝并提示，不抢占。
  const conflict = instancePorts.hasConflict(inst, port);
  if (conflict !== null) {
    term.writeln(`${RED}tinbase: failed to start (engine wasm): port ${port} is already used by instance '${conflict}'${RESET}`);
    return;
  }

  // 3. spawn 后台启动（端口取 settings preview-port，缺省 3001）
  //    --engine wasm: WebContainer 无原生二进制，必须 PGlite/WASM 引擎；
  //    去 --memory：data-dir 落容器 FS，随快照持久化（TASK5）。
  //    M4：非默认实例显式 --data-dir <stateRoot>/tinbase，实例间数据隔离
  //    （缺省实例不传 flag = 现状 /workspace/.tinbase，行为全等）。
  const dataDir = instanceStateRoot(inst) ? tinbaseDataDir(inst) : null;
  // M5：data-dir 是浏览器视角绝对路径（wc.fs /workspace/.succinix-<id>/tinbase），
  // host 侧按浏览器视角映射到 process.cwd() 下（mapDataDirArgs）；spawn 前先由浏览器
  // 建好目录，避免状态根刚被 reboot 清空后父目录缺失（tinbase 只建叶子目录）。
  if (dataDir) {
    try {
      await wc.fs.mkdir(dataDir, { recursive: true });
    } catch (e) {
      term.writeln(`${RED}tinbase: data dir prepare failed: ${String(e).slice(0, 160)}${RESET}`);
    }
  }
  const startCmd = `npx tinbase start --port ${port} --engine wasm${dataDir ? ` --data-dir ${dataDir}` : ''}`;
  term.writeln(`Starting ${startCmd} (background process)...`);
  let pid: number | undefined;
  try {
    const r = await client.spawn(startCmd, undefined, 8000);
    if (!r.ok || !r.pid) {
      fail(r.error || r.stderr || 'spawn returned failure');
      fail('check container compatibility.');
      return;
    }
    pid = r.pid;
    instancePorts.expect(inst, port); // M4：登记实例期望端口（server-ready 归到该实例视图）
    term.writeln(`started in background (pid=${pid}); waiting for port ${port} to be ready...`);
  } catch (e) {
    fail(String(e));
    fail('check container network/compatibility.');
    return;
  }

  // 4. 等待 server-ready 事件（boot.ts 的处理器会打印暗橙 [preview] 行）。
  //    顺带检查进程表：pid 已 exited 则提前报失败（配合 host 的 spawn error 改写，
  //    立即看到原因而非等满 30s 端口超时）。
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const url = instancePorts.portsFor(inst, ctx.ports).get(port);
    if (url) {
      term.writeln(`${AMBER}Database ready: ${url}${RESET}`);
      term.writeln(`Open ${url} in the browser, or curl ${url} through Lifo.`);
      term.writeln('Database data persists across db restart in the workspace (.tinbase).');
      term.writeln('Browser refresh recreates the wasm store (binary db files are not snapshotted).');
      return;
    }
    if (pid) {
      try {
        const ps = await client.terminal('ps');
        const procs = Array.isArray(ps.processes) ? ps.processes : [];
        const proc = procs.find((p) => Number(p.pid) === pid);
        if (proc && proc.status === 'exited') {
          fail(`process exited (pid=${pid}) before port ${port} became ready.`);
          term.writeln(`${RED}Run 'db status' to inspect the process output tail, then 'db stop' and retry.${RESET}`);
          return;
        }
      } catch {
        /* 进程表查询失败不阻断等待，继续轮询 */
      }
    }
    await sleep(500);
  }
  fail(`port ${port} not ready within 30s.`);
  fail('WebContainer may not run WASM servers. Run db stop and retry, or use an external service.');
}

async function dbStatus(ctx: CommandContext): Promise<void> {
  const { client, term, wc } = ctx;
  const inst = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  const port = dbActivePortFor(inst) ?? (await resolveDbPort(wc.fs, inst, ctx.statePrefix));
  const view = instancePorts.portsFor(inst, ctx.ports);
  const url = view.get(port);
  term.writeln(url ? `Port ${port}: in ready list -> ${url}` : `Port ${port}: not in ready list (not running)`);

  let procs: Array<Record<string, unknown>> = [];
  try {
    const ps = await client.terminal('ps');
    procs = Array.isArray(ps.processes) ? ps.processes : [];
  } catch (e) {
    term.writeln(`${RED}failed to query process table: ${String(e)}${RESET}`);
    return;
  }
  const tinbase = procs.filter((p) => String(p.cmd ?? '').includes(DB_PKG) && procBelongsToCtxInstance(p, ctx.instanceId));
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
  const inst = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  let proc: Record<string, unknown> | undefined;
  try {
    proc = await findRunningProcForInstance(ctx, DB_PKG);
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
    // 用记录端口清理注册表（运行中改 settings 不影响 stop 的正确端口）
    const port = dbActivePortFor(inst) ?? (await resolveDbPort(wc.fs, inst, ctx.statePrefix));
    instancePorts.release(inst, port); // M4：释放实例期望端口
    if (inst === DEFAULT_INSTANCE_ID) ctx.ports.delete(port); // 默认实例清理页面级注册表（现状）
    dbActivePortByInstance.delete(inst);
  } else {
    term.writeln(`${RED}failed to stop: ${k.message ?? 'unknown reason'}${RESET}`);
  }
}

// snapshot 命令：查看持久化状态 / 立即保存 / 清除（重置系统）。
function formatKB(n: number): string {
  return `${Math.round(n / 1024)} KB`;
}

async function snapshotStatus(term: Terminal, persist: PersistContext): Promise<void> {
  const meta = await persist.meta();
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
  // M2：按实例持久化上下文存取（缺省 = 模块级默认实例，行为全等现状）。
  const persist = ctx.persist ?? { save: saveSnapshot, load: loadSnapshotDefault, clear: clearSnapshot, meta: getSnapshotMeta, force: forcePersist };
  const sub = args[0] ?? '';
  if (sub === '') {
    await snapshotStatus(term, persist);
    return;
  }
  if (sub === 'now') {
    const { meta, skipped } = await persist.save(ctx.wc.fs, true);
    if (skipped) {
      // 超过 50MB 上限：persist 跳过本次写，明确输出 skipped，不伪装成成功。
      term.writeln('Snapshot skipped (over 50MB limit)');
      void log('WARN', 'snapshot skipped: over 50MB limit');
      return;
    }
    term.writeln(`Snapshot saved: ${meta.fileCount} files, ${formatKB(meta.totalBytes)} (${new Date(meta.savedAt).toISOString()})`);
    void log('INFO', `snapshot saved: ${meta.fileCount} files, ${meta.totalBytes} bytes`);
    return;
  }
  if (sub === 'clear') {
    if (args[1] !== '--yes') {
      term.writeln('This will clear the persisted snapshot; the next boot starts fresh.');
      term.writeln('Confirm with: snapshot clear --yes');
      return;
    }
    await persist.clear();
    term.writeln('Snapshot cleared; next boot will initialize a fresh workspace.');
    void log('WARN', 'snapshot cleared: next boot initializes a fresh workspace');
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
function rebootCmd(ctx: CommandContext): void {
  const { term } = ctx;
  // M4：多实例模式 reboot = 实例级重置（清该实例状态 + 重 boot，不刷新宿主页面）。
  // 同页宿主注入 onInstanceReset（M5 的 SuccinixInstance.restart）；demo 单页单实例路径
  // 缺省回落整页刷新（该 Tab 即该实例，刷新 = 实例级重置）。
  if (rebootMode(ctx.instanceId) === 'instance') {
    term.writeln(`Rebooting instance '${ctx.instanceId}'...`);
    void (ctx.onInstanceReset ? ctx.onInstanceReset() : location.reload());
    return;
  }
  term.writeln('Rebooting Succinix...');
  setTimeout(() => location.reload(), 300);
}

// shutdown：POC 不真关 tab，输出提示即可。多实例模式 = 停当前实例（不动其他实例）。
function shutdownCmd(ctx: CommandContext): void {
  const { term } = ctx;
  if (rebootMode(ctx.instanceId) === 'instance') {
    term.writeln(`Stopping instance '${ctx.instanceId}' (other instances keep running). You can close this tab.`);
    void ctx.onInstanceStop?.();
    return;
  }
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
  // H1 类盲区：等长工作区名切换（如 main→test 同为 4 字符）不改变文件数/总字节，
  // persist 的内容盲签名会跳过自动快照写，重启即回滚 —— 写盘成功后强制落盘一次。
  // 快照失败只记日志，不把已成功的切换报为失败（与 config/motd 的 forcePersist 降级一致）。
  await forcePersist(fs, 'workspace');
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
// 两者都落在容器 FS（/etc/succinix.env、/etc/succinix.settings），随快照持久，重启保留。

// env：查看 / 设置 / 删除环境变量。
//   env              列出全部（key=value 对齐，值可含 =）
//   env <key>        查看单个（不存在显示 not set）
//   env <key>=<val>  设置
//   env -u <key>     删除
async function envCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term, wc } = ctx;
  const inst = ctx.instanceId;
  const prefix = ctx.statePrefix;
  if (args.length === 0) {
    const map = await readEnvFile(wc.fs, inst, prefix);
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
    const removed = await unsetEnvVar(wc.fs, key, inst, prefix);
    term.writeln(removed ? `unset ${key}` : `${key} is not set`);
    return;
  }
  const eq = arg.indexOf('=');
  if (eq === -1) {
    // 查看单个
    const value = await getEnvVar(wc.fs, arg, inst, prefix);
    term.writeln(value !== undefined ? `${arg}=${value}` : `${arg} is not set`);
    return;
  }
  // 设置：按第一个 = 切分，值允许含 =；值含空格时（token 被空白拆开）join 剩余 token，
  // 杜绝静默截断（M2：env FOO=hello world 应存 'hello world'，而不是截断成 'hello'）。
  const key = arg.slice(0, eq);
  const first = arg.slice(eq + 1);
  const restTokens = args.slice(1);
  const value = restTokens.length > 0 ? `${first} ${restTokens.join(' ')}` : first;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    term.writeln(`${RED}env: invalid variable name '${key}'${RESET}`);
    return;
  }
  await setEnvVar(wc.fs, key, value, inst, prefix);
  term.writeln(`set ${key}=${value}`);
}

// settings：查看 / 设置 / 恢复系统设置。
//   settings               列出全部
//   settings <key>         查看
//   settings <key> <val>   设置
//   settings reset <key>   恢复默认
async function settingsCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term, wc } = ctx;
  const inst = ctx.instanceId;
  const prefix = ctx.statePrefix;
  if (args.length === 0) {
    const entries = await listSettings(wc.fs, inst, prefix);
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
    const removed = await resetSetting(wc.fs, key, inst, prefix);
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
    const value = await getSetting(wc.fs, key, inst, prefix);
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
  await setSetting(wc.fs, key, value, inst, prefix);
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

// ─── 服务管理（TASK11）：service 命令族，spawn/ps/kill + 端口注册表的声明式封装 ───
// 定义在 /etc/succinix.services（name|command|port），自启清单在 /etc/succinix.autostart，
// 两者都随快照持久。状态由进程表 + 端口注册表联合判定（services.ts）。

// 单个服务详情：state + pid + port/url（未匹配显示 unknown service）。
async function serviceStatusOne(ctx: CommandContext, svc: ServiceContext, name: string): Promise<void> {
  const { term } = ctx;
  const defs = await readServices(ctx.wc.fs, ctx.instanceId, ctx.statePrefix);
  const def = defs.find((d) => d.name === name);
  if (!def) {
    term.writeln(`${RED}unknown service: ${name}${RESET}`);
    return;
  }
  const st = await getServiceState(svc, def);
  term.writeln(`Service '${name}'`);
  term.writeln(`  state  ${st.state === 'running' ? `${AMBER}${st.state}${RESET}` : st.state}`);
  if (st.pid !== undefined) term.writeln(`  pid    ${st.pid}`);
  if (st.effectivePort !== null) term.writeln(`  port   ${st.effectivePort}${st.url ? `  -> ${st.url}` : ''}`);
}

async function serviceCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const svc: ServiceContext = { wc: ctx.wc, client: ctx.client, ports: ctx.ports, instanceId: ctx.instanceId, statePrefix: ctx.statePrefix };
  const sub = args[0] ?? '';

  if (sub === '') {
    const states = await listServiceStates(svc);
    if (states.length === 0) {
      term.writeln('Services');
      term.writeln('  (none defined)');
      return;
    }
    // 表格对齐：NAME / STATE 按最长值 + 2 空格间隔，running 用暗橙。
    const nameW = Math.max(4, ...states.map((s) => s.def.name.length)) + 2;
    const stateW = Math.max(5, ...states.map((s) => s.state.length)) + 2;
    term.writeln('Services');
    term.writeln('  ' + 'NAME'.padEnd(nameW) + 'STATE'.padEnd(stateW) + 'PORT');
    for (const s of states) {
      const st = s.state === 'running' ? AMBER + s.state.padEnd(stateW) + RESET : s.state.padEnd(stateW);
      const portStr = s.effectivePort !== null ? String(s.effectivePort) : '-';
      term.writeln('  ' + s.def.name.padEnd(nameW) + st + portStr);
    }
    return;
  }

  if (sub === 'start') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service start <name>');
      return;
    }
    const r = await startService(svc, name);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }

  if (sub === 'stop') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service stop <name>');
      return;
    }
    const r = await stopService(svc, name);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }

  if (sub === 'status') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service status <name>');
      return;
    }
    await serviceStatusOne(ctx, svc, name);
    return;
  }

  if (sub === 'enable') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service enable <name>');
      return;
    }
    const defs = await readServices(ctx.wc.fs, ctx.instanceId, ctx.statePrefix);
    if (!defs.some((d) => d.name === name)) {
      term.writeln(`${RED}unknown service: ${name}${RESET}`);
      return;
    }
    const added = await enableAutostart(ctx.wc.fs, name, ctx.instanceId, ctx.statePrefix);
    term.writeln(added ? `service '${name}' enabled (will start on boot)` : `service '${name}' is already enabled`);
    return;
  }

  if (sub === 'disable') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service disable <name>');
      return;
    }
    const removed = await disableAutostart(ctx.wc.fs, name, ctx.instanceId, ctx.statePrefix);
    term.writeln(removed ? `service '${name}' disabled` : `service '${name}' is not enabled`);
    return;
  }

  term.writeln('usage: service | service start <name> | service stop <name> | service status <name> | service enable <name> | service disable <name>');
}

// ─── 日志（TASK12）：log 命令族，读取 /var/log/succinix.log（journald 风格）───
//   log              最近 20 行（默认）
//   log -n <count>   最近 N 行
//   log boot         只看 BOOT 级
//   log clear        清空日志文件
//   log -f           不做（交互 stdin 边界，AGENTS.md）：明确提示改用 log / log -n
const LOG_DEFAULT_LINES = 20;

async function logCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term, wc } = ctx;
  const sub = args[0] ?? '';
  if (sub === '') {
    const lines = await readLog(wc.fs, LOG_DEFAULT_LINES);
    term.writeln(lines ? lines : '(log is empty)');
    return;
  }
  if (sub === '-n') {
    const n = Number(args[1]);
    if (!Number.isInteger(n) || n < 1) {
      term.writeln('usage: log -n <count>');
      return;
    }
    const lines = await readLog(wc.fs, n);
    term.writeln(lines ? lines : '(log is empty)');
    return;
  }
  if (sub === 'boot') {
    const lines = await readBootLog(wc.fs, LOG_DEFAULT_LINES);
    term.writeln(lines ? lines : '(no BOOT entries)');
    return;
  }
  if (sub === 'clear') {
    try {
      await clearLog(wc.fs);
      term.writeln('Log cleared.');
    } catch (e) {
      term.writeln(`${RED}log clear failed: ${String(e)}${RESET}`);
    }
    return;
  }
  if (sub === '-f') {
    term.writeln(`${AMBER}log -f (tail -f) is not supported in this environment; use 'log' or 'log -n <count>'.${RESET}`);
    return;
  }
  term.writeln('usage: log | log -n <count> | log clear | log boot');
}

// ─── 包管理（TASK13）：pkg 命令族，统一 lifo + npm 两通道 ───
// 实现细节在 src/pkg.ts：来源判定（lifo-pkg-<name> 存在 → lifo，否则 npm；同名冲突优先 lifo）、
// 已装列表合并去重、搜索合并。这里只做命令分发与呈现（含真实命令 stdout 尾部回显）。
const PKG_USAGE_LINES = [
  'usage: pkg <command> [args]',
  '  list                   list installed packages (lifo + npm merged, source-annotated)',
  '  search <term>          search packages (lifo search + npm search, merged)',
  '  install <name>         install a package (lifo if lifo-pkg-<name> exists, else npm)',
  '  remove <name>          remove an installed package (via its source channel)',
  '  info <name>            show package info (source / version / description)',
];

async function pkgCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const pctx: PkgContext = { wc: ctx.wc, client: ctx.client };
  const sub = args[0] ?? '';

  if (sub === '' || sub === '--help' || sub === '-h') {
    for (const line of PKG_USAGE_LINES) term.writeln(line);
    return;
  }

  if (sub === 'list') {
    const entries = await listPackages(pctx);
    for (const line of formatPackageList(entries)) term.writeln(line);
    return;
  }

  if (sub === 'search') {
    if (args[1] === '--help' || args[1] === '-h') {
      for (const line of PKG_USAGE_LINES) term.writeln(line);
      return;
    }
    const termName = args.slice(1).join(' ').trim();
    if (!termName) {
      term.writeln('usage: pkg search <term>');
      return;
    }
    const outcome = await searchPackages(pctx, termName);
    for (const line of formatSearchResults(termName, outcome.entries)) term.writeln(line);
    for (const note of outcome.notes) term.writeln(`  ${GRAY}${note}${RESET}`);
    return;
  }

  if (sub === 'install') {
    if (args[1] === '--help' || args[1] === '-h') {
      for (const line of PKG_USAGE_LINES) term.writeln(line);
      return;
    }
    const name = args.slice(1).join(' ').trim();
    if (!name) {
      term.writeln('usage: pkg install <name>');
      return;
    }
    const r = await installPackage(pctx, name);
    if (r.outputTail) term.writeln(`${GRAY}${r.outputTail}${RESET}`);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }

  if (sub === 'remove') {
    if (args[1] === '--help' || args[1] === '-h') {
      for (const line of PKG_USAGE_LINES) term.writeln(line);
      return;
    }
    const name = args.slice(1).join(' ').trim();
    if (!name) {
      term.writeln('usage: pkg remove <name>');
      return;
    }
    const r = await removePackage(pctx, name);
    if (r.outputTail) term.writeln(`${GRAY}${r.outputTail}${RESET}`);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }

  if (sub === 'info') {
    if (args[1] === '--help' || args[1] === '-h') {
      for (const line of PKG_USAGE_LINES) term.writeln(line);
      return;
    }
    const name = args.slice(1).join(' ').trim();
    if (!name) {
      term.writeln('usage: pkg info <name>');
      return;
    }
    const r = await packageInfo(pctx, name);
    if (!r.ok || !r.entry) {
      term.writeln(`${RED}${r.message}${RESET}`);
      return;
    }
    const e = r.entry;
    term.writeln(`Package: ${e.name}`);
    term.writeln(`  source      ${e.source}`);
    term.writeln(`  version     ${e.version}`);
    term.writeln(`  description ${e.description || '--'}`);
    return;
  }

  term.writeln('usage: pkg list | pkg search <term> | pkg install <name> | pkg remove <name> | pkg info <name>');
}

// ─── 网络视图（TASK14）：netstat / ip —— 仅虚拟端口视图，诚实标注 virtual，不编造数据 ───
// 数据源：端口注册表（server-ready 事件，boot.ts 登记）+ 进程表（spawn 的 node 系进程）。
// 关联规则：端口 ↔ 进程——进程表里找命令含端口号（String 匹配）且 running 的进程；匹配不到显示 -。
// 浏览器沙箱无真网卡/真连接（AGENTS.md 边界）：Proto 固定 tcp（虚拟）、State 固定 LISTEN、
// Local Address 用 127.0.0.1:<port>。进程标签是真实命令的诚实摘要，不编造。

// 从进程命令提取简短可读标签：npx <pkg> ... → <pkg>；node 且含 http.createServer → node http server；
// node <script>.js → node <script>.js；其余取命令首词。标签只做摘要，不改写事实。
// TASK16：npx/node 跳过前置 flag（--yes / --watch 等），取第一个非 flag 参数作为包/脚本名。
export function processLabel(cmd: string): string {
  const words = cmd.trim().split(/\s+/);
  const first = words[0] ?? '';
  if (first === 'npx' || first === 'node') {
    const target = words.slice(1).find((w) => !w.startsWith('-'));
    if (first === 'npx') return target || 'npx';
    if (cmd.includes('http.createServer')) return 'node http server';
    if (target && target.endsWith('.js')) return `node ${target}`;
    return target || 'node';
  }
  return first || cmd;
}

// 端口↔进程结构化匹配（TASK16）：拒绝子串误关联（3001↔300/30010）。
// 命中任一即认为该进程与端口相关：
//   --port 3001 / --port=3001 / --port:3001 （后面跟空白或行尾）
//   listen(3001)
//   裸 token 3001（词边界，两侧非 [A-Za-z0-9_]）
export function commandMentionsPort(cmd: string, port: number): boolean {
  const p = String(port);
  const flag = new RegExp(`--port\\s*[=:]?\\s*${p}(?:\\s|$)`);
  const listen = new RegExp(`listen\\(${p}\\)`);
  const token = new RegExp(`(?:^|[^A-Za-z0-9_])${p}(?:[^A-Za-z0-9_]|$)`);
  return flag.test(cmd) || listen.test(cmd) || token.test(cmd);
}

// netstat 表行（导出供自检断言格式：proto / localAddress / state / process）。
export interface NetstatRow {
  proto: string;
  localAddress: string;
  state: string;
  /** 无 -p 时为空串；有 -p 且无匹配进程时为 '-' */
  process: string;
}

// 组装 netstat 行：端口注册表升序；-p 时查询进程表做端口↔进程关联（命令含端口号）。
export async function buildNetstatRows(
  ports: Map<number, string>,
  client: TerminalClient,
  withProcess: boolean
): Promise<NetstatRow[]> {
  let procs: Array<Record<string, unknown>> = [];
  if (withProcess) {
    try {
      const ps = await client.terminal('ps');
      procs = Array.isArray(ps.processes) ? ps.processes : [];
    } catch {
      procs = []; // 进程表不可达：全部按无匹配显示 -
    }
  }
  return [...ports.keys()]
    .sort((a, b) => a - b)
    .map((port) => {
      const found = withProcess
        ? procs.find((p) => p.status === 'running' && commandMentionsPort(String(p.cmd ?? ''), port))
        : undefined;
      return {
        proto: 'tcp',
        localAddress: `127.0.0.1:${port}`,
        state: 'LISTEN',
        process: withProcess
          ? found
            ? `${processLabel(String(found.cmd ?? ''))} (pid ${found.pid})`
            : '-'
          : '',
      };
    });
}

// netstat：列出全部服务端口（虚拟端口视图）。任意参数含 p（-p / -tlnp / -ap）时带进程列。
async function netstatCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const withProcess = args.some((a) => a.includes('p'));
  if (ctx.ports.size === 0) {
    term.writeln('No listening ports');
    return;
  }
  const rows = await buildNetstatRows(ctx.ports, ctx.client, withProcess);
  const protoW = Math.max('Proto'.length, ...rows.map((r) => r.proto.length)) + 2;
  const addrW = Math.max('Local Address'.length, ...rows.map((r) => r.localAddress.length)) + 2;
  const stateW = Math.max('State'.length, ...rows.map((r) => r.state.length)) + 2;
  const line = (proto: string, addr: string, state: string, process = '') =>
    proto.padEnd(protoW) + addr.padEnd(addrW) + state.padEnd(stateW) + process;
  term.writeln(withProcess ? line('Proto', 'Local Address', 'State') + 'Process' : line('Proto', 'Local Address', 'State'));
  for (const r of rows) {
    term.writeln(withProcess ? line(r.proto, r.localAddress, r.state) + r.process : line(r.proto, r.localAddress, r.state));
  }
}

// ip addr：网络身份（浏览器视角）。浏览器沙箱无真网卡（AGENTS.md），lo/eth0 都是虚拟设备——
// 诚实标 virtual，不编造 IP/连接。预览域取首个就绪预览 URL 的 hostname；无就绪端口时
// 回落页面 origin（location.hostname），仍是真实的浏览器来源。
function ipAddrCmd(ctx: CommandContext): void {
  const { term } = ctx;
  const first = ctx.ports.values().next();
  let domain: string;
  try {
    domain = first.done ? location.hostname : new URL(first.value).hostname;
  } catch {
    domain = location.hostname;
  }
  term.writeln('lo: virtual loopback');
  term.writeln(`eth0: ${domain} (virtual)`);
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? (navigator as { platform?: string }).platform;
  if (platform) {
    term.writeln(`${GRAY}(virtual network identity — browser platform: ${platform}, no real interfaces)${RESET}`);
  }
}

async function ipCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === '' || sub === 'addr') {
    ipAddrCmd(ctx);
    return;
  }
  term.writeln(`ip: only the virtual 'addr' view is available (no real network interfaces)`);
}

// ─── 系统信息（TASK15）：uname / motd ───

// uname：诚实数据，不冒充 Linux。内核标识写 js-runtime+webcontainer（保留项），
// 不编造 linux 版本号。架构从 UA 提取（x86_64 / arm64），缺失显示 unknown。
// uname -r 用 @webcontainer/api 运行时版本（浏览器侧拿不到容器 node 版本）。
// R1（TASK17）：版本改为构建期注入——vite.config.ts 的 define 从 node_modules 已安装
// 版本读入，依赖升级后自动跟随，不再硬编码 1.6.4（消除漂移，uname 不输出假数据）。
declare const __UNAME_RUNTIME__: string;

// 架构提取：UA 含 x86_64/amd64/Win64 → x86_64；aarch64/arm64 → arm64；否则 unknown。
export function detectUnameArch(): string {
  const ua = navigator.userAgent;
  if (/x86_64|amd64|Win64/.test(ua)) return 'x86_64';
  if (/aarch64|arm64/i.test(ua)) return 'arm64';
  return 'unknown';
}

// uname -r 的运行时版本（TASK17/R1）：构建期由 vite.config.ts 注入。vitest 环境无该全局
// （vite define 不作用于 vitest），typeof 守卫回落空串 —— 与 version.ts 的 SUCCINIX_VERSION
// 同款模式，让 uname 纯函数在单测里可调用。
const UNAME_RUNTIME: string = typeof __UNAME_RUNTIME__ === 'string' ? __UNAME_RUNTIME__ : '';

interface UnameFields {
  s: string; // 系统名（uname -s）
  n: string; // 主机名（uname -n，与提示符 guest@succinix 一致）
  version: string; // Succinix 版本
  v: string; // 内核标识（uname -v）
  r: string; // 运行时版本（uname -r）
  m: string; // 架构（uname -m）
  o: string; // 操作系统（uname -o）
}

function unameFields(): UnameFields {
  return {
    s: 'Succinix',
    n: 'succinix',
    version: SUCCINIX_VERSION,
    v: 'js-runtime+webcontainer',
    r: UNAME_RUNTIME,
    m: detectUnameArch(),
    o: 'browser-native',
  };
}

// 无参数 uname 摘要行（样例格式：系统名 版本 内核 运行时 架构）。
export function buildUnameLine(): string {
  const f = unameFields();
  return `${f.s} ${f.version} ${f.v} ${f.r} ${f.m}`;
}

// uname -r 输出：@webcontainer/api 运行时版本（R2 自检经命令分发路径断言用）。
export function unameRuntimeVersion(): string {
  return unameFields().r;
}

// uname -a 完整信息：全部字段一行（主机名 + 操作系统并入）。
export function buildUnameAllLine(): string {
  const f = unameFields();
  return `${f.s} ${f.n} ${f.version} ${f.v} ${f.r} ${f.m} ${f.o}`;
}

const UNAME_USAGE = 'usage: uname | uname -a | uname -s | uname -n | uname -r | uname -v | uname -m | uname -o';

// uname 命令族：无参数 → 摘要行；-a → 全部字段；单个/组合短 flag 按标准顺序输出对应字段。
function unameCmd(term: Terminal, args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    term.writeln(UNAME_USAGE);
    return;
  }
  const flags = args.join('').replace(/^-+/, '');
  if (!flags) {
    term.writeln(buildUnameLine());
    return;
  }
  if (flags.includes('a')) {
    term.writeln(buildUnameAllLine());
    return;
  }
  const f = unameFields();
  const order: Array<keyof UnameFields> = ['s', 'n', 'r', 'v', 'm', 'o'];
  const parts: string[] = [];
  for (const ch of order) {
    if (flags.includes(ch)) parts.push(f[ch]);
  }
  if (parts.length === 0) {
    term.writeln(UNAME_USAGE);
    return;
  }
  term.writeln(parts.join(' '));
}

// motd：查看 / 设置 / 恢复登录横幅（/etc/succinix.motd，随快照持久）。
//   motd          查看当前内容
//   motd <text>   设置（多词用空格 join）
//   motd reset    恢复默认
async function motdCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term, wc } = ctx;
  const inst = ctx.instanceId;
  const prefix = ctx.statePrefix;
  const sub = args[0] ?? '';
  if (sub === '') {
    const text = await readMotd(wc.fs, inst, prefix);
    term.writeln(text ?? '(no motd set)');
    return;
  }
  if (sub === 'reset') {
    await resetMotd(wc.fs, inst, prefix);
    term.writeln('motd reset to default');
    return;
  }
  const text = args.join(' ');
  await writeMotd(wc.fs, text, inst, prefix);
  term.writeln(`motd set: ${text}`);
}

// ─── 内置语言运行时（TASK23）：lang 命令 ───
// 列出系统内置语言与版本（系统资产，非用户安装）。python 版本构建期固定；node 实时查询。
async function langCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === 'python' || sub === 'python3') {
    term.writeln(`Python ${PYTHON_BUNDLED_VERSION}`);
    return;
  }
  if (sub === 'node') {
    term.writeln(`Node.js ${await nodeVersion(ctx)}`);
    return;
  }
  if (sub === 'typescript' || sub === 'ts' || sub === 'tsx') {
    term.writeln(`TypeScript ${TS_RUNTIME_NOTE}`);
    return;
  }
  if (sub === '') {
    term.writeln('Built-in language runtimes');
    term.writeln(`  node        Node.js ${await nodeVersion(ctx)}`);
    term.writeln(`  python      Python ${PYTHON_BUNDLED_VERSION}`);
    term.writeln(`  typescript  ${TS_RUNTIME_NOTE}`);
    return;
  }
  term.writeln(`lang: unknown language '${sub}' (known: node, python, typescript)`);
}

// node 版本实时查询（node --version 走 host 路由）；失败显示 --（不阻塞 lang 输出）。
async function nodeVersion(ctx: CommandContext): Promise<string> {
  try {
    const r = await ctx.client.terminal('node --version', undefined, 15000);
    if (r.ok) return String(r.stdout ?? '').trim();
  } catch {
    /* host 不可达：显示 -- */
  }
  return '--';
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
      printPorts(term, ctx.ports, ctx.instanceId);
      return true;
    case 'version':
      term.writeln(VERSION);
      return true;
    case 'whoami':
      term.writeln(ctx.userId ?? 'guest');
      return true;
    case 'pwd': {
      // TASK23：pwd 显示会话 cwd（host 维护，cd 同步后与 node 子进程口径一致）。
      try {
        const r = await ctx.client.terminal('cwd');
        term.writeln(String(r.cwd ?? ''));
      } catch (e) {
        term.writeln(`${RED}${String(e)}${RESET}`);
      }
      return true;
    }
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
      rebootCmd(ctx);
      return true;
    case 'shutdown':
      shutdownCmd(ctx);
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
    case 'service': {
      await serviceCmd(ctx, rest);
      return true;
    }
    case 'log': {
      await logCmd(ctx, rest);
      return true;
    }
    case 'pkg': {
      await pkgCmd(ctx, rest);
      return true;
    }
    case 'netstat': {
      await netstatCmd(ctx, rest);
      return true;
    }
    case 'ip': {
      await ipCmd(ctx, rest);
      return true;
    }
    case 'uname':
      unameCmd(term, rest);
      return true;
    case 'motd': {
      await motdCmd(ctx, rest);
      return true;
    }
    case 'lang': {
      await langCmd(ctx, rest);
      return true;
    }
    default:
      return false;
  }
}
