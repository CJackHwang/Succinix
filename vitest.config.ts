import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/terminal/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/log.ts',
        'src/persist/index.ts',
        'src/services/index.ts',
        'src/pkg/index.ts',
        'src/motd.ts',
        'src/config.ts',
        'src/engine/host-route.ts',
        'src/engine/rpc-v2.ts',
        'src/engine/host/terminal.ts',
        'src/engine/host/main.ts',
        'src/engine/host/run.ts',
        'src/engine/terminal-hub.ts',
        'src/engine/host/service-world.ts',
        'src/engine/host/service-command-bridge.ts',
        'src/engine/host-procs.ts',
        'src/engine/client.ts',
        'src/engine/terminal-executor.ts',
        'src/plugin/host-manager.ts',
        'src/terminal/transport.ts',
        'src/persist/binary-v2.ts',
        'src/persist/context.ts',
        'src/persist/restore-staging.ts',
        'src/persist/session-segments.ts',
        'src/userland/registry.ts',
        'src/engine/host/git-world.ts',
        'src/engine/tokenize.ts',
        'src/commands/index.ts',
        'src/redact.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
        // Risk-heavy orchestration modules have explicit thresholds so a high
        // aggregate cannot hide untested lifecycle branches.
        'src/engine/host/main.ts': { lines: 65, functions: 45, branches: 65, statements: 60 },
        'src/engine/host/run.ts': { lines: 65, functions: 40, branches: 55, statements: 62 },
        'src/engine/host/terminal.ts': { lines: 80, functions: 70, branches: 70, statements: 75 },
        'src/terminal/transport.ts': { lines: 75, functions: 60, branches: 60, statements: 68 },
        'src/persist/binary-v2.ts': { lines: 80, functions: 70, branches: 55, statements: 70 },
        'src/persist/restore-staging.ts': { lines: 75, functions: 65, branches: 50, statements: 65 },
      },
    },
  },
  resolve: {
    alias: {
      '@succinix/engine': fileURLToPath(new URL('./src/plugin/index.ts', import.meta.url)),
    },
  },
});
