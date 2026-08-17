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
        'src/engine/client.ts',
        'src/terminal/transport.ts',
        'src/persist/binary-v2.ts',
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
      },
    },
  },
  resolve: {
    alias: {
      '@succinix/engine': fileURLToPath(new URL('./src/plugin/index.ts', import.meta.url)),
    },
  },
});
