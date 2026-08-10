// 构建 @succinix/engine 包目录（packages/engine/）。TASK-S2：本地 npm 发布准备，不 publish。
// 产物（files 白名单只发这些）：
//   dist/index.js       浏览器侧客户端单一 ESM bundle（esbuild，platform browser，零依赖自包含）
//   dist/terminal.js    终端 SDK（SuccinixTerminalSession + TerminalBoot，E4；external @webcontainer/api）
//   dist/instance.js    实例聚合 API（createSuccinixInstance，M5；external @webcontainer/api）
//   dist/*.d.ts         tsc declaration 产物（消费者类型检查用；只编译入口 + 其类型依赖）
//   assets/host.js      容器内 host daemon（复制自 public/host.js）
//   assets/lifo-core.js Lifo 内核懒加载资产（复制自 public/lifo-core.js）
// 前置：先跑 `npm run build:host`（产出 public/host.js + public/lifo-core.js）。本脚本不 publish。
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgDir = join(root, 'packages', 'engine');
const srcEngine = join(root, 'src', 'engine');
const srcTerminal = join(root, 'src', 'terminal');
const srcInstance = join(root, 'src', 'instance');
const distDir = join(pkgDir, 'dist');
const assetsDir = join(pkgDir, 'assets');

// 前置检查：host 资产必须已由 build:host 产出。
const hostJs = join(root, 'public', 'host.js');
const lifoCoreJs = join(root, 'public', 'lifo-core.js');
for (const f of [hostJs, lifoCoreJs]) {
  if (!existsSync(f)) {
    throw new Error(`missing ${f} — run \`npm run build:host\` first`);
  }
}

// 1) 浏览器客户端 bundle：src/engine/index.ts → dist/index.js。
//    index.ts 链上运行时只依赖浏览器全局（fetch/setTimeout）；node:* 与 @webcontainer/api 均为
//    type-only import（esbuild 剥离），产物无任何 import —— 纯 ESM。不 minify：库代码保持可读。
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
await build({
  entryPoints: [join(srcEngine, 'index.ts')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outfile: join(distDir, 'index.js'),
  logLevel: 'info',
});

// 1b) 终端 SDK bundle：src/terminal/index.ts → dist/terminal.js。
//     与 index.js 同配置（ESM、browser）；@webcontainer/api 是 peerDependency，保持 external
//     （TerminalBoot 运行时调用 WebContainer.boot()）。
await build({
  entryPoints: [join(srcTerminal, 'index.ts')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outfile: join(distDir, 'terminal.js'),
  external: ['@webcontainer/api'],
  logLevel: 'info',
});

// 1c) 实例聚合 API bundle：src/instance/index.ts → dist/instance.js。
//     与 terminal.js 同配置（ESM、browser）；@webcontainer/api 保持 external。
//     依赖图包含引擎客户端 + 终端 SDK + persist/services/config/motd（实例 API 的
//     snapshot/services 绑定需要），全部内联 —— 产物自包含单文件。
await build({
  entryPoints: [join(srcInstance, 'index.ts')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outfile: join(distDir, 'instance.js'),
  external: ['@webcontainer/api'],
  logLevel: 'info',
});

// 2) .d.ts：tsc 按 packages/engine/tsconfig.json 编译入口 + 其类型依赖（client/host-procs/python-assets）；
//    终端 SDK 用 tsconfig.terminal.json、实例 API 用 tsconfig.instance.json（rootDir=src，
//    产物 dist/terminal.d.ts / dist/instance.d.ts + 共享依赖的 .d.ts）。
//    用根 devDependencies 里的 typescript，避免子包自装 node_modules。
const tsc = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(pkgDir, 'tsconfig.json')],
  { stdio: 'inherit' }
);
if (tsc.status !== 0) {
  throw new Error(`tsc declaration emit failed (exit ${tsc.status})`);
}
const tscTerminal = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(pkgDir, 'tsconfig.terminal.json')],
  { stdio: 'inherit' }
);
if (tscTerminal.status !== 0) {
  throw new Error(`tsc terminal declaration emit failed (exit ${tscTerminal.status})`);
}
const tscInstance = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(pkgDir, 'tsconfig.instance.json')],
  { stdio: 'inherit' }
);
if (tscInstance.status !== 0) {
  throw new Error(`tsc instance declaration emit failed (exit ${tscInstance.status})`);
}

// 3) host 资产复制进包：消费者经 exports 子路径（./host.js / ./lifo-core.js）用 ?url 或拷静态目录取用。
rmSync(assetsDir, { recursive: true, force: true });
mkdirSync(assetsDir, { recursive: true });
cpSync(hostJs, join(assetsDir, 'host.js'));
cpSync(lifoCoreJs, join(assetsDir, 'lifo-core.js'));

console.log('@succinix/engine package built → packages/engine/ (dist/ + assets/)');
