// WebUnix 入口：全屏暗橙终端 + DOM 居中启动覆盖层 + REPL。
// 默认进入终端；URL 带 ?test=1 时在覆盖层日志区自动跑完整系统自检（boot diagnostics）。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { bootWebUnix } from './boot.js';
import { createBootUI, overlayTerminalShim } from './boot-ui.js';
import { tryHandleLocalCommand, type CommandContext } from './commands.js';
import { log } from './log.js';
import { runTests } from './tests.js';
import { saveSnapshot } from './persist.js';
import { getSetting } from './config.js';
import type { ExecResult } from './terminal-client.js';

const AMBER = '\x1b[33m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

// 欢迎横幅：覆盖层淡出后显示在终端里（TASK3 的"启动后进入系统首页"）。
const WELCOME_BANNER =
  `WebUnix 0.1.0 — kernel: JS runtime + WebContainer | userland: Lifo | exec: TerminalExecutor\n` +
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
const promptStr = 'guest@webunix:~$ ';
let line = '';
let busy = false;
const queue: string[] = [];
let ctx: CommandContext;

const testMode = new URLSearchParams(location.search).get('test') === '1';

function prompt(): void {
  term.write('\r\n' + promptStr);
  line = '';
}

// 浏览器侧输入处理：回车执行、Ctrl+L 清屏、Ctrl+C 中断、支持粘贴。
function handleData(data: string): void {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r') {
      term.write('\r\n');
      const cmd = line;
      line = '';
      const trimmed = cmd.trim();
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
        term.write(`^C\r\n${GRAY}running, not interrupted${RESET}\r\n`);
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

  let res: ExecResult;
  try {
    res = await ctx.client.terminal(cmd, undefined, 60000);
  } catch (e) {
    term.write(`${RED}${String(e)}${RESET}`);
    void log('ERROR', `cmd: ${cmd} error: ${String(e)}`);
    return;
  }

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

// 自动快照：每 ~2.5s 保存一次容器 FS 快照到 IndexedDB（persist 内部做"内容变化"去重，
// 文件数/总字节未变就不写 IDB）。另挂 pagehide/beforeunload 兜底：卸载前强制保存一次
// （force=true 跳过内容缓存——等长编辑在关闭时也必须落盘，否则必丢）。
function startAutoSnapshot(ctx: CommandContext): void {
  setInterval(() => {
    void saveSnapshot(ctx.wc.fs).catch((e) => console.warn('[persist] auto snapshot failed:', e));
  }, 2500);
  const flush = () => {
    void saveSnapshot(ctx.wc.fs, true).catch(() => {});
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}

// ─── 主流程 ───
async function main(): Promise<void> {
  const ui = createBootUI();
  try {
    const services = await bootWebUnix(ui);
    // 环境不适配：错误页已在覆盖层内显示，不进终端、不淡出。
    if (!services) return;
    ctx = { wc: services.wc, client: services.client, ports: services.ports, term, fit: () => fitAddon.fit() };

    // 应用持久化设置（TASK10）：font-size 在终端显示前生效（xterm options 动态可改）。
    const fontSizeNum = Number(await getSetting(services.wc.fs, 'font-size'));
    if (Number.isInteger(fontSizeNum) && fontSizeNum >= 8 && fontSizeNum <= 72) {
      term.options.fontSize = fontSizeNum;
    }

    if (testMode) {
      // 自检期间把用户输入排队，避免与断言互相干扰；自检输出走覆盖层日志区。
      busy = true;
      const shim = overlayTerminalShim(ui) as unknown as Terminal;
      try {
        await runTests({ wc: services.wc, client: services.client, ports: services.ports, term: shim });
      } catch (e) {
        // 自检自身异常（非环境问题）：显示 self-test crashed，不误报成 Startup failed。
        shim.writeln(`${RED}[ FAIL ] self-test crashed: ${String(e)}${RESET}`);
      } finally {
        busy = false;
      }
    }

    // boot（及可选自检）完成：淡出覆盖层、显示终端，然后给出欢迎横幅 + 提示符。
    await ui.complete();
    fitAddon.fit();
    term.writeln(WELCOME_BANNER);

    // 持久化主循环：此后每 ~2.5s 自动快照（内容未变不写 IDB）。
    startAutoSnapshot(ctx);

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
