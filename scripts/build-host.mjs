// Bundle the Lifo host scripts (run inside WebContainer as `node host.js`).
// TASK18：拆成两个产物 ——
//   host.js      主 host（轻量：RPC 轮询 / 进程表 / node 子进程），动态 import('./lifo-core.js')；
//   lifo-core.js @lifo-sh/core 独立 bundle（~1MB，解析执行慢），host 启动时不加载，
//                首个 Lifo 命令或延迟预热时才 import —— 消除 1MB bundle 解析对 boot 探活的阻塞。
// node builtins stay external (WC virtualizes them). @lifo-sh/ui stays external (headless).
// TASK16: minify:true 压缩体积。keepNames 默认 false —— 若 Lifo 依赖
// Function.name 出现运行时错误，改回 keepNames:true（体积略增）或记录原因回退。
import { build } from 'esbuild';

await build({
  entryPoints: ['src/host.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: true,
  // ./lifo-core.js 是运行时相对导入（host.js 所在目录的兄弟文件，由 boot 注入到容器根），
  // 不在 host bundle 里打包；@lifo-sh/ui 仅可视化终端用到，headless 不加载。
  external: ['@lifo-sh/ui', './lifo-core.js'],
  outfile: 'public/host.js',
  logLevel: 'info',
});

await build({
  entryPoints: ['src/lifo-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: true,
  external: ['@lifo-sh/ui'],
  outfile: 'public/lifo-core.js',
  logLevel: 'info',
});

console.log('host.js + lifo-core.js built → public/');
