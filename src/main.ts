// WebUnix 入口：全屏黑终端 + 启动画面 + REPL。
// 默认进入终端；URL 带 ?test=1 时自动跑测试套件。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { bootWebUnix } from './boot.js';
import { tryHandleLocalCommand, type CommandContext } from './commands.js';
import { runTests } from './tests.js';
import type { ExecResult } from './terminal-client.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

// ─── xterm：全屏黑色终端 ───
const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
  fontSize: 14,
  lineHeight: 1.15,
  cursorBlink: true,
  convertEol: true,
  scrollback: 3000,
  theme: {
    background: '#000000',
    foreground: '#c9d6c9',
    cursor: '#4af626',
    cursorAccent: '#000000',
    selectionBackground: '#1e3a1e',
    selectionForeground: '#ffffff',
    green: '#4af626',
    red: '#f66',
    brightGreen: '#5af632',
    brightRed: '#ff7b72',
    brightBlack: '#5c6a5c',
    white: '#c9d6c9',
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
        term.write(`${GRAY}（已排队，上一条执行完自动运行）${RESET}\r\n`);
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
        term.write(`^C\r\n${GRAY}（正在执行，不中断）${RESET}\r\n`);
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

// 协议命令（ps/cwd/kill/spawn…）没有 stdout，直接呈现字段。
function printProtocolResponse(res: ExecResult): void {
  if (Array.isArray(res.processes)) {
    term.writeln('PID\t状态\t命令');
    for (const p of res.processes) {
      const row = p as { pid: number; status: string; cmd: string; outputTail?: string };
      const status = row.status === 'running' ? `${GREEN}运行中${RESET}` : `${GRAY}已退出${RESET}`;
      term.writeln(`${String(row.pid).padEnd(8)}  ${status}  ${row.cmd ?? ''}`);
      if (row.outputTail) {
        term.writeln(`         ${GRAY}输出尾部: ${row.outputTail.slice(-120)}${RESET}`);
      }
    }
    return;
  }
  if (typeof res.pid === 'number') {
    term.writeln(`已后台启动（pid=${res.pid}，runtime=${res.runtime ?? '?'}）`);
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
      // 测试期间把用户输入排队，避免与断言互相干扰
      busy = true;
      const { pass, fail } = await runTests(ctx);
      busy = false;
      term.writeln(`\n${GREEN}完成 — PASS ${pass} / FAIL ${fail}${RESET}`);
    }
    const next = queue.shift();
    if (next) {
      void runCommand(next);
    } else {
      prompt();
    }
  } catch (e) {
    term.writeln(`${RED}❌ 初始化失败：${String(e)}${RESET}`);
    prompt();
  }
}

void main();
