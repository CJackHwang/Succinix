// 兼容 shim：命令实现已迁移到 src/commands/（O1 拆分，O4 persist 同款模式）。
// 全部公开导出经由 src/commands/index.js 重新导出，import 方无需改动。
export * from './commands/index.js';
