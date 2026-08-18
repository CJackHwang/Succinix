// 服务的定义、生命周期和 enablement 由执行世界的 Lifo ServiceManager 管理。
// 此 barrel 只保留执行世界共享模板与数据库端口投影，禁止重新导出浏览器侧生命周期。
export { dbActivePortFor, setDbActivePort, clearDbActivePorts } from './registry.js';
export { SERVICE_TEMPLATES, serviceTemplate, type ServiceTemplate } from './templates.js';
export type { ServiceDef, ServiceState, ServiceActionResult } from './types.js';
