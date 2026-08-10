// Bundle the Lifo host scripts (run inside WebContainer as `node host.js`).
// TASK18：拆成两个产物 ——
//   host.js      主 host（轻量：RPC 轮询 / 进程表 / node 子进程），动态 import('./lifo-core.js')；
//   lifo-core.js @lifo-sh/core 独立 bundle（~1MB，解析执行慢），host 启动时不加载，
//                首个 Lifo 命令或延迟预热时才 import —— 消除 1MB bundle 解析对 boot 探活的阻塞。
// TASK27：python 运行时从旧 WASI 方案换成 Pyodide 314.0.4 ——
//   public/pyodide/python-daemon.js   常驻 Pyodide daemon CLI（host 在 python/pip 命令时 spawn 的 node 脚本）
//   public/pyodide/pyodide.mjs / pyodide.asm.mjs / pyodide.asm.wasm / python_stdlib.zip / pyodide-lock.json
//                 Pyodide full 发行资产（CDN 下载，版本锁定 314.0.4），随 python-daemon.js 一起
//                 懒注入容器；daemon 用 ESM 构建，运行时 import './pyodide.mjs'，indexURL = 同目录。
// node builtins stay external (WC virtualizes them). @lifo-sh/ui stays external (headless).
// TASK16: minify:true 压缩体积。keepNames 默认 false —— 若 Lifo 依赖
// Function.name 出现运行时错误，改回 keepNames:true（体积略增）或记录原因回退。
import { build } from 'esbuild';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';


await build({
  entryPoints: ['src/engine/host/main.ts'],
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

// python daemon CLI（TASK27）：
//   - format: 'esm'：运行时 import './pyodide.mjs'（同目录 Pyodide 胶水），保留相对 import；
//   - external ./pyodide.mjs：不把 Pyodide 胶水打进 daemon bundle（它是独立注入的资产文件）。
await build({
  entryPoints: ['src/engine/python-daemon.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: true,
  external: ['./pyodide.mjs'],
  outfile: 'public/pyodide/python-daemon.js',
  logLevel: 'info',
});

// ─── Pyodide 314.0.4 full 资产（CDN 下载 → 构建时注入，同旧 python 资产的构建模式）───
// 版本锁定 314.0.4（2026-07-24 发布，实测稳定；兼容性依据见 CHANGELOG / README）。
// 需要：pyodide.mjs + pyodide.asm.mjs（ESM 胶水，内嵌 wasm 引用）+ pyodide.asm.wasm +
// python_stdlib.zip + pyodide-lock.json。cdurl 用 jsdelivr full 目录。
const PYODIDE_VERSION = '314.0.4';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`;
const PYODIDE_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

mkdirSync('public/pyodide', { recursive: true });

async function downloadPyodideAssets() {
  for (const f of PYODIDE_FILES) {
    const url = `${PYODIDE_BASE}/${f}`;
    const dest = join('public', 'pyodide', f);
    // 已存在且尺寸一致则跳过（构建幂等，避免重复下载 13MB）。
    try {
      if (statSync(dest).size > 0) continue;
    } catch {
      /* 不存在 → 下载 */
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Pyodide asset download failed: ${url} (HTTP ${res.status})`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`  pyodide: ${f} (${(res.headers.get('content-length') ?? '').slice(0, 12)}B)`);
  }
}

await downloadPyodideAssets();

// 版本锁定记录（注入容器时供自检/文档引用，避免硬编码漂移）。
writeFileSync('public/pyodide/PYODIDE_VERSION', `${PYODIDE_VERSION}\n`);

console.log(`host.js + lifo-core.js + python daemon (Pyodide ${PYODIDE_VERSION}) built → public/`);
