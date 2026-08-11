// 启动模块（应用层薄包装，E2）：bootSuccinix 内部委托 createTerminalBoot（src/terminal/boot.ts）。
// M5：?instance=<id> demo 走实例工厂（createSuccinixInstance，引擎级 boot）+ 应用级
// bootsteps（runApplicationBootSteps 共享实现）—— 两套路径共用同一实现，避免逻辑分叉。
// 环境检测 / 重试 / 工作区初始化 / 步骤计数等纯逻辑已迁移到 terminal 层；本文件只保留
// 独立应用的步骤文案、命令日志采集与既有导出面（向后兼容，避免 main/tests/commands 改动）。
import type { BootUI } from './boot-ui.js';
import type { TerminalClient } from './engine/index.js';
import type { WebContainer } from '@webcontainer/api';
import {
  createTerminalBoot,
  DEFAULT_BOOT_STEPS,
  checkEnvironment,
  detectSystemInfo,
  initWorkspace,
  RetryHooks,
  withRetry,
  bootWebContainerWithRetry,
  type TerminalBoot,
  type TerminalBootResult,
  type TerminalBootOptions,
} from './terminal/boot.js';
import { runApplicationBootSteps, waitForHostReadyWithRetry } from './boot-steps.js';
import { loadSnapshot } from './persist.js';
import type { TerminalOutput, TerminalSessionOptions } from './terminal/index.js';
import { createSuccinixInstance, DEFAULT_INSTANCE_BOOT_STEPS, type SuccinixInstance } from './instance/index.js';
import { DEFAULT_INSTANCE_ID, userHomePath } from './instance/paths.js';
import { readAutostart } from './services/index.js';
import { log } from './log.js';

export { checkEnvironment, detectSystemInfo, initWorkspace, withRetry, bootWebContainerWithRetry, waitForHostReadyWithRetry };
export type { RetryHooks, TerminalBoot, TerminalBootOptions };

// 独立应用 boot 结果：默认路径 = TerminalBootResult（现状）；demo（?instance=）附加实例聚合对象。
export interface SuccinixServices extends Omit<TerminalBootResult, 'hostProc'> {
  /** 当前 host 进程句柄（默认路径必有；demo 由实例 executor 持有，经 instance.executor 取用） */
  hostProc?: TerminalBootResult['hostProc'];
  /** M5 demo：实例聚合对象（terminal/executor/snapshot/services/restart/dispose） */
  instance?: SuccinixInstance;
}

// 命令日志采集（host 命令采集）已下沉到 app/logging.ts；此处 re-export 保持既有导出面。
import { makeClientLogger } from './app/logging.js';
export { makeClientLogger };

export interface BootSuccinixOptions {
  /** 终端输出（demo 模式必需；默认路径不使用） */
  output?: TerminalOutput;
  /** 会话选项（demo 模式透传给实例工厂：本地命令表/着色/采集点等） */
  terminal?: TerminalSessionOptions;
}

// boot 完成信号 = Promise 解析（null 表示环境不适配，错误页已由 ui.fail 显示）。
export async function bootSuccinix(ui: BootUI, opts: BootSuccinixOptions = {}): Promise<SuccinixServices | null> {
  const params = new URLSearchParams(location.search);
  const testMode = params.get('test') === '1';
  const userId = params.get('user');
  const instanceId = params.get('instance');
  // U1：?user=<id> 是多用户 demo 参数（userId 与 instanceId 等价，内部同一字段）；
  // ?instance=<id> 保持 M5 别名兼容（实例模式，无 per-user home）。
  // 缺省路径（无参数 / ?user=default / ?instance=default）= 现状行为全等。
  const id = userId ?? instanceId;
  if (id && id !== DEFAULT_INSTANCE_ID) {
    return bootDemoInstance(ui, id, { testMode, userMode: userId !== null && userId !== '', ...opts });
  }
  const boot = createTerminalBoot(ui, {
    steps: [...DEFAULT_BOOT_STEPS],
    testMode,
    onCommand: makeClientLogger(),
    logLine: (text) => void log('BOOT', text),
    dynamicStepCount: async (wc) => {
      try {
        return (await readAutostart(wc.fs)).length;
      } catch {
        return 0;
      }
    },
    restore: async (wc) => {
      const m = await loadSnapshot(wc.fs);
      return m ? { fileCount: m.fileCount, totalBytes: m.totalBytes } : null;
    },
    appSteps: (b, ctx) =>
      runApplicationBootSteps(b, {
        wc: ctx.wc,
        client: ctx.client,
        ports: ctx.ports,
        // SDK 的 appSteps 调用恒带 hostProc/hostHooks（引擎级 boot 产物）；此处仅缺省路径使用。
        hostReadyRetry: { ui, hostProc: ctx.hostProc!, hostHooks: ctx.hostHooks!, deadlineMs: ctx.hostReadyDeadlineMs },
      }),
  });
  return boot.boot();
}

// ─── M5 demo：?instance=<id> ───
// 组装 = 实例工厂（host 注入 + spawn + 就绪 + 按实例快照键恢复 + session/snapshot/services 绑定）
// + 应用级 bootsteps（workspace / env / services / motd / 自检文件 / autostart，按实例解析）。
// 探活已由工厂完成（skipHostReady）；boot 步骤输出沿用同款 marker 格式（独立 N/M 计数）。
async function bootDemoInstance(
  ui: BootUI,
  instanceId: string,
  opts: { testMode?: boolean; userMode?: boolean; output?: TerminalOutput; terminal?: TerminalSessionOptions }
): Promise<SuccinixServices | null> {
  // 任何 WebContainer 操作之前：环境检测（与 createTerminalBoot 同款错误页，无降级）。
  const failures = checkEnvironment();
  if (failures.length > 0) {
    ui.fail(failures);
    return null;
  }
  ui.systemInfo(detectSystemInfo());
  ui.log('Starting system services...', 'info');

  // WebContainer.boot 重试（R3.1，与默认路径同一实现）。
  const { wc, error } = await bootWebContainerWithRetry(ui);
  if (!wc) {
    ui.fail([`WebContainer runtime failed to start: ${String(error)}`]);
    return null;
  }
  if (!opts.output) {
    ui.fail(['Instance mode requires a terminal output adapter (main.ts passes the xterm shim).']);
    return null;
  }
  // 应用级 bootsteps 的进度 reporter（D3：初始 boot 与 restart 复用同一工厂）。
  const makeDemoBoot = (): TerminalBoot => ({
    testMode: opts.testMode ?? false,
    ok: (msg) => {
      ui.log(`[  OK  ] ${msg ?? 'ok'}`, 'ok');
      void log('BOOT', msg ?? 'ok');
    },
    note: (msg) => {
      ui.log(`[ .... ] ${msg ?? 'note'}`, 'note');
      void log('BOOT', msg ?? 'note');
    },
    failStep: (msg) => {
      ui.log(`[ FAIL ] ${msg ?? 'fail'}`, 'fail');
      void log('BOOT', msg ?? 'fail');
    },
    noteOnly: (msg) => ui.log(`[ .... ] ${msg}`, 'note'),
    boot: async () => null,
  });
  const appStepsCtx = (wc: WebContainer, client: TerminalClient, ports: Map<number, string>) => ({
    wc,
    client,
    ports,
    instanceId,
    userHome: opts.userMode ? userHomePath(instanceId) : undefined,
    skipHostReady: true,
  });

  // 引擎级 boot（host 注入 + spawn + 就绪 + 按实例快照键恢复）在工厂内完成。
  const instance = await createSuccinixInstance({
    wc,
    instanceId,
    output: opts.output,
    terminal: opts.terminal,
    // U1：?user=<id> 模式 —— 会话 cwd/提示符 home 指向每用户 home（Lifo 视图）。
    home: opts.userMode ? userHomePath(instanceId) : undefined,
    executor: { onCommand: makeClientLogger() },
    bootUI: ui,
    bootSteps: [...DEFAULT_INSTANCE_BOOT_STEPS],
    // D3：restart 后重跑应用级 bootsteps（与初始 boot 同一实现，防逻辑分叉）。
    onRestart: ({ wc, client, ports }) => runApplicationBootSteps(makeDemoBoot(), appStepsCtx(wc, client, ports)),
  });

  // 应用级 bootsteps —— 与 createTerminalBoot 共用同一实现（防两套 boot 逻辑漂移）；
  // 状态文件按实例解析（env/settings/services/autostart/motd 独立，互不串扰）。
  await runApplicationBootSteps(makeDemoBoot(), appStepsCtx(wc, instance.client, instance.ports));

  return {
    wc,
    client: instance.client,
    ports: instance.ports,
    hostProc: instance.executor.getHostProc() ?? undefined,
    instance,
  };
}
