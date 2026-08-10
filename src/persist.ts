// 兼容 shim（O4）：实现已拆分到 src/persist/（types/exclusions/collect/idb/context/index）。
// 既有导入路径（'./persist.js'）保持不变；新代码建议直接导入 src/persist/index.js。
export * from './persist/index.js';
