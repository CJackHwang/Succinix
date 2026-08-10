// 启动模块（参数化，E2）：boot 步骤 / 进度 / 重试 / testMode 可配置的 TerminalBoot。
// 从 src/boot.ts 迁移：checkEnvironment / detectSystemInfo / initWorkspace / withRetry /
// bootWebContainerWithRetry / waitForHostReadyWithRetry 与 ok/note/failStep/noteOnly 包装
// （步骤计数 N/M）。BootUI 直接复用 boot-ui.ts 的实际接口；进度由 TerminalBoot 内部用
// ui.log('[  OK  ] N/M <msg>', 'ok') 实现，不改 boot-ui.ts。独立应用 bootSuccinix(ui)
// 保留在 src/boot.ts，内部改为 createTerminalBoot(...).boot()，行为与时序不变。
import { WebContainer, type FileSystemAPI, type WebContainerProcess } from '@webcontainer/api';
import type { BootUI } from '../boot-ui.js';
import { TerminalClient, bootEngineHost, waitForHostReady, type CommandLogEntry, type EngineBootHooks } from '../engine/index.js';
import { loadSnapshot } from '../persist.js';
import { getSetting, readEnvFile, isValidWorkspaceName } from '../config.js';
import { ensureServicesFiles, readAutostart, startService } from '../services.js';
import { initLogger, log } from '../log.js';
import { ensureMotd } from '../motd.js';
import { respawnWithKillFirst } from '../host-restart.js';
import { sleep, ensureParentDir } from '../util.js';
import { DEFAULT_INSTANCE_ID, statePath, userHomePath, browserPathToSessionCwd } from '../instance/paths.js';

// ─── 选项 / 结果契约 ───

export interface TerminalBootOptions {
  /** 固定步骤文案（编号 N/M 自动；独立应用 8 基础步 + autostart 服务数）。
   *  宿主可传自己的步骤清单（长度 = 固定步数，动态消息由流程自行带出）。 */
  steps: string[];
  /** 自检模式透传（独立应用读 ?test=1；宿主自行决定） */
  testMode?: boolean;
  /** WebContainer.boot 失败重试参数（attempts 含首次；缺省 3 次 / 1s 退避） */
  retry?: { attempts: number; intervalMs: number };
  /** host 就绪单次探活时限（缺省 engine waitForHostReady 默认 60 次 × 2s） */
  hostReadyDeadlineMs?: number;
  /** 命令执行采集点（引擎只产生条目，宿主决定过滤与落盘；缺省不记录） */
  onCommand?: (entry: CommandLogEntry) => void;
}

export interface TerminalBootResult {
  wc: WebContainer;
  client: TerminalClient;
  /** 端口注册表：port → 预览 URL（来自 WebContainer 的 server-ready 事件，每次 boot 重建） */
  ports: Map<number, string>;
  /** 当前 host 进程句柄（宿主 host 重启路径用 kill 清理旧进程，防双 host 竞态） */
  hostProc: WebContainerProcess;
}

export interface TerminalBoot {
  readonly testMode: boolean;
  /** 步骤进度方法：ok/note/failStep 参与计数（msg 缺省用 opts.steps 对应标签）；noteOnly 不计 */
  ok(msg?: string): void;
  note(msg?: string): void;
  failStep(msg?: string): void;
  noteOnly(msg: string): void;
  /** 完整 boot 流程；环境不适配返回 null（错误页已由 ui.fail 显示） */
  boot(): Promise<TerminalBootResult | null>;
}

// 独立应用固定步骤文案（与 boot.ts 既有输出逐字一致；host.js 注入步骤是条件步，
// 仅在缺失注入时计步 —— 与既有 R2 计数语义一致）。
export const DEFAULT_BOOT_STEPS = [
  'Started WebContainer runtime',
  'Restored workspace from persistent storage',
  'host.js missing in container; injected from build artifact',
  'Mounted shared filesystem',
  'Starting Lifo kernel',
  'Initialized default workspace',
  'Loaded environment variables',
  'TerminalExecutor ready',
] as const;

// TASK18：bench 模式记录 boot 阶段时间戳（window.__bootTimes.phases 由 scripts/bench.mjs 的
// 注入脚本创建）。正常会话无该对象，函数为 no-op —— 仅一次 window 读的微小开销。
function bootPhase(name: string): void {
  const t = (window as unknown as { __bootTimes?: { phases?: Record<string, number> } }).__bootTimes;
  if (t && t.phases) t.phases[name] = performance.now();
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
export async function initWorkspace(boot: TerminalBoot, fs: FileSystemAPI, defaultWorkspace: string): Promise<void> {
  let current: string | null = null;
  try {
    const raw = await fs.readFile('/ws/.current', 'utf8');
    current = raw.trim() || null;
  } catch {
    current = null;
  }
  if (current) {
    boot.ok(`Workspace '${current}'`);
    return;
  }
  try {
    await fs.mkdir(`/ws/${defaultWorkspace}`, { recursive: true });
    await fs.writeFile('/ws/.current', defaultWorkspace);
  } catch (e) {
    boot.note(`Default workspace init failed (${String(e).slice(0, 80)})`);
    return;
  }
  boot.ok(`Initialized default workspace '${defaultWorkspace}'`);
}

// ─── R3：关键步骤失败自动重试（最多 3 次）───

// R3.1：WebContainer.boot() 失败重试默认上限（含首次）。间隔 1s 退避。
export const MAX_BOOT_ATTEMPTS = 3;
// R3.2：host 就绪（waitForHostReady）失败重试默认上限（含首次）。
export const MAX_HOST_READY_ATTEMPTS = 3;

// R2 总步数 = 固定步数（opts.steps.length）+ autostart 服务数。固定序列见 DEFAULT_BOOT_STEPS。
export const BOOT_BASE_STEPS = DEFAULT_BOOT_STEPS.length;

// ─── R3 通用重试决策（M3：可测纯逻辑，见 tests/boot-retry.test.ts）───
// 按 attempts 上限循环调用 fn(attempt)（attempt 从 1 起）。失败且未达上限 → onRetry
// （打 WARN 文案）+ beforeRetry（R3.2 respawn 换源用）+ backoffMs 退避；成功立即返回
// 不再尝试；达上限抛最后一次错误。attempts 上限 / 退避间隔 / 失败判定集中于此。
export interface RetryHooks {
  /** 每次失败（未达上限）回调：attempt = 本次失败序号（1-based），供打 "attempt N/MAX" 文案 */
  onRetry?: (attempt: number, error: unknown) => void;
  /** 重试前换源（R3.2：kill 旧 host + spawn 新 host，防双 host 竞态）；默认无 */
  beforeRetry?: () => Promise<void> | void;
  /** 两次尝试间退避 ms（R3.1 用 1000；测试传 0 加速） */
  backoffMs?: number;
}
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxAttempts: number,
  hooks: RetryHooks = {}
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        hooks.onRetry?.(attempt, e);
        await hooks.beforeRetry?.();
        if (hooks.backoffMs) await sleep(hooks.backoffMs);
      }
    }
  }
  throw lastError;
}

// R3.1：WebContainer.boot() 失败自动重试（默认最多 3 次，1s 退避），封装成可测函数。
// 返回 { wc, error }：成功时 wc 为实例、error 为 null；全败 wc 为 null、error 为
// 最后一次失败原因（供 ui.fail 展示）。
export async function bootWebContainerWithRetry(
  ui: BootUI,
  opts: { backoffMs?: number; attempts?: number } = {}
): Promise<{ wc: WebContainer | null; error: unknown }> {
  const attempts = opts.attempts ?? MAX_BOOT_ATTEMPTS;
  let bootError: unknown = null;
  let wc: WebContainer | null = null;
  try {
    wc = await withRetry(() => WebContainer.boot(), attempts, {
      backoffMs: opts.backoffMs ?? 1000,
      onRetry: (attempt) => {
        ui.log(`[ WARN ] WebContainer boot failed (attempt ${attempt}/${attempts}), retrying...`);
      },
    });
  } catch (e) {
    bootError = e;
  }
  return { wc, error: bootError };
}

// 就绪探活（hostReadyDeadlineMs 变体）：在时限内轮询 ping；超时抛错。
// 缺省走 engine waitForHostReady（60 次 × 2s 语义不变）。
async function waitHostReady(client: TerminalClient, deadlineMs?: number): Promise<void> {
  if (deadlineMs === undefined) {
    await waitForHostReady(client);
    return;
  }
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
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

// R3.2：waitForHostReady 失败自动重试。每次重试先 kill 旧 hostProc 再重新 spawn
// （respawnWithKillFirst 模式，防双 host 同时轮询 cmd.json）。重试只补 spawn：
// onInjected/onSpawned 置空避免 boot 步骤重复累计；onServerReady/onServerClosed 已在
// 首次注册到 wc（engine 侧 WeakSet 防重复注册，M1）。3 次全败抛出，走宿主 catch → 错误页路径。
export async function waitForHostReadyWithRetry(
  ui: BootUI,
  wc: WebContainer,
  client: TerminalClient,
  hostProc: WebContainerProcess,
  hostHooks: EngineBootHooks,
  deadlineMs?: number,
  attempts = MAX_HOST_READY_ATTEMPTS
): Promise<WebContainerProcess> {
  let current = hostProc;
  return withRetry(
    async () => {
      await waitHostReady(client, deadlineMs);
      return current;
    },
    attempts,
    {
      onRetry: (attempt) => {
        ui.log(`[ WARN ] TerminalExecutor not ready (attempt ${attempt}/${attempts}), respawning host...`);
      },
      beforeRetry: async () => {
        current = await respawnWithKillFirst(
          () => {
            try {
              current?.kill();
            } catch {
              /* 旧 host 句柄失效：忽略，spawn 新 host 继续 */
            }
          },
          () =>
            bootEngineHost(wc, client, {
              hostSrc: hostHooks.hostSrc,
              lifoCoreSrc: hostHooks.lifoCoreSrc,
            })
        );
      },
    }
  );
}

// ─── 应用级 bootsteps（M5：默认路径与 ?instance= demo 共用，避免两套 boot 逻辑分叉）───
// createTerminalBoot.boot() 在 host 注入/spawn 之后调用；demo（实例工厂路径）在
// createSuccinixInstance（引擎级 boot 已完成）之后调用。两路径共用同一套
// config / workspace / env / services / motd / 自检文件 / 探活重试 / autostart 步骤。
// 缺省实例（不传 instanceId）= 现状 /etc 语义全等。
export interface AppBootStepsContext {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
  /** 实例上下文（M5，additive）：settings/services/autostart/motd 按实例解析；缺省 = 默认实例 */
  instanceId?: string;
  /** 状态根前缀覆盖（M5，additive）：缺省 = DM-12 内置前缀 */
  statePrefix?: string;
  /** 用户 home（U1，浏览器 wc.fs 视角，如 /workspace/users/alice）：非空 = 多用户模式 ——
   *  首次启动创建 home（mkdir + .succinix 状态种子）并把会话 cwd 种子写入实例状态文件
   *  （Lifo 视图 /workspace + home 路径，host 首启恢复为会话 cwd）。缺省 = 现状（guest 无 home） */
  userHome?: string;
  /** 跳过探活与 'TerminalExecutor ready' 步（demo：工厂已 waitForHostReady） */
  skipHostReady?: boolean;
  /** 探活重试参数（默认路径传；R3.2 kill-before-spawn，返回最终 host 句柄） */
  hostReadyRetry?: {
    ui: BootUI;
    hostProc: WebContainerProcess;
    hostHooks: EngineBootHooks;
    deadlineMs?: number;
  };
}

export async function runApplicationBootSteps(boot: TerminalBoot, ctx: AppBootStepsContext): Promise<WebContainerProcess | null> {
  const { wc, client, ports } = ctx;
  let hostProc = ctx.hostReadyRetry?.hostProc ?? null;

  // TASK12：日志系统初始化（WebContainer 就绪后注入 FS）。在快照恢复之后调用，
  // 恢复写回的旧日志不再与新日志写竞争；此后的 boot/命令/快照事件全部落盘。
  initLogger(wc.fs);

  // 系统配置（TASK10）：settings 决定全新系统的默认工作区名；env 文件统计加载数。
  // 读取失败 / 值被手改非法时全部回退默认，不阻断 boot。
  let defaultWorkspace = 'main';
  let envCount = 0;
  try {
    const wsRaw = await getSetting(wc.fs, 'default-workspace', ctx.instanceId, ctx.statePrefix);
    if (isValidWorkspaceName(wsRaw)) defaultWorkspace = wsRaw;
    envCount = (await readEnvFile(wc.fs, ctx.instanceId, ctx.statePrefix)).size;
  } catch (e) {
    boot.noteOnly(`Config load failed (${String(e).slice(0, 80)}); using defaults`);
  }

  // 工作区状态：快照恢复后 /ws/.current 应已存在（随快照持久）；
  // 全新系统则用配置的默认工作区名初始化。
  await initWorkspace(boot, wc.fs, defaultWorkspace);

  // 多用户 home（U1）：首次启动创建 /workspace/users/<id>（mkdir + .succinix 状态种子）；
  // 会话 cwd 状态文件缺失时种子为 home 的 Lifo 视图（host 按实例恢复，刷新后仍在 home）。
  if (ctx.userHome) {
    const userId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
    try {
      await ensureUserHome(wc.fs, userId, ctx.userHome);
    } catch (e) {
      boot.noteOnly(`User home init failed (${String(e).slice(0, 80)})`);
    }
    const cwdFile = statePath(userId, 'etc/succinix.cwd', ctx.statePrefix);
    try {
      await wc.fs.readFile(cwdFile, 'utf8');
    } catch {
      try {
        await ensureParentDir(wc.fs, cwdFile);
        await wc.fs.writeFile(cwdFile, browserPathToSessionCwd(ctx.userHome));
      } catch (e) {
        boot.noteOnly(`Session cwd seed failed (${String(e).slice(0, 80)})`);
      }
    }
    boot.ok('Initialized user home');
  }
  boot.ok(`Loaded ${envCount} environment variables`);

  // 服务管理（TASK11）：确保定义/自启文件存在（缺失时落内置预置 / 空清单，用户可随后编辑）。
  try {
    await ensureServicesFiles(wc.fs, ctx.instanceId, ctx.statePrefix);
  } catch (e) {
    boot.noteOnly(`Service files init failed (${String(e).slice(0, 80)})`);
  }

  // 登录横幅（TASK15）：确保 /etc/succinix.motd 存在（缺失时落默认内容，用户可随后 motd 编辑）。
  try {
    await ensureMotd(wc.fs, ctx.instanceId, ctx.statePrefix);
  } catch (e) {
    boot.noteOnly(`Motd init failed (${String(e).slice(0, 80)})`);
  }

  // 浏览器先写一个"项目文件"，证明共享文件系统双向可用（host 挂载点即 /workspace）。
  // 注意：内容与测试套件的字节数断言（TE5=74）绑定，不要随意改动。
  await wc.fs.writeFile('/browser-wrote.txt', 'hello from browser — lifo should see this\nsecond line with LIFO keyword\n');
  bootPhase('config-done');

  // 探活：命令轮询循环就绪，TerminalExecutor 可用（host 预热已与配置读取重叠完成）。
  // TASK18：waitForHostReady 已确认 pong；删去其后的冗余 ping（在延迟预热窗口内，
  // 多余 ping 会被 Sandbox.create 的同步前缀阻塞，白白拖慢 boot）。
  // R3.2：探活失败自动重试（最多 3 次，含首次），返回最终存活 host 句柄。
  if (!ctx.skipHostReady) {
    const r = ctx.hostReadyRetry;
    if (r) {
      hostProc = await waitForHostReadyWithRetry(r.ui, wc, client, hostProc ?? r.hostProc, r.hostHooks, r.deadlineMs);
    }
    bootPhase('host-ready');
    boot.ok();
  }

  // 服务自启（TASK11）：声明式重启 —— boot 后按 autostart 逐个拉起（M5：按实例）。
  // 失败只记日志不阻塞 boot（继续）；不是守护进程，不做崩溃自愈（AGENTS.md 边界）。
  try {
    const autostart = await readAutostart(wc.fs, ctx.instanceId, ctx.statePrefix);
    for (const name of autostart) {
      const r = await startService({ wc, client, ports, instanceId: ctx.instanceId, statePrefix: ctx.statePrefix }, name);
      if (r.ok) boot.ok(`Started service '${name}' (autostart)`);
      else boot.failStep(`service '${name}' failed to start`);
    }
  } catch (e) {
    boot.noteOnly(`Autostart skipped (${String(e).slice(0, 80)})`);
  }

  void log('BOOT', 'boot complete');
  return hostProc;
}

// ─── 用户 home 初始化（U1）───
// 首次启动创建 home 目录（浏览器视角绝对路径，宿主可覆盖根）+ .succinix 状态种子
// （随快照持久，供宿主/自检确认 home 已初始化）。幂等：目录/种子已存在则跳过写入。
export async function ensureUserHome(fs: FileSystemAPI, userId: string, homePath: string = userHomePath(userId)): Promise<void> {
  await fs.mkdir(homePath, { recursive: true });
  try {
    await fs.readFile(`${homePath}/.succinix`, 'utf8');
  } catch {
    await fs.writeFile(`${homePath}/.succinix`, userId);
  }
}

// ─── 工厂：createTerminalBoot ───

export function createTerminalBoot(ui: BootUI, opts: TerminalBootOptions): TerminalBoot {
  // R2：boot 步骤计数（实时进度 N/M）。只有 ok()/note()/failStep() 参与计数；
  // noteOnly() 降级说明行、ui.log 的 info/WARN 行、运行期日志、自检 verdict 均不计数。
  // 总步数在 WebContainer.boot 成功后确定（固定步数 + autostart 服务数）。
  let bootStep = 0;
  let bootTotal = 0;

  // 重置计数并设定总步数。首次 ok/note 输出前调用（需 wc 读取 autostart 计数，幂等）。
  function initBootSteps(total: number): void {
    bootStep = 0;
    bootTotal = total;
  }

  // 当前进度前缀 "N/M "（计数未开始即 bootTotal===0 时为空 —— 如 WebContainer.boot 重试期）。
  function progressPrefix(): string {
    return bootTotal > 0 ? `${bootStep}/${bootTotal} ` : '';
  }

  // systemd 风格：暗橙 [  OK  ] 标记 + 默认色消息（渲染到覆盖层日志区）。
  // TASK12：同步写 BOOT 级日志到 /var/log/succinix.log（initLogger 之后生效；之前为 no-op）。
  // R2：步骤计数自动加在 marker 之后、消息之前 —— 行首 marker 保持原样，boot-ui 仍可识别。
  function ok(msg?: string): void {
    bootStep++;
    const text = msg ?? opts.steps[bootStep - 1] ?? `step ${bootStep}`;
    ui.log(`[  OK  ] ${progressPrefix()}${text}`, 'ok');
    void log('BOOT', text);
  }

  // 灰色 [ .... ] 标记，用于中间过程的过渡说明
  function note(msg?: string): void {
    bootStep++;
    const text = msg ?? opts.steps[bootStep - 1] ?? `step ${bootStep}`;
    ui.log(`[ .... ] ${progressPrefix()}${text}`, 'note');
    void log('BOOT', text);
  }

  // [ FAIL ] 计步变体（M2）：autostart 单个服务失败行计入步骤 —— initBootSteps 已把
  // autostart 服务数算进总步数，失败的服务同样是 boot 步骤；不计数会让末行停在 (M-1)/M。
  // 与 restartHost 的运行期 WARN 不计数区分：autostart 是 boot 步骤，计入。
  function failStep(msg?: string): void {
    bootStep++;
    const text = msg ?? opts.steps[bootStep - 1] ?? `step ${bootStep}`;
    ui.log(`[ FAIL ] ${progressPrefix()}${text}`, 'fail');
    void log('BOOT', text);
  }

  // 降级提示（L1/L2）：失败降级分支的额外说明行[ .... ] **不参与**步骤计数。总步数按
  // 正常路径确定（固定步数 + autostart 服务数），这些分支多出的说明行若计数会
  // 溢出总步数（>M/M）。降级是用户可感知信息，行保留、只不计步。
  function noteOnly(msg: string): void {
    ui.log(`[ .... ] ${progressPrefix()}${msg}`, 'note');
    void log('BOOT', msg);
  }

  const boot: TerminalBoot = {
    testMode: opts.testMode ?? false,
    ok,
    note,
    failStep,
    noteOnly,
    async boot(): Promise<TerminalBootResult | null> {
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

      // R3.1：WebContainer.boot() 失败自动重试（默认最多 3 次，1s 退避）。计数尚未开始
      // （总步数需 wc 读 autostart），故重试 WARN 不带 N/M 前缀（progressPrefix 为空）。
      const { wc, error: bootError } = await bootWebContainerWithRetry(ui, {
        backoffMs: opts.retry?.intervalMs,
        attempts: opts.retry?.attempts,
      });
      if (!wc) {
        ui.fail([`WebContainer runtime failed to start: ${String(bootError)}`]);
        return null;
      }
      // R2：总步数 = 固定步数 + autostart 服务数。提前读 autostart 只取计数（幂等，
      // 文件缺失回落空清单；与启动阶段的实际读取结果一致）。
      try {
        initBootSteps(opts.steps.length + (await readAutostart(wc.fs)).length);
      } catch {
        initBootSteps(opts.steps.length);
      }
      ok();
      bootPhase('wc-booted');

      // TASK16 R3：先 loadSnapshot 再 initLogger —— 消除恢复期日志写竞争。
      // loadSnapshot 会把旧 /var/log/succinix.log 写回容器 FS；若日志系统先初始化，
      // 恢复写回会与并发日志写互相覆盖（恢复前的 boot 事件不落盘，可接受）。
      // initLogger 之后所有 boot / 快照 / 命令事件照常落盘。
      try {
        const restored = await loadSnapshot(wc.fs);
        if (restored) {
          ok(`Restored workspace from persistent storage (${restored.fileCount} files, ${Math.round(restored.totalBytes / 1024)} KB)`);
        } else {
          ok('Initialized fresh workspace');
        }
      } catch (e) {
        noteOnly(`Persistent restore failed (${String(e).slice(0, 80)}); continuing with current filesystem`);
        ok('Initialized fresh workspace');
      }
      bootPhase('restored');

      // TASK18：host 注入 + spawn 放在配置读取**之前** —— host 的 Sandbox.create（Lifo 内核预热）
      // 与下面的配置读取 / 工作区初始化 / 服务与 motd 兜底并行进行，把 host 预热时间从
      // boot 关键路径上消除。host 尚未就绪不影响这些 FS 操作（host 只在收到命令后才读配置）。
      // TASK21：终端客户端与 host 拉起都由引擎提供；端口事件经 onServerReady/onServerClosed 维护
      // 预览端口注册表（bootEngineHost 内部注册 wc.on('server-ready'/'port')，此处接线）。
      const client = new TerminalClient(wc, { onCommand: opts.onCommand ?? (() => {}) });
      // R3.2：host 就绪失败需重试整个 bootEngineHost（kill 旧 host 再 spawn）。hooks 提为常量
      // 复用：重试时只补 spawn（onInjected/onSpawned 置空，不重复打 boot 步骤；端口回调首次已
      // 注册到 wc，重试不重复注册）。
      const hostHooks: EngineBootHooks = {
        hostSrc: await hostFetch,
        lifoCoreSrc: await lifoCoreFetch,
        onInjected: () => note(),
        onSpawned: () => {
          ok();
          // TASK18：Lifo 内核懒加载后，spawn 时内核仍在后台加载 —— "Starting" 比 "Started" 更诚实。
          ok();
        },
        onServerReady: (port, url) => void ports.set(port, url),
        onServerClosed: (port) => void ports.delete(port),
      };
      let hostProc = await bootEngineHost(wc, client, hostHooks);
      bootPhase('host-spawned');

      // 应用级 bootsteps（config / workspace / env / services / motd / 自检文件 / 探活 /
      // autostart）—— 与 ?instance= demo 共用同一实现（runApplicationBootSteps），防两套
      // boot 逻辑漂移。不传 instanceId = 默认实例 /etc 语义，行为全等现状。
      hostProc =
        (await runApplicationBootSteps(boot, {
          wc,
          client,
          ports,
          hostReadyRetry: { ui, hostProc, hostHooks, deadlineMs: opts.hostReadyDeadlineMs },
        })) ?? hostProc;
      bootPhase('boot-done');
      return { wc, client, ports, hostProc };
    },
  };
  return boot;
}
