// Succinix 入口：全屏暗橙终端 + REPL；boot 日志全程写入终端（无 DOM splash 覆盖层）。
// 默认进入终端；URL 带 ?test=1 时在终端里自动跑完整系统自检（boot diagnostics）。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { bootSuccinix } from './boot.js';
import { createBootUI } from './boot-ui.js';
import { tryHandleLocalCommand, type CommandContext } from './commands.js';
import { tokenize } from './engine/tokenize.js';
import { log } from './log.js';
import { runTests, type TestResult } from './tests.js';
import { saveSnapshot } from './persist.js';
import { getSetting } from './config.js';
import { readMotd } from './motd.js';
import { respawnWithKillFirst } from './host-restart.js';
import { AMBER, RED, GRAY, RESET } from './theme.js';
import { sleep } from './util.js';
import { SUCCINIX_VERSION } from './version.js';
import type { ExecResult } from './engine/index.js';
import { ensurePythonRuntime } from './engine/index.js';

// 欢迎横幅：boot 日志之后显示在终端里（TASK3 的"启动后进入系统首页"）。
// TASK15：默认横幅改由 /etc/succinix.motd 提供（可编辑、随快照持久）；此处仅作
// motd 文件缺失时的兜底。版本号构建期注入（P2-7，随 package.json 单一来源）。
const WELCOME_BANNER =
  `Succinix ${SUCCINIX_VERSION} — kernel: JS runtime + WebContainer | userland: Lifo | exec: TerminalExecutor\n` +
  `Type 'help' to see available commands.`;

// ─── xterm：全屏暗橙终端（JetBrains Mono，暖色暗调色板）───
const term = new Terminal({
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.15,
  cursorBlink: true,
  convertEol: true,
  scrollback: 3000,
  theme: {
    background: '#0a0a0a',
    foreground: '#d6cfc4',
    cursor: '#c2702a',
    cursorAccent: '#0a0a0a',
    selectionBackground: '#3a2a1a',
    selectionForeground: '#ffffff',
    black: '#1a1816',
    red: '#c0543a',
    green: '#7a8a5a',
    yellow: '#c98a2e',
    blue: '#7a8a9a',
    magenta: '#a06f9a',
    cyan: '#6f9a8a',
    white: '#d6cfc4',
    brightBlack: '#6b6560',
    brightRed: '#d96a4e',
    brightGreen: '#9aab72',
    brightYellow: '#dba04a',
    brightBlue: '#8aa0ae',
    brightMagenta: '#b887b0',
    brightCyan: '#86aea0',
    brightWhite: '#efe8dc',
  },
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal')!);
fitAddon.fit();
window.addEventListener('resize', () => fitAddon.fit());

// ─── REPL 状态 ───
const promptStr = 'guest@succinix:~$ ';
let line = '';
let busy = false;
const queue: string[] = [];
// P5-16：命令历史（内存，会话内有效）+ 上下箭头浏览位置。historyIdx 指向当前浏览条目；
// 末尾哨兵 = history.length（新输入，按上箭头回退到最后一条）。
const history: string[] = [];
let historyIdx = -1;
let ctx: CommandContext;
// R1（TASK-BOOTGATE）：boot 门禁 —— boot（含可选 ?test=1 自检）完成前为 false，
// handleData 静默忽略一切输入（不 echo、不排队、不执行）。boot 失败路径不置位（错误页常驻）。
let booted = false;

const testMode = new URLSearchParams(location.search).get('test') === '1';
// TASK18：性能基准模式（scripts/bench.mjs 用 ?bench=1 打开）。与 ?test=1 完全独立：
// 正常走 boot 全流程（无自检），仅多暴露内部句柄 + 记录首提示符时间戳，供 headless Chrome 测量。
const benchMode = new URLSearchParams(location.search).get('bench') === '1';
// TASK19：场景测试驱动模式（scripts/scenarios.mjs 用 ?scenario=1 打开）。与 ?test=1 / ?bench=1
// 独立：正常走 boot 全流程，暴露 window.__succinixScenario 供 headless Chrome 驱动真实命令。
const scenarioMode = new URLSearchParams(location.search).get('scenario') === '1';

// TASK18：bench 模式记录首提示符出现时间（基准脚本读 window.__bootTimes.prompt）。
// 只在 bench 模式下有微小分支开销，正常会话零影响。
function benchMarkPrompt(): void {
  if (!benchMode) return;
  const t = (window as unknown as { __bootTimes?: { prompt: number | null } }).__bootTimes;
  if (t && t.prompt === null) t.prompt = performance.now();
}

function prompt(): void {
  term.write('\r\n' + promptStr);
  line = '';
  benchMarkPrompt();
}

// 浏览器侧输入处理：回车执行、Ctrl+L 清屏、Ctrl+C 中断、支持粘贴。
function handleData(data: string): void {
  // R1：boot 门禁 —— boot（含 ?test=1 自检）完成前静默忽略一切输入。
  // 不 echo、不排队、不显示提示；Ctrl+L/Ctrl+C/退格等控制键一并忽略。
  if (!booted) return;
  // P5-16：完整转义序列 —— xterm 把箭头/Tab 作为单条 data 交付（onData 合并字节）。
  if (data === '\x1b[A') {
    historyNavigate(-1);
    return;
  }
  if (data === '\x1b[B') {
    historyNavigate(1);
    return;
  }
  if (data === '\t' || data === '\x1b[Z') {
    void handleTab();
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
      term.write('\r\n');
      const cmd = line;
      line = '';
      const trimmed = cmd.trim();
      // P5-16：非空命令进历史（busy 排队也一样记录），浏览位置复位到末尾。
      if (trimmed) {
        history.push(cmd);
        historyIdx = history.length;
      }
      if (busy) {
        if (trimmed) {
          queue.push(trimmed);
          term.write(`${GRAY}queued: will run after the current command finishes${RESET}\r\n`);
        }
        return;
      }
      if (!trimmed) {
        // 空命令：只换到下一行提示符，不发 host（否则 host 会回一个 "empty command" 错误）。
        term.write(promptStr);
        return;
      }
      void runCommand(cmd);
      return;
    }
    if (ch === '\u007f' || ch === '\b') {
      if (line.length > 0) {
        line = line.slice(0, -1);
        term.write('\b \b');
      }
      continue;
    }
    if (ch === '\u0003') {
      if (busy) {
        term.write(`^C\r\n`);
        // P5-15/17：Ctrl+C 中断当前命令 + 清空队列。当前命令 settle 后 runCommand 的
        // finally 会回到提示符（队列已清空，不会接续执行被丢弃的命令）。
        void interruptCommand();
      } else {
        term.write('^C\r\n');
        prompt();
      }
      continue;
    }
    if (ch === '\u000c') {
      term.clear();
      term.write(promptStr + line);
      continue;
    }
    if (ch === '\t') continue; // 暂不支持补全
    if (ch >= ' ') {
      line += ch;
      term.write(ch);
    }
  }
}
term.onData(handleData);

// P5-16：上下箭头浏览命令历史。方向 dir：-1=上（旧），+1=下（新）。
// 底部哨兵 = history.length（回到"正在输入的新行"）。重绘时先清当前行再写历史行。
function historyNavigate(dir: -1 | 1): void {
  if (history.length === 0) return;
  const next = historyIdx + dir;
  if (next < 0 || next > history.length) return; // 越界忽略
  historyIdx = next;
  const entry = historyIdx < history.length ? history[historyIdx] ?? '' : '';
  term.write(`\r${promptStr}${' '.repeat(line.length)}\r${promptStr}`);
  line = entry;
  term.write(entry);
}

// 内置命令表（P5-16 Tab 补全候选；与 commands.ts tryHandleLocalCommand 的 case 对齐）。
const BUILTIN_COMMANDS = [
  'help', 'clear', 'sysinfo', 'ports', 'db', 'snapshot', 'free', 'top', 'reboot', 'shutdown',
  'cache', 'workspace', 'env', 'settings', 'service', 'log', 'pkg', 'netstat', 'ip', 'uname',
  'motd', 'lang', 'pwd', 'version', 'whoami',
];

function commonPrefix(xs: string[]): string {
  if (xs.length === 0) return '';
  let p = xs[0];
  for (const x of xs.slice(1)) {
    while (!x.startsWith(p)) p = p.slice(0, -1);
  }
  return p;
}

// P5-16：Tab 补全 —— 首 token 补内置命令名；含 / 的 token 按目录 readdir 补文件路径；
// 无 / 的 token 补根目录条目。唯一命中直接补全，多命中列出 + 共同前缀。
async function handleTab(): Promise<void> {
  const tokens = line.split(/\s+/);
  const token = tokens[tokens.length - 1] ?? '';
  const candidates = new Set<string>();
  if (tokens.length === 1) {
    for (const c of BUILTIN_COMMANDS) candidates.add(c);
  }
  try {
    const hasSlash = token.includes('/');
    const dir = hasSlash ? token.slice(0, token.lastIndexOf('/') + 1) || '/' : '/';
    const entries = await ctx.wc.fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const name = String(e.name);
      const isDir = typeof e.isDirectory === 'function' && e.isDirectory();
      candidates.add((hasSlash ? dir : '') + name + (isDir ? '/' : ''));
    }
  } catch {
    /* 目录不可读：只保留内置命令候选 */
  }
  const matches = [...candidates].filter((c) => c.startsWith(token)).sort();
  if (matches.length === 0) return;
  if (matches.length === 1) {
    const add = matches[0].slice(token.length);
    line += add;
    term.write(add);
    return;
  }
  const common = commonPrefix(matches);
  if (common.length > token.length) {
    const add = common.slice(token.length);
    line += add;
    term.write(add);
    return;
  }
  // 多候选且无共同前缀：列出候选并重绘提示符。
  term.write(`\r\n${matches.join('  ')}\r\n${promptStr}${line}`);
}

// 协议命令（ps/cwd/kill/spawn...）没有 stdout，直接呈现字段。
function printProtocolResponse(res: ExecResult): void {
  if (Array.isArray(res.processes)) {
    term.writeln('PID  STATUS  COMMAND');
    for (const p of res.processes) {
      const row = p as { pid: number; status: string; cmd: string; outputTail?: string };
      const status = row.status === 'running' ? AMBER + 'running' + RESET : GRAY + 'exited' + RESET;
      term.writeln(`${String(row.pid).padEnd(6)}  ${status}  ${row.cmd ?? ''}`);
      if (row.outputTail) {
        term.writeln(`         ${GRAY}output tail: ${row.outputTail.slice(-120)}${RESET}`);
      }
    }
    return;
  }
  if (typeof res.pid === 'number') {
    term.writeln(`started in background (pid=${res.pid}, runtime=${res.runtime ?? '?'})`);
    return;
  }
  if (res.cwd) {
    term.writeln(String(res.cwd));
    return;
  }
  if (res.message) {
    term.writeln(String(res.message));
    return;
  }
  if (res.kind === 'bye') term.writeln('bye');
}

// P2-10：execute / scenarioRun 的共享核心 —— python 预注入 + client.terminal RPC 调用。
// 浏览器侧拦截（tryHandleLocalCommand）留在各调用方（两者语义不同：execute 写终端 + 记日志，
// scenarioRun 捕获进 lines）。phase 区分 python 资产注入失败与 RPC 失败（execute 的日志文案不同）。
type HostRpcOutcome = { res: ExecResult } | { error: string; phase: 'python' | 'rpc' };

async function callHostRpc(ctx: CommandContext, cmd: string, timeoutMs: number): Promise<HostRpcOutcome> {
  // TASK27：python/pip 命令（含链中段，如 `echo hi && python -c ...`）首用前懒注入运行时资产。
  // 宽松触发（tokenize 后任一 token 为 python/python3/pip/pip3）——注入幂等，~13MB 仅一次。
  if (tokenize(cmd.trim()).some((t) => t === 'python' || t === 'python3' || t === 'pip' || t === 'pip3')) {
    try {
      await ensurePythonRuntime(ctx.wc);
    } catch (e) {
      return { error: String(e), phase: 'python' };
    }
  }
  try {
    return { res: await ctx.client.terminal(cmd, undefined, timeoutMs) };
  } catch (e) {
    return { error: String(e), phase: 'rpc' };
  }
}

// 执行一条命令：浏览器侧拦截 → 否则发 host；输出前空行分隔，stderr 红色，exit≠0 灰色标注。
// TASK12：本地命令记录 runtime=browser（log clear 除外：它清空日志文件，记录会破坏"清空后为空"语义）；
// host 命令由 TerminalClient 记录；exec 异常 / host 掉线记 ERROR。
async function execute(cmd: string): Promise<void> {
  term.write('\r\n'); // 输出前空行分隔，可读性好
  let handled: boolean;
  try {
    handled = await tryHandleLocalCommand(ctx, cmd);
  } catch (e) {
    term.write(`${RED}${String(e)}${RESET}`);
    void log('ERROR', `cmd: ${cmd} error: ${String(e)}`);
    return;
  }
  if (handled) {
    if (!/^log\s+clear\b/.test(cmd.trim())) {
      void log('INFO', `cmd: ${cmd} exit=0 runtime=browser`);
    }
    return;
  }

  const rpc = await callHostRpc(ctx, cmd, 60000);
  if ('error' in rpc) {
    term.write(`${RED}${rpc.error}${RESET}`);
    void log(
      'ERROR',
      rpc.phase === 'python' ? `cmd: ${cmd} python asset inject failed: ${rpc.error}` : `cmd: ${cmd} error: ${rpc.error}`
    );
    return;
  }
  const res = rpc.res;

  // 协议命令响应直接呈现
  if (Array.isArray(res.processes) || typeof res.pid === 'number' || res.cwd || res.message || res.kind) {
    printProtocolResponse(res);
    return;
  }

  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  if (stdout) term.write(stdout);
  if (stderr) {
    if (stdout && !stdout.endsWith('\n')) term.write('\r\n');
    term.write(`${RED}${stderr}${RESET}`);
  }
  const code = res.exitCode;
  if (res.ok === false && typeof code === 'number' && code !== 0) {
    if ((stdout || stderr) && !(stderr || '').endsWith('\n')) term.write('\r\n');
    term.write(`${GRAY}[exit ${code}]${RESET}`);
  }
  // TASK3 修复：stdout/stderr 均空但 error 存在时显示 error，杜绝静默失败
  // （如 host 的 { ok:false, error } 协议响应、spawn 的非 node 拒绝、unknown command 等）。
  if (res.ok === false && !stdout && !stderr && res.error) {
    term.write(`${RED}${String(res.error)}${RESET}`);
  }
}

// TASK19：场景测试驱动 —— 与 execute() 相同分发路径（浏览器侧拦截 → 否则 host RPC），
// 但输出改为结构化捕获（capture-term shim），供 scripts/scenarios.mjs 做真实断言。
// 命令形态：browser-side 命令（db/service/workspace/snapshot...）经 tryHandleLocalCommand，
// 输出收集进 lines；host 命令（node/npm/lifo/ps...）走 client.terminal，返回 stdout/stderr。
// timeoutMs 仅约束 host 命令的 RPC 等待；browser-side 命令自带长超时（如 db start 的 install）。
async function scenarioRun(ctx: CommandContext, cmd: string, timeoutMs = 60000): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const shim = {
    writeln: (l: unknown) => void lines.push(String(l)),
    write: (d: unknown) => void lines.push(String(d)),
    clear: () => {},
  } as unknown as Terminal;
  let handled: boolean;
  try {
    handled = await tryHandleLocalCommand({ ...ctx, term: shim }, cmd);
  } catch (e) {
    return { handled: true, ok: false, error: String(e), output: lines.join('\n'), lines };
  }
  if (handled) {
    return { handled: true, ok: true, output: lines.join('\n'), lines };
  }
  const rpc = await callHostRpc(ctx, cmd, timeoutMs);
  if ('error' in rpc) {
    // python 注入失败 / RPC 失败都按 thrown 处理（与旧实现一致：二者原在同一 try 内）。
    return { handled: false, ok: false, error: rpc.error, thrown: true };
  }
  const res = rpc.res;
  return {
    handled: false,
    ok: res.ok,
    exitCode: res.exitCode,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
    runtime: res.runtime,
    error: res.error,
    message: res.message,
    pid: res.pid,
    processes: res.processes,
    killed: res.killed,
    kind: res.kind,
  };
}

async function runCommand(cmd: string): Promise<void> {
  busy = true;
  try {
    await execute(cmd);
  } finally {
    busy = false;
    const next = queue.shift();
    if (next) {
      void runCommand(next);
    } else {
      prompt();
    }
  }
}

// P5-15/17：busy 时 Ctrl+C —— 向 host 发 interrupt（杀掉当前 node run 子进程）并清空队列。
// 清空先做：之后 runCommand 的 finally 从空队列 shift 不到命令 → 回到提示符。
// 中断只对 node run 子进程生效；Lifo 沙箱无 abort API、后台 spawn 服务不被误杀（如实提示）。
async function interruptCommand(): Promise<void> {
  const discarded = queue.length;
  queue.length = 0;
  if (discarded > 0) term.write(`${GRAY}queued commands discarded (${discarded})${RESET}\r\n`);
  const res = await ctx.client.interruptDirect();
  if (res && typeof res.pid === 'number') {
    term.write(`${GRAY}interrupting command (pid=${res.pid})...${RESET}\r\n`);
  } else if (res) {
    term.write(`${GRAY}no running node command to interrupt; waiting for the current command to finish${RESET}\r\n`);
  } else {
    term.write(`${GRAY}could not send interrupt (channel busy); waiting for the current command to finish${RESET}\r\n`);
  }
}

// 自动快照：每 ~2.5s 保存一次容器 FS 快照到 IndexedDB（persist 内部做"内容变化"去重，
// 文件数/总字节未变就不写 IDB）。另挂 pagehide/beforeunload 兜底：卸载前强制保存一次
// （force=true 跳过内容缓存——等长编辑在关闭时也必须落盘，否则必丢）。
// P4-13：空闲退避 —— saveSnapshot 返回 reason='changed'（真实内容/结构变化）时复位 2.5s；
// 否则（dedup/age 等）连续空闲拉长到 5s/10s/15s（首个间隔后每 2 tick 翻倍、上限 15s）。
// P0-1 的最大年龄强制（30s）在 persist 内部兜底等长编辑，与退避解耦：即使用户等长编辑后
// 空闲，也会在 30s 内被年龄强制写盘。
const AUTO_SNAPSHOT_BASE_MS = 2500;
const AUTO_SNAPSHOT_MAX_MS = 15000;

function startAutoSnapshot(ctx: CommandContext): void {
  let interval = AUTO_SNAPSHOT_BASE_MS;
  let idleTicks = 0;
  const tick = async () => {
    try {
      const r = await saveSnapshot(ctx.wc.fs);
      if (r.reason === 'changed') {
        idleTicks = 0;
        interval = AUTO_SNAPSHOT_BASE_MS; // 有真实变化：恢复灵敏
      } else {
        idleTicks++;
        if (idleTicks >= 2) interval = Math.min(interval * 2, AUTO_SNAPSHOT_MAX_MS); // 空闲退避
      }
    } catch (e) {
      console.warn('[persist] auto snapshot failed:', e);
    }
    setTimeout(tick, interval); // 句柄不保留：定时器自持闭包，随页面卸载由 pagehide flush 兜底
  };
  setTimeout(tick, AUTO_SNAPSHOT_BASE_MS);
  const flush = () => {
    void saveSnapshot(ctx.wc.fs, true).catch(() => {});
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}

// TASK16 稳定性：host 失联自动重启。
// 每 30s ping 一次，连续 2 次失败视为 host 掉线 → 重新注入 host.js + spawn（WARN 日志）。
// 新 host 的进程表是全新内存表（孤儿进程不在此表内），重启后 ps 干净。
// r4 B 时效边界：ping 走 pingDirect 绕过 exec 互斥队列——长命令（node 子进程等结果期间）
// 排队不再阻塞探活。通道忙（有排队未启动请求 / 刚写入在途请求）时本轮跳过（中性，不计成败）；
// 超时取 30s 以覆盖 host 处理长 Lifo 命令（≤25s）的繁忙窗口，避免繁忙误判为掉线。
function startHostWatchdog(ctx: CommandContext): void {
  let consecutiveFailures = 0;
  let probing = false; // 上一轮探活未完成（长超时）时跳过本轮，避免重叠
  setInterval(async () => {
    if (probing) return;
    probing = true;
    try {
      const p = await ctx.client.pingDirect(30000);
      if (p === true) {
        consecutiveFailures = 0;
        return;
      }
      if (p === false) {
        consecutiveFailures++;
        if (consecutiveFailures >= 2) {
          consecutiveFailures = 0;
          void restartHost(ctx);
        }
        return;
      }
      // p === null：通道忙（队列未消化 / 刚写入在途请求），中性：不计成败。
    } finally {
      probing = false;
    }
  }, 30000);
}

// 重新注入 host.js（容器内缺失时从构建产物拉取）并 spawn 新 host，等待 ping 就绪。
// TASK18 双 host 竞态修复：spawn 新 host 前先 kill 旧 host 进程。否则旧 host（挂死但进程仍在）
// 会与新 host 同时轮询 /cmd.json —— 两个 host 都读请求、都写结果文件，命令结果不确定。
async function restartHost(ctx: CommandContext): Promise<void> {
  const { term } = ctx;
  try {
    term.writeln(`${AMBER}[ WARN ] host unresponsive — re-injecting host.js and respawning${RESET}`);
    void log('WARN', 'host unresponsive — re-injecting host.js and respawning');
    try {
      await ctx.wc.fs.readFile('/host.js');
    } catch {
      const src = await (await fetch('/host.js')).text();
      await ctx.wc.fs.writeFile('/host.js', src);
    }
    // TASK18：lifo-core.js 同 host.js 一起确保存在（host 首个 Lifo 命令动态 import 需要）；
    // 异步写入不阻塞重启就绪等待（ping 不需要 Lifo 内核）。
    try {
      await ctx.wc.fs.readFile('/lifo-core.js');
    } catch {
      const src = await (await fetch('/lifo-core.js')).text();
      void ctx.wc.fs.writeFile('/lifo-core.js', src).catch(() => {});
    }
    // kill 旧 host：避免新旧两个 host 同时轮询 cmd.json（见上注释）。
    // 若旧 host 已崩溃 kill 是 no-op；若只是挂死则真正终止，保证单 host 不变量。
    // TASK19：kill-before-spawn 提取为可测的 respawnWithKillFirst（自检直接断言顺序）。
    ctx.hostProc = await respawnWithKillFirst(
      () => {
        try {
          ctx.hostProc?.kill();
        } catch {
          /* 旧 host 句柄失效：忽略，spawn 新 host 继续 */
        }
      },
      () => ctx.wc.spawn('node', ['host.js'])
    );
    // 等待新 host 就绪：TerminalClient 的 exec 自动指向新 host。
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const p = await ctx.client.exec('ping', undefined, 2000);
        if (p.kind === 'pong') {
          ready = true;
          break;
        }
      } catch {
        /* host 尚未就绪 */
      }
      await sleep(100); // TASK18：与 boot 的 waitForHostReady 对齐，300→100ms
    }
    if (ready) {
      term.writeln(`${AMBER}[  OK  ] host respawned — process table is clean${RESET}`);
      void log('WARN', 'host respawned; process table is fresh');
    } else {
      term.writeln(`${RED}[ FAIL ] host respawn did not become ready${RESET}`);
      void log('ERROR', 'host respawn did not become ready');
    }
  } catch (e) {
    term.writeln(`${RED}[ FAIL ] host restart failed: ${String(e)}${RESET}`);
    void log('ERROR', `host restart failed: ${String(e)}`);
  }
}

// ─── 主流程 ───
async function main(): Promise<void> {
  const ui = createBootUI(term);
  try {
    const services = await bootSuccinix(ui);
    // 环境不适配：错误页已在覆盖层内显示，不进终端、不淡出。
    if (!services) return;
    ctx = { wc: services.wc, client: services.client, ports: services.ports, term, fit: () => fitAddon.fit(), hostProc: services.hostProc };

    // TASK18：?bench=1 时暴露内部句柄（RPC 客户端 / 容器 FS / 终端 / 快照）供 scripts/bench.mjs
    // 测量命令往返、快照开销、大输出；正常会话不暴露任何内部对象。
    if (benchMode) {
      (window as unknown as { __succinixBench?: unknown }).__succinixBench = {
        client: ctx.client,
        wc: ctx.wc,
        term,
        saveSnapshot,
      };
    }

    // TASK19：?scenario=1 时暴露场景驱动句柄（scripts/scenarios.mjs 用）。与 bench 句柄独立：
    // run() 走与 execute() 相同的分发路径（browser 拦截 → host RPC），是真实命令执行的驱动面。
    if (scenarioMode) {
      (window as unknown as { __succinixScenario?: unknown }).__succinixScenario = {
        booted: true,
        client: ctx.client,
        wc: ctx.wc,
        ports: ctx.ports,
        term,
        saveSnapshot,
        run: (cmd: string, timeoutMs?: number) => scenarioRun(ctx, cmd, timeoutMs),
      };
    }

    // 应用持久化设置（TASK10）：font-size 在终端显示前生效（xterm options 动态可改）。
    const fontSizeNum = Number(await getSetting(services.wc.fs, 'font-size'));
    if (Number.isInteger(fontSizeNum) && fontSizeNum >= 8 && fontSizeNum <= 72) {
      term.options.fontSize = fontSizeNum;
    }

    let testResult: TestResult | null = null;
    let testCrashed = '';
    if (testMode) {
      // 自检期间把用户输入排队，避免与断言互相干扰；自检输出直接写终端。
      busy = true;
      try {
        testResult = await runTests({ wc: services.wc, client: services.client, ports: services.ports, term });
      } catch (e) {
        // 自检自身异常（非环境问题）：显示 self-test crashed，不误报成 Startup failed。
        testCrashed = String(e);
        term.writeln(`${RED}[ FAIL ] self-test crashed: ${String(e)}${RESET}`);
      } finally {
        busy = false;
      }
    }

    // boot（及可选自检）完成：移除错误页 DOM（终端全程可见），然后打印登录横幅（motd）+ 提示符。
    await ui.complete();
    fitAddon.fit();

    // TASK16：自检结果进终端（complete() 之后、motd 横幅之前）——结果留在滚动历史可回溯。
    // 失败 >0 时暗红显示失败行；全绿只打印 summary 行。
    if (testResult) {
      const summary = `Self-test result: ${testResult.pass} passed, ${testResult.fail} failed, ${testResult.skip} skipped`;
      if (testResult.fail > 0) {
        term.writeln(`${RED}${summary}${RESET}`);
        for (const f of testResult.failures) {
          term.writeln(`${RED}  [ FAIL ] ${f}${RESET}`);
        }
      } else {
        term.writeln(`${AMBER}${summary}${RESET}`);
      }
      // TASK-BOOTUI：自检输出全程走终端（canvas 无法经 DOM 读文本），把结果暴露到
      // window.__succinixResult，供 scripts/verify-deploy.mjs 的 CDP 轮询读取（?test=1）。
      (window as unknown as { __succinixResult?: { passed: number; failed: number; skipped: number; fails: string[] } }).__succinixResult = {
        passed: testResult.pass,
        failed: testResult.fail,
        skipped: testResult.skip,
        fails: testResult.failures,
      };
    } else if (testCrashed) {
      term.writeln(`${RED}[ FAIL ] self-test crashed: ${testCrashed}${RESET}`);
    }

    // R1：boot（及可选自检）完成，解锁输入。置于 motd + 提示符输出之前：
    // ?test=1 模式下在自检结果输出后、motd 前；失败路径（catch → ui.fail）不置位。
    booted = true;

    const motdText = await readMotd(services.wc.fs);
    if (motdText) {
      for (const line of motdText.split(/\r?\n/)) term.writeln(line);
    } else {
      term.writeln(WELCOME_BANNER); // 兜底：motd 文件缺失时保留旧欢迎行
    }

    // 持久化主循环：此后每 ~2.5s 自动快照（内容未变不写 IDB）。
    startAutoSnapshot(ctx);

    // TASK16 稳定性：host 失联自动重启（每 30s ping，连续 2 次失败重新注入+spawn）。
    startHostWatchdog(ctx);

    // 容器里任何服务就绪都实时打印暗橙预览提示（覆盖层已移除，走终端）。
    services.wc.on('server-ready', (port, url) => {
      term.writeln(`\r\n${AMBER}[preview]${RESET} Port ${port} ready -> ${url}`);
    });

    const next = queue.shift();
    if (next) {
      void runCommand(next);
    } else {
      prompt();
    }
  } catch (e) {
    // 启动期异常（host 未就绪等）：在覆盖层内显示错误页并停留。
    ui.fail([`Startup failed: ${String(e)}`], {
      header: 'Startup failed',
      footer: 'Check the browser console for the underlying error.',
    });
  }
}

void main();
