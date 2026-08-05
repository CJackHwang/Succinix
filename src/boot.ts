// 启动模块：浏览器侧引导（业务逻辑，不碰 DOM / xterm）。
// 职责：环境最小必要检测（不适配即错误页退出，不做降级）、填系统信息、按真实完成时序
// systemd 风格启动日志（经 BootUI 渲染到覆盖层）、拉起 WebContainer + host、登记
// server-ready 端口注册表。输出目标由调用方注入的 BootUI 决定（TASK4 呈现层重构）。
import { WebContainer, type FileSystemAPI, type WebContainerProcess } from '@webcontainer/api';
import type { BootUI } from './boot-ui.js';
import { TerminalClient } from './terminal-client.js';
import { loadSnapshot } from './persist.js';
import { getSetting, readEnvFile, isValidWorkspaceName } from './config.js';
import { ensureServicesFiles, readAutostart, startService } from './services.js';
import { initLogger, log } from './log.js';
import { ensureMotd } from './motd.js';

export interface WebUnixServices {
  wc: WebContainer;
  client: TerminalClient;
  /** 端口注册表：port → 预览 URL（来自 WebContainer 的 server-ready 事件，每次 boot 重建） */
  ports: Map<number, string>;
  /** 当前 host 进程句柄（main.ts 的 host 重启路径用 kill 清理旧进程，防双 host 竞态） */
  hostProc: WebContainerProcess;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// TASK18：bench 模式记录 boot 阶段时间戳（window.__bootTimes.phases 由 scripts/bench.mjs 的
// 注入脚本创建）。正常会话无该对象，函数为 no-op —— 仅一次 window 读的微小开销。
function bootPhase(name: string): void {
  const t = (window as unknown as { __bootTimes?: { phases?: Record<string, number> } }).__bootTimes;
  if (t && t.phases) t.phases[name] = performance.now();
}

// systemd 风格：暗橙 [  OK  ] 标记 + 默认色消息（渲染到覆盖层日志区）。
// TASK12：同步写 BOOT 级日志到 /var/log/webunix.log（initLogger 之后生效；之前为 no-op）。
function ok(ui: BootUI, msg: string): void {
  ui.log(`[  OK  ] ${msg}`, 'ok');
  void log('BOOT', msg);
}

// 灰色 [ .... ] 标记，用于中间过程的过渡说明
function note(ui: BootUI, msg: string): void {
  ui.log(`[ .... ] ${msg}`, 'note');
  void log('BOOT', msg);
}

// ─── 环境最小必要检测 ───

// 返回不满足条件的英文原因列表；空数组 = 环境可用。任何 WebContainer 操作之前调用。
export function checkEnvironment(): string[] {
  const failures: string[] = [];
  if (window.crossOriginIsolated !== true) {
    failures.push('Cross-origin isolation: not enabled (requires COOP/COEP headers)');
  }
  const ua = navigator.userAgent;
  // 非 Chromium 内核：UA 含 Firefox/Safari 且不含 Chrome/Chromium/Edg/CriOS。
  // CriOS = Chrome on iOS（UA 同时含 Safari 标记，若不特判会被误报为 Safari）。
  const isFirefoxOrSafari = /Firefox|Safari/i.test(ua);
  const isChromium = /Chrome|Chromium|Edg|CriOS/i.test(ua);
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

  // Edge/Opera 的 UA 同时含 "Chrome/xx" 标记，必须先查 Edg/OPR 再回落 Chrome，
  // 否则会被误报为 Chrome（sysinfo/启动画面品牌失真）。
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) lines.push(`Browser: Edge/${edge[1]}`);
  else {
    const opera = /OPR\/([\d.]+)/.exec(ua);
    if (opera) lines.push(`Browser: Opera/${opera[1]}`);
    else {
      const chrome = /Chrome\/([\d.]+)/.exec(ua);
      if (chrome) lines.push(`Browser: Chrome/${chrome[1]}`);
      else {
        const other = /\b(Firefox|Safari)\/([\d.]+)/.exec(ua);
        if (other) lines.push(`Browser: ${other[1]}/${other[2]}`);
      }
    }
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
// 不存在（全新系统）→ 用配置的默认工作区名建目录并写 .current，状态随快照持久，host 零改动。
async function initWorkspace(ui: BootUI, fs: FileSystemAPI, defaultWorkspace: string): Promise<void> {
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
    await fs.mkdir(`/ws/${defaultWorkspace}`, { recursive: true });
    await fs.writeFile('/ws/.current', defaultWorkspace);
  } catch (e) {
    note(ui, `Default workspace init failed (${String(e).slice(0, 80)})`);
    return;
  }
  ok(ui, `Initialized default workspace '${defaultWorkspace}'`);
}

// ─── host 拉起 ───

// host.js（轻量主进程）由 Vite 预打包提供（public/host.js）；lifo-core.js（Lifo 内核，~1MB）
// 由 public/lifo-core.js 提供，host 首个 Lifo 命令时动态 import。
// TASK18：注入 + spawn 只负责把 host 进程拉起来，**不等就绪**（就绪由 waitForHostReady 负责）。
// lifo-core.js 在 host spawn **之后**异步写入 —— host 启动不依赖它（ping/ps/kill/node 命令
// 都不碰 Lifo 内核），把 ~1MB 写入从 boot 关键路径上消除。
async function ensureTerminalHost(
  wc: WebContainer,
  hooks: { hostSrc?: string | null; lifoCoreSrc?: string | null; onInjected?: () => void; onSpawned?: () => void }
): Promise<{ client: TerminalClient; hostProc: WebContainerProcess }> {
  try {
    await wc.fs.readFile('/host.js');
  } catch {
    // hostSrc 由调用方在 WebContainer.boot() 并行预取（消除网络等待在关键路径上）；
    // 预取失败（网络异常）时兜底再 fetch 一次。
    const src = hooks.hostSrc ?? (await (await fetch('/host.js')).text());
    await wc.fs.writeFile('/host.js', src);
    hooks.onInjected?.();
  }
  // host 启动：轻量 bundle 解析快，立即注册轮询循环（Lifo 内核另行懒加载）。
  const hostProc = await wc.spawn('node', ['host.js']);
  hooks.onSpawned?.();
  // lifo-core.js 异步写入（不进 boot 关键路径）：host 首个 Lifo 命令时才需要；
  // 写入失败时 host 侧 getSandbox 会重试（容器已有该文件则跳过）。随快照排除（persist）。
  if (hooks.lifoCoreSrc) {
    void wc.fs.writeFile('/lifo-core.js', hooks.lifoCoreSrc).catch(() => {});
  }
  return { client: new TerminalClient(wc), hostProc };
}

// 等 host 就绪：命令轮询循环可响应。TASK18：重试间隔 300ms → 100ms，减少"已就绪却多等"的空转。
async function waitForHostReady(client: TerminalClient): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const p = await client.exec('ping', undefined, 2000);
      if (p.kind === 'pong') return;
    } catch {
      /* host 未就绪 */
    }
    await sleep(100);
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

  // TASK18：host.js / lifo-core.js 预取与 WebContainer.boot() 并行（互不依赖，
  // 消除网络等待在 boot 关键路径上）。lifo-core.js 写盘在 host spawn 后异步进行。
  const hostFetch = fetch('/host.js').then((r) => r.text()).catch(() => null);
  const lifoCoreFetch = fetch('/lifo-core.js').then((r) => r.text()).catch(() => null);

  let wc: WebContainer;
  try {
    wc = await WebContainer.boot();
  } catch (e) {
    ui.fail([`WebContainer runtime failed to start: ${String(e)}`]);
    return null;
  }
  ok(ui, 'Started WebContainer runtime');
  bootPhase('wc-booted');

  // TASK16 R3：先 loadSnapshot 再 initLogger —— 消除恢复期日志写竞争。
  // loadSnapshot 会把旧 /var/log/webunix.log 写回容器 FS；若日志系统先初始化，
  // 恢复写回会与并发日志写互相覆盖（恢复前的 boot 事件不落盘，可接受）。
  // initLogger 之后所有 boot / 快照 / 命令事件照常落盘。
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
  bootPhase('restored');

  // TASK18：host 注入 + spawn 放在配置读取**之前** —— host 的 Sandbox.create（Lifo 内核预热）
  // 与下面的配置读取 / 工作区初始化 / 服务与 motd 兜底并行进行，把 host 预热时间从
  // boot 关键路径上消除。host 尚未就绪不影响这些 FS 操作（host 只在收到命令后才读配置）。
  const { client, hostProc } = await ensureTerminalHost(wc, {
    hostSrc: await hostFetch,
    lifoCoreSrc: await lifoCoreFetch,
    onInjected: () => note(ui, 'host.js missing in container; injected from build artifact'),
    onSpawned: () => {
      ok(ui, 'Mounted shared filesystem');
      // TASK18：Lifo 内核懒加载后，spawn 时内核仍在后台加载 —— "Starting" 比 "Started" 更诚实。
      ok(ui, 'Starting Lifo kernel');
    },
  });
  bootPhase('host-spawned');

  // TASK12：日志系统初始化（WebContainer 就绪后注入 FS）。在快照恢复之后调用，
  // 恢复写回的旧日志不再与新日志写竞争；此后的 boot/命令/快照事件全部落盘。
  initLogger(wc.fs);

  // 系统配置（TASK10）：settings 决定全新系统的默认工作区名；env 文件统计加载数。
  // 读取失败 / 值被手改非法时全部回退默认，不阻断 boot。
  let defaultWorkspace = 'main';
  let envCount = 0;
  try {
    const wsRaw = await getSetting(wc.fs, 'default-workspace');
    if (isValidWorkspaceName(wsRaw)) defaultWorkspace = wsRaw;
    envCount = (await readEnvFile(wc.fs)).size;
  } catch (e) {
    note(ui, `Config load failed (${String(e).slice(0, 80)}); using defaults`);
  }

  // 工作区状态：快照恢复后 /ws/.current 应已存在（随快照持久）；
  // 全新系统则用配置的默认工作区名初始化。
  await initWorkspace(ui, wc.fs, defaultWorkspace);
  ok(ui, `Loaded ${envCount} environment variables`);

  // 服务管理（TASK11）：确保定义/自启文件存在（缺失时落内置预置 / 空清单，用户可随后编辑）。
  try {
    await ensureServicesFiles(wc.fs);
  } catch (e) {
    note(ui, `Service files init failed (${String(e).slice(0, 80)})`);
  }

  // 登录横幅（TASK15）：确保 /etc/webunix.motd 存在（缺失时落默认内容，用户可随后 motd 编辑）。
  try {
    await ensureMotd(wc.fs);
  } catch (e) {
    note(ui, `Motd init failed (${String(e).slice(0, 80)})`);
  }

  // 浏览器先写一个"项目文件"，证明共享文件系统双向可用（host 挂载点即 /workspace）。
  // 注意：内容与测试套件的字节数断言（TE5=74）绑定，不要随意改动。
  await wc.fs.writeFile('/browser-wrote.txt', 'hello from browser — lifo should see this\nsecond line with LIFO keyword\n');
  bootPhase('config-done');

  // 端口注册表：容器里任何服务就绪都记一笔，进程被杀 / 端口关闭时自动移除。
  // 预览提示行由 main.ts 的 server-ready 监听器打到 xterm（呈现层，不在这里）。
  wc.on('server-ready', (port, url) => {
    ports.set(port, url);
  });
  wc.on('port', (port, type) => {
    if (type === 'close') ports.delete(port);
  });

  // 探活：命令轮询循环就绪，TerminalExecutor 可用（host 预热已与配置读取重叠完成）。
  // TASK18：waitForHostReady 已确认 pong；删去其后的冗余 ping（在延迟预热窗口内，
  // 多余 ping 会被 Sandbox.create 的同步前缀阻塞，白白拖慢 boot）。
  await waitForHostReady(client);
  bootPhase('host-ready');
  ok(ui, 'TerminalExecutor ready');

  // 服务自启（TASK11）：声明式重启 —— boot 后按 /etc/webunix.autostart 逐个拉起。
  // 失败只记日志不阻塞 boot（继续）；不是守护进程，不做崩溃自愈（AGENTS.md 边界）。
  try {
    const autostart = await readAutostart(wc.fs);
    for (const name of autostart) {
      const r = await startService({ wc, client, ports }, name);
      if (r.ok) ok(ui, `Started service '${name}' (autostart)`);
      else {
        ui.log(`[ FAIL ] service '${name}' failed to start`, 'fail');
        void log('BOOT', `service '${name}' failed to start`);
      }
    }
  } catch (e) {
    note(ui, `Autostart skipped (${String(e).slice(0, 80)})`);
  }

  void log('BOOT', 'boot complete');
  bootPhase('boot-done');
  return { wc, client, ports, hostProc };
}
