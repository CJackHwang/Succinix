// 应用级 boot 步骤（D1）：从 terminal SDK 拆出 —— SDK 的 createTerminalBoot 只做引擎级
// 流程编排，config / workspace / env / services / motd / 自检文件 / 探活重试 / autostart
// 归应用层，由宿主经 TerminalBootOptions.appSteps / dynamicStepCount / restore / logLine
// 钩子注入。默认路径（src/boot.ts 的 bootSuccinix）与 ?instance= demo（bootDemoInstance）
// 共用本模块的同一实现，避免两套 boot 逻辑分叉；缺省实例（不传 instanceId）= /etc 语义。
import type { FileSystemAPI, WebContainer, WebContainerProcess } from '@webcontainer/api';
import type { BootUI } from './terminal/ui.js';
import {
  initWorkspace,
  MAX_HOST_READY_ATTEMPTS,
  withRetry,
  bootPhase,
  type TerminalBoot,
  type TerminalBootAppContext,
} from './terminal/boot.js';
import { TerminalClient, bootEngineHost, waitForHostReady, type EngineBootHooks } from './engine/index.js';
import { getSetting, readEnvFile, isValidWorkspaceName } from './config.js';
import { ensureServicesFiles, readAutostart, startService } from './services/index.js';
import { initLogger, log } from './log.js';
import { ensureMotd } from './motd.js';
import { respawnWithKillFirst } from './host-restart.js';
import { sleep, ensureParentDir } from './util.js';
import { DEFAULT_INSTANCE_ID, statePath, userHomePath, browserPathToSessionCwd } from './instance/paths.js';

export interface AppBootStepsContext extends TerminalBootAppContext {
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

// ─── 就绪探活（hostReadyDeadlineMs 变体）───
// 在时限内轮询 ping；超时抛错。缺省走 engine waitForHostReady（60 次 × 2s 语义不变）。
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
