// Bundle the Lifo host scripts (run inside WebContainer as `node host.js`).
// TASK18：拆成两个产物 ——
//   host.js      主 host（轻量：RPC 轮询 / 进程表 / node 子进程），动态 import('./lifo-core.js')；
//   lifo-core.js @lifo-sh/core 独立 bundle（~1MB，解析执行慢），host 启动时不加载，
//                首个 Lifo 命令或延迟预热时才 import —— 消除 1MB bundle 解析对 boot 探活的阻塞。
// TASK23：再拆一个 python 运行时 ——
//   public/python/python-runtime.js   python-wasm CLI 入口（host 在 python 命令时 spawn 的 node 脚本）
//   public/python/python.wasm / python-stdlib.zip / kernel.wasm / termcap
//                运行时二进制资产（python-wasm + @cowasm/kernel），随 python-runtime.js 一起
//                懒注入容器；python-runtime.js 用 CommonJS 构建，使 require 时 __dirname 指向
//                同一目录，python-wasm 与 kernel 从 __dirname 解析各自的 wasm/zip。
// node builtins stay external (WC virtualizes them). @lifo-sh/ui stays external (headless).
// TASK16: minify:true 压缩体积。keepNames 默认 false —— 若 Lifo 依赖
// Function.name 出现运行时错误，改回 keepNames:true（体积略增）或记录原因回退。
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

await build({
  entryPoints: ['src/engine/host.ts'],
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
  entryPoints: ['src/engine/lifo-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: true,
  external: ['@lifo-sh/ui'],
  outfile: 'public/lifo-core.js',
  logLevel: 'info',
});

// python 运行时 CLI（TASK23）：
//   - alias posix-node → 本地 stub：真 posix-node 是 Zig 原生 addon（.node），WebContainer
//     加载不了；@cowasm/kernel 对其全部调用都带 `?.` / `!= null` 守卫，空模块是安全 no-op。
//     这样 esbuild 无需解析原生 .node 文件即可打包。
//   - format: 'cjs'：运行时 __dirname = 输出目录，python-wasm / kernel 从该目录读资产。
await build({
  entryPoints: ['src/engine/python-runtime.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  minify: true,
  alias: { 'posix-node': './scripts/shims/posix-node-stub.cjs' },
  outfile: 'public/python/python-runtime.js',
  logLevel: 'info',
});

// 运行时二进制资产随 bundle 发布（同一 public/python/ 目录；注入容器时与 bundle 放同一目录）。
// python-stdlib.zip 是标准库（json/csv/re/math/os/sqlite3 等）；python.wasm 是解释器；
// kernel.wasm 是 @cowasm/kernel 的 wasi 内核；termcap 由 kernel 从 __dirname 的父目录读取。
mkdirSync('public/python', { recursive: true });
cpSync('node_modules/python-wasm/dist/python.wasm', 'public/python/python.wasm');
cpSync('node_modules/python-wasm/dist/python-stdlib.zip', 'public/python/python-stdlib.zip');
cpSync('node_modules/@cowasm/kernel/dist/kernel/kernel.wasm', 'public/python/kernel.wasm');
cpSync('node_modules/@cowasm/kernel/dist/termcap', 'public/python/termcap');

console.log('host.js + lifo-core.js + python runtime built → public/');
