// TASK18：Lifo 内核独立入口 —— 供 host.js 动态 import('./lifo-core.js') 懒加载。
// 把 @lifo-sh/core（~1MB，解析执行都慢）从 host.js 主 bundle 中拆出，让 host.js 保持轻量、
// 启动后立即响应 boot 探活 ping；Lifo 内核在首个 Lifo 命令（或延迟预热）时才加载。
// 协议不变：这只是构建/加载策略，命令路由与 RPC 形态零改动。
export { Sandbox, rehydrateGlobalPackages } from '@lifo-sh/core';
export { runGitCommand } from './host/git-world.js';
