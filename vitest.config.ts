import { defineConfig } from 'vitest/config';

// Vitest 单元测试配置（TASK20）：纯逻辑模块，Node 环境，mock FS/IDB/网络。
// 覆盖率门禁：v8 provider，核心纯逻辑文件（8 个）整体 ≥70%。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/log.ts',
        'src/persist.ts',
        'src/services.ts',
        'src/pkg.ts',
        'src/motd.ts',
        'src/config.ts',
        'src/engine/host-route.ts', // P1-4：host.ts 纯逻辑抽取，重构回归保护
        'src/engine/client.ts', // P3-11：串行队列 / 只读重试 / pingDirect 通道判定
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
