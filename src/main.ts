// WebUnix 入口：全屏暗橙终端 + 启动画面 + REPL。
// 默认进入终端；URL 带 ?test=1 时自动跑完整系统自检（boot diagnostics）。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { bootWebUnix } from './boot.js';
import { tryHandleLocalCommand, type CommandContext } from './commands.js';
import { runTests } from './tests.js';
import type { ExecResult } from './terminal-client.js';

const AMBER = '\x1b[33m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

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
      if (busy) {
        if (cmd.trim()) queue.push(cmd.trim());
        term.write(`${GRAY}queued: will run after the current command finishes${RESET}\r\n`);
      } else {
        void runCommand(cmd);
      }
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
async function execute(cmd: string): Promise<void> {
  term.write('\r\n'); // 输出前空行分隔，可读性好
  const handled = await tryHandleLocalCommand(ctx, cmd);
  if (handled) return;

  let res: ExecResult;
  try {
    res = await ctx.client.terminal(cmd, undefined, 60000);
  } catch (e) {
    term.write(`${RED}${String(e)}${RESET}`);
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

// ─── 主流程 ───
async function main(): Promise<void> {
  try {
    const services = await bootWebUnix(term);
    ctx = { wc: services.wc, client: services.client, ports: services.ports, term };
    if (testMode) {
      // 自检期间把用户输入排队，避免与断言互相干扰；跑完自动回到终端。
      busy = true;
      await runTests(ctx);
      busy = false;
    }
    const next = queue.shift();
    if (next) {
      void runCommand(next);
    } else {
      prompt();
    }
  } catch (e) {
    term.writeln(`${RED}init failed: ${String(e)}${RESET}`);
    prompt();
  }
}

void main();
