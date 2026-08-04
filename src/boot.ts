// 启动模块：全屏黑终端的产品化引导。
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

const GREEN = '\x1b[32m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// systemd 风格：绿色 [  OK  ] 标记 + 默认色消息
function ok(term: Terminal, msg: string): void {
  term.writeln(`${GREEN}[  OK  ]${RESET} ${msg}`);
}

// 灰色 [ .... ] 标记，用于中间过程的过渡说明
function note(term: Terminal, msg: string): void {
  term.writeln(`${GRAY}[ .... ]${RESET} ${msg}`);
}

// ─── 启动画面 ───

// 大号 ASCII art "WebUnix"（figlet ANSI Shadow 风格，自制，绿色）
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
  if (platform) lines.push(`平台: ${platform}`);

  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome) lines.push(`浏览器: Chrome/${chrome[1]}`);
  else {
    const other = /\b(Firefox|Safari|Edg|OPR)\/([\d.]+)/.exec(ua);
    if (other) lines.push(`浏览器: ${other[1]}/${other[2]}`);
  }

  if (navigator.hardwareConcurrency) lines.push(`CPU 核数: ${navigator.hardwareConcurrency}`);

  const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  if (deviceMemory) lines.push(`内存: ${deviceMemory} GB`);

  if (navigator.language) lines.push(`语言: ${navigator.language}`);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) lines.push(`时区: ${tz}`);

  const { screen } = window;
  if (screen?.width && screen?.height) lines.push(`屏幕: ${screen.width}×${screen.height}`);

  return lines;
}

function printSplashHeader(term: Terminal): void {
  term.writeln(`${GREEN}${ASCII_ART}${RESET}`);
  term.writeln(`${GREEN}  WebUnix 0.1.0 — browser-native Linux${RESET}`);
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
  throw new Error('host 无响应');
}

// ─── 主启动流程 ───

export async function bootWebUnix(term: Terminal): Promise<WebUnixServices> {
  printSplashHeader(term);
  const ports = new Map<number, string>();

  term.writeln('  启动系统服务…');
  term.writeln('');

  const wc = await WebContainer.boot();
  ok(term, 'Started WebContainer runtime');

  // 浏览器先写一个"项目文件"，证明共享文件系统双向可用（host 挂载点即 /workspace）。
  // 注意：内容与测试套件的字节数断言（TE5=74）绑定，不要随意改动。
  await wc.fs.writeFile('/browser-wrote.txt', 'hello from browser — lifo should see this\nsecond line with LIFO keyword\n');

  // 端口注册表：容器里任何服务就绪都记一笔，并实时打印绿色预览提示；
  // 进程被杀 / 端口关闭时自动移除（进程表自然清空，每次 boot 重建）。
  wc.on('server-ready', (port, url) => {
    ports.set(port, url);
    term.writeln(`\r\n${GREEN}[preview]${RESET} 端口 ${port} 就绪 → ${url}`);
  });
  wc.on('port', (port, type) => {
    if (type === 'close') ports.delete(port);
  });

  const client = await ensureTerminalHost(wc, {
    onInjected: () => note(term, 'host.js 不存在，已从构建产物注入'),
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
  term.writeln(`${GREEN}WebUnix 0.1.0${RESET} (kernel: JS runtime + WebContainer; userland: Lifo; exec: TerminalExecutor)`);
  term.writeln(`Type ${GRAY}'help'${RESET} to see available commands.`);
  term.writeln('');

  return { wc, client, ports };
}
