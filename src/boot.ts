// 启动模块：全屏暗橙终端的产品化引导。
// 职责：打印启动画面（ASCII art + 版本 + 浏览器系统信息）、按真实完成时序打印
// systemd 风格启动日志、拉起 WebContainer + host、登记 server-ready 端口注册表。
import { WebContainer } from '@webcontainer/api';
import type { Terminal } from '@xterm/xterm';
import { TerminalClient } from './terminal-client.js';

export interface WebUnixServices {
  wc: WebContainer;
  client: TerminalClient;
  /** 端口注册表：port → 预览 URL（来自 WebContainer 的 server-ready 事件，每次 boot 重建） */
  ports: Map<number, string>;
}

const AMBER = '\x1b[33m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// systemd 风格：暗橙 [  OK  ] 标记 + 默认色消息
function ok(term: Terminal, msg: string): void {
  term.writeln(`${AMBER}[  OK  ]${RESET} ${msg}`);
}

// 灰色 [ .... ] 标记，用于中间过程的过渡说明
function note(term: Terminal, msg: string): void {
  term.writeln(`${GRAY}[ .... ]${RESET} ${msg}`);
}

// ─── 启动画面 ───

// 大号 ASCII art "WebUnix"（figlet ANSI Shadow 风格，自制，暗橙）
const ASCII_ART = [
  '██╗    ██╗███████╗██████╗ ██╗   ██╗███╗   ██╗██╗██╗  ██╗',
  '██║    ██║██╔════╝██╔══██╗██║   ██║████╗  ██║██║╚██╗██╔╝',
  '██║ █╗ ██║█████╗  ██████╔╝██║   ██║██╔██╗ ██║██║ ╚███╔╝ ',
  '██║███╗██║██╔══╝  ██╔══██╗██║   ██║██║╚██╗██║██║ ██╔██╗ ',
  '╚███╔███╔╝███████╗██████╔╝╚██████╔╝██║ ╚████║██║██╔╝ ██╗',
  ' ╚══╝╚══╝ ╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝╚═╝  ╚═╝',
].join('\n');

// 浏览器检测的系统信息：有的写、没有的不写。
export function detectSystemInfo(): string[] {
  const lines: string[] = [];
  const ua = navigator.userAgent;

  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? (navigator as { platform?: string }).platform;
  if (platform) lines.push(`Platform: ${platform}`);

  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome) lines.push(`Browser: Chrome/${chrome[1]}`);
  else {
    const other = /\b(Firefox|Safari|Edg|OPR)\/([\d.]+)/.exec(ua);
    if (other) lines.push(`Browser: ${other[1]}/${other[2]}`);
  }

  if (navigator.hardwareConcurrency) lines.push(`CPU cores: ${navigator.hardwareConcurrency}`);

  const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  if (deviceMemory) lines.push(`Memory: ${deviceMemory} GB`);

  if (navigator.language) lines.push(`Language: ${navigator.language}`);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) lines.push(`Timezone: ${tz}`);

  const { screen } = window;
  if (screen?.width && screen?.height) lines.push(`Screen: ${screen.width}x${screen.height}`);

  return lines;
}

function printSplashHeader(term: Terminal): void {
  term.writeln(`${AMBER}${ASCII_ART}${RESET}`);
  term.writeln(`${AMBER}  WebUnix 0.1.0 — browser-native Linux${RESET}`);
  term.writeln('');
  for (const line of detectSystemInfo()) {
    term.writeln(`  ${line}`);
  }
  term.writeln('');
}

// ─── host 拉起 ───

// host.js 由 Vite 预打包提供（public/host.js）；容器里没有就注入。
async function ensureTerminalHost(
  wc: WebContainer,
  hooks: { onInjected?: () => void; onSpawned?: () => void }
): Promise<TerminalClient> {
  try {
    await wc.fs.readFile('/host.js');
  } catch {
    const src = await (await fetch('/host.js')).text();
    await wc.fs.writeFile('/host.js', src);
    hooks.onInjected?.();
  }
  // host 启动时创建 sandbox：挂载共享文件系统 + 内置 Lifo 内核
  await wc.spawn('node', ['host.js']);
  hooks.onSpawned?.();
  const client = new TerminalClient(wc);
  for (let i = 0; i < 40; i++) {
    try {
      const p = await client.exec('ping', undefined, 2000);
      if (p.kind === 'pong') return client;
    } catch {
      /* host 未就绪 */
    }
    await sleep(300);
  }
  throw new Error('host did not respond');
}

// ─── 主启动流程 ───

export async function bootWebUnix(term: Terminal): Promise<WebUnixServices> {
  printSplashHeader(term);
  const ports = new Map<number, string>();

  term.writeln('  Starting system services...');
  term.writeln('');

  const wc = await WebContainer.boot();
  ok(term, 'Started WebContainer runtime');

  // 浏览器先写一个"项目文件"，证明共享文件系统双向可用（host 挂载点即 /workspace）。
  // 注意：内容与测试套件的字节数断言（TE5=74）绑定，不要随意改动。
  await wc.fs.writeFile('/browser-wrote.txt', 'hello from browser — lifo should see this\nsecond line with LIFO keyword\n');

  // 端口注册表：容器里任何服务就绪都记一笔，并实时打印暗橙预览提示；
  // 进程被杀 / 端口关闭时自动移除（进程表自然清空，每次 boot 重建）。
  wc.on('server-ready', (port, url) => {
    ports.set(port, url);
    term.writeln(`\r\n${AMBER}[preview]${RESET} Port ${port} ready -> ${url}`);
  });
  wc.on('port', (port, type) => {
    if (type === 'close') ports.delete(port);
  });

  const client = await ensureTerminalHost(wc, {
    onInjected: () => note(term, 'host.js missing in container; injected from build artifact'),
    onSpawned: () => {
      ok(term, 'Mounted shared filesystem');
      ok(term, 'Started Lifo kernel');
    },
  });

  // 探活：命令轮询循环就绪，TerminalExecutor 可用
  await client.exec('ping');
  ok(term, 'TerminalExecutor ready');

  // 横幅
  term.writeln('');
  term.writeln(`${AMBER}WebUnix 0.1.0${RESET} — kernel: JS runtime + WebContainer | userland: Lifo | exec: TerminalExecutor`);
  term.writeln(`Type ${GRAY}'help'${RESET} to see available commands.`);
  term.writeln('');

  return { wc, client, ports };
}
