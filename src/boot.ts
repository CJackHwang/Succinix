// 启动模块：浏览器侧引导（业务逻辑，不碰 DOM / xterm）。
// 职责：环境最小必要检测（不适配即错误页退出，不做降级）、填系统信息、按真实完成时序
// systemd 风格启动日志（经 BootUI 渲染到覆盖层）、拉起 WebContainer + host、登记
// server-ready 端口注册表。输出目标由调用方注入的 BootUI 决定（TASK4 呈现层重构）。
import { WebContainer } from '@webcontainer/api';
import type { FileSystemAPI } from '@webcontainer/api';
import type { BootUI } from './boot-ui.js';
import { TerminalClient } from './terminal-client.js';
import { loadSnapshot } from './persist.js';

export interface WebUnixServices {
  wc: WebContainer;
  client: TerminalClient;
  /** 端口注册表：port → 预览 URL（来自 WebContainer 的 server-ready 事件，每次 boot 重建） */
  ports: Map<number, string>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// systemd 风格：暗橙 [  OK  ] 标记 + 默认色消息（渲染到覆盖层日志区）
function ok(ui: BootUI, msg: string): void {
  ui.log(`[  OK  ] ${msg}`, 'ok');
}

// 灰色 [ .... ] 标记，用于中间过程的过渡说明
function note(ui: BootUI, msg: string): void {
  ui.log(`[ .... ] ${msg}`, 'note');
}

// ─── 环境最小必要检测 ───

// 返回不满足条件的英文原因列表；空数组 = 环境可用。任何 WebContainer 操作之前调用。
export function checkEnvironment(): string[] {
  const failures: string[] = [];
  if (window.crossOriginIsolated !== true) {
    failures.push('Cross-origin isolation: not enabled (requires COOP/COEP headers)');
  }
  const ua = navigator.userAgent;
  // 非 Chromium 内核：UA 含 Firefox/Safari 且不含 Chrome/Chromium/Edg
  const isFirefoxOrSafari = /Firefox|Safari/i.test(ua);
  const isChromium = /Chrome|Chromium|Edg/i.test(ua);
  if (isFirefoxOrSafari && !isChromium) {
    const name = /Firefox/i.test(ua) ? 'Firefox' : 'Safari';
    failures.push(`Browser: ${name} is not supported (WebContainers requires Chromium)`);
  }
  return failures;
}

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

// ─── 工作区初始化（TASK7）───

// 默认工作区初始化：恢复快照后调用。/ws/.current 存在 → 报告当前工作区；
// 不存在（全新系统）→ 建 /ws/main/ 并写 .current=main。状态随快照持久，host 零改动。
async function initWorkspace(ui: BootUI, fs: FileSystemAPI): Promise<void> {
  let current: string | null = null;
  try {
    const raw = await fs.readFile('/ws/.current', 'utf8');
    current = raw.trim() || null;
  } catch {
    current = null;
  }
  if (current) {
    ok(ui, `Workspace '${current}'`);
    return;
  }
  try {
    await fs.mkdir('/ws/main', { recursive: true });
    await fs.writeFile('/ws/.current', 'main');
  } catch (e) {
    note(ui, `Default workspace init failed (${String(e).slice(0, 80)})`);
    return;
  }
  ok(ui, `Initialized default workspace 'main'`);
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

// boot 完成信号 = Promise 解析（null 表示环境不适配，错误页已由 ui.fail 显示）。
export async function bootWebUnix(ui: BootUI): Promise<WebUnixServices | null> {
  // 任何 WebContainer 操作之前：最小必要环境检测，不满足直接错误页退出，不做降级/兜底。
  const failures = checkEnvironment();
  if (failures.length > 0) {
    ui.fail(failures);
    return null;
  }

  // 系统信息（浏览器检测）：填覆盖层两列网格
  ui.systemInfo(detectSystemInfo());

  const ports = new Map<number, string>();
  ui.log('Starting system services...', 'info');

  let wc: WebContainer;
  try {
    wc = await WebContainer.boot();
  } catch (e) {
    ui.fail([`WebContainer runtime failed to start: ${String(e)}`]);
    return null;
  }
  ok(ui, 'Started WebContainer runtime');

  // 恢复持久化快照：先于 browser-wrote.txt 写入（那是自检用的测试文件，每次写，不影响恢复）。
  // 恢复必须在 ensureTerminalHost 之前 —— host 挂载的就是恢复后的 FS。
  try {
    const restored = await loadSnapshot(wc.fs);
    if (restored) {
      ok(ui, `Restored workspace from persistent storage (${restored.fileCount} files, ${Math.round(restored.totalBytes / 1024)} KB)`);
    } else {
      ok(ui, 'Initialized fresh workspace');
    }
  } catch (e) {
    note(ui, `Persistent restore failed (${String(e).slice(0, 80)}); continuing with current filesystem`);
    ok(ui, 'Initialized fresh workspace');
  }

  // 工作区状态：快照恢复后 /ws/.current 应已存在（随快照持久）；
  // 全新系统则初始化默认工作区 main。
  await initWorkspace(ui, wc.fs);

  // 浏览器先写一个"项目文件"，证明共享文件系统双向可用（host 挂载点即 /workspace）。
  // 注意：内容与测试套件的字节数断言（TE5=74）绑定，不要随意改动。
  await wc.fs.writeFile('/browser-wrote.txt', 'hello from browser — lifo should see this\nsecond line with LIFO keyword\n');

  // 端口注册表：容器里任何服务就绪都记一笔，进程被杀 / 端口关闭时自动移除。
  // 预览提示行由 main.ts 的 server-ready 监听器打到 xterm（呈现层，不在这里）。
  wc.on('server-ready', (port, url) => {
    ports.set(port, url);
  });
  wc.on('port', (port, type) => {
    if (type === 'close') ports.delete(port);
  });

  const client = await ensureTerminalHost(wc, {
    onInjected: () => note(ui, 'host.js missing in container; injected from build artifact'),
    onSpawned: () => {
      ok(ui, 'Mounted shared filesystem');
      ok(ui, 'Started Lifo kernel');
    },
  });

  // 探活：命令轮询循环就绪，TerminalExecutor 可用
  await client.exec('ping');
  ok(ui, 'TerminalExecutor ready');

  return { wc, client, ports };
}
