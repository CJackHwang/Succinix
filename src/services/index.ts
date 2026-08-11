// 服务管理模块（TASK11）公开面（O8 拆分后由 barrel 保持 API 不变）：
// /etc/succinix.services（服务定义）与 /etc/succinix.autostart（自启清单）。
// 服务 = 给后台进程（spawn）起名字 + 生命周期管理 + 可选开机自启，是 spawn/ps/kill + 端口注册表的
// **声明式封装**。定义文件 name|command|port，`|` 分隔、`#` 注释，随快照持久。
// 自启是"声明式重启"（boot 时拉起），不是守护进程/崩溃自愈（AGENTS.md 边界，不做崩溃重启）。
// 状态判定：进程表有该服务命令的 running 进程 且（若有端口）端口注册表就绪 → running，否则 stopped。
export { servicesFilePath, autostartFilePath, SERVICES_FILE, AUTOSTART_FILE, DEFAULT_SERVICES_TEXT } from './io.js';
export {
  ensureServicesFiles,
  parseServices,
  readServices,
  writeServicesText,
  addServiceDef,
  removeServiceDef,
  readAutostart,
  enableAutostart,
  disableAutostart,
} from './io.js';
export { clearActivePorts, dbActivePortFor, setDbActivePort, clearDbActivePorts } from './registry.js';
export { resolvePreviewPort, renderCommand } from './ports.js';
export {
  processBelongsToInstance,
  getServiceState,
  listServiceStates,
  startService,
  stopService,
} from './lifecycle.js';
export type { ServiceDef, ServiceState, ServiceContext, ServiceActionResult } from './types.js';
