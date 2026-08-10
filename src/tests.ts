// 兼容 shim：自检已迁移到 src/selftest/（O5 拆分，O1/O2/O4 同款模式）。
// 全部公开导出经由 src/selftest/index.js 重新导出，import 方无需改动。
export * from './selftest/index.js';
