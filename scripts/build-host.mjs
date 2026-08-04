// Bundle the Lifo host script (runs inside WebContainer as `node host.js`).
// @lifo-sh/core is bundled in; node builtins stay external (WC virtualizes them).
// TASK16: minify:true 压缩体积（目标 ≥30%）。keepNames 默认 false —— 若 Lifo 依赖
// Function.name 出现运行时错误，改回 keepNames:true（体积略增）或记录原因回退。
import { build } from 'esbuild';

await build({
  entryPoints: ['src/host.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: true,
  // @lifo-sh/ui is only lazy-loaded when a visual terminal is used; we run headless.
  external: ['@lifo-sh/ui'],
  outfile: 'public/host.js',
  logLevel: 'info',
});
console.log('host.js built → public/host.js');
