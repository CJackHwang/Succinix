// engine 内共享 sleep（P2-6）：engine 自包含（不依赖系统层），
// 不 import 系统层的 src/util.ts，这里放 engine 内部共用的最小实现。
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
