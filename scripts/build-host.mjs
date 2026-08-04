// Bundle the Lifo host script (runs inside WebContainer as `node host.js`).
// @lifo-sh/core is bundled in; node builtins stay external (WC virtualizes them).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/host.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // @lifo-sh/ui is only lazy-loaded when a visual terminal is used; we run headless.
  external: ['@lifo-sh/ui'],
  outfile: 'public/host.js',
  logLevel: 'info',
});
console.log('host.js built → public/host.js');
