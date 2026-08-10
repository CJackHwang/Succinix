// 启动模块（应用层薄包装，E2）：bootSuccinix 内部委托 createTerminalBoot（src/terminal/boot.ts）。
// 环境检测 / 重试 / 工作区初始化 / 步骤计数等纯逻辑已迁移到 terminal 层；本文件只保留
// 独立应用的步骤文案、命令日志采集与既有导出面（向后兼容，避免 main/tests/commands 改动）。
import type { BootUI } from './boot-ui.js';
import type { CommandLogEntry } from './engine/index.js';
import {
  createTerminalBoot,
  DEFAULT_BOOT_STEPS,
  checkEnvironment,
  detectSystemInfo,
  initWorkspace,
  RetryHooks,
  withRetry,
  bootWebContainerWithRetry,
  waitForHostReadyWithRetry,
  type TerminalBoot,
  type TerminalBootResult,
  type TerminalBootOptions,
} from './terminal/boot.js';
import { log } from './log.js';

export { checkEnvironment, detectSystemInfo, initWorkspace, withRetry, bootWebContainerWithRetry, waitForHostReadyWithRetry };
export type { RetryHooks, TerminalBoot, TerminalBootOptions };

export type SuccinixServices = TerminalBootResult;

// 日志采集在这里接线：采集条目类型用引擎导出的 CommandLogEntry（结构性兼容），
// 前端过滤纯轮询 ps（避免刷屏）并落盘 /var/log/succinix.log。
export function makeClientLogger(): (entry: CommandLogEntry) => void {
  return (entry) => {
    if (entry.command.trim() !== 'ps') {
      void log('INFO', `cmd: ${entry.command} exit=${entry.exit} runtime=${entry.runtime}`);
    }
  };
}

// boot 完成信号 = Promise 解析（null 表示环境不适配，错误页已由 ui.fail 显示）。
export async function bootSuccinix(ui: BootUI): Promise<SuccinixServices | null> {
  const testMode = new URLSearchParams(location.search).get('test') === '1';
  const boot = createTerminalBoot(ui, {
    steps: [...DEFAULT_BOOT_STEPS],
    testMode,
    onCommand: makeClientLogger(),
  });
  return boot.boot();
}
