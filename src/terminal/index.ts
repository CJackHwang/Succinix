// 终端 SDK 统一出口：无 UI 终端交互核心（session）+ boot 流程参数化（boot，E2 提供）。
export {
  SuccinixTerminalSession,
  type TerminalRpc,
  type TerminalOutput,
  type TerminalSessionOptions,
  type LocalCommandCtx,
  type LocalCommandHandler,
  type DirEntry,
} from './session.js';
export {
  createTerminalBoot,
  DEFAULT_BOOT_STEPS,
  BOOT_BASE_STEPS,
  MAX_BOOT_ATTEMPTS,
  MAX_HOST_READY_ATTEMPTS,
  type TerminalBoot,
  type TerminalBootOptions,
  type TerminalBootResult,
  type AppBootStepsContext,
  runApplicationBootSteps,
} from './boot.js';
