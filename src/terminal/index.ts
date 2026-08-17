// 终端 SDK 统一出口：引擎级 boot 流程、设备 transport 和协议。
export type { TerminalOutput } from './output.js';
export {
  createTerminalBoot,
  DEFAULT_BOOT_STEPS,
  BOOT_BASE_STEPS,
  MAX_BOOT_ATTEMPTS,
  MAX_HOST_READY_ATTEMPTS,
  bootPhase,
  type TerminalBoot,
  type TerminalBootOptions,
  type TerminalBootResult,
  type TerminalBootAppContext,
} from './boot.js';
export type { BootUI, LogKind } from './ui.js';
export {
  RpcTerminalClient,
  createTerminalIdentity,
  type BrowserRpcTerminalOptions,
  type TerminalTransportFs,
} from './transport.js';
export {
  TERMINAL_MAILBOX_ROOT,
  TERMINAL_PROTOCOL_VERSION,
  TERMINAL_FLUSH_MS,
  TERMINAL_FRAME_LIMIT,
  TERMINAL_MAX_BUFFER_BYTES,
  type TerminalIdentity,
  type TerminalOutputFrame,
} from './transport-protocol.js';
