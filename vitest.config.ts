import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@succinix/engine': fileURLToPath(new URL('./src/plugin/index.ts', import.meta.url)),
    },
  },
});
