// 构建 @succinix/engine@0.6.0 包目录（packages/engine/）。不 publish。
// 产物：
//   dist/index.js        插件入口 ESM bundle（@deepseek-ai/cordis/@webcontainer/api external）
//   dist/plugin/**/*.d.ts  tsc declaration 产物（rootDir=src）
//   assets/host.js       容器内 host daemon（复制自 public/host.js）
//   assets/lifo-core.js  Lifo 内核懒加载资产（复制自 public/lifo-core.js）
//   assets/sha256.json   host/lifo SHA-256 清单
// 前置：先跑 `npm run build:host`（产出 public/host.js + public/lifo-core.js）。
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgDir = join(root, 'packages', 'engine');
const srcPlugin = join(root, 'src', 'plugin');
const distDir = join(pkgDir, 'dist');
const assetsDir = join(pkgDir, 'assets');
const hostJs = join(root, 'public', 'host.js');
const lifoCoreJs = join(root, 'public', 'lifo-core.js');

for (const file of [hostJs, lifoCoreJs]) {
  if (!existsSync(file)) {
    throw new Error(`missing ${file} — run \`npm run build:host\` first`);
  }
}

// 1) 插件入口 bundle。@deepseek-ai/cordis 与 @webcontainer/api 是 peerDependency，保持 external；
//    @standard-schema/spec 已声明为 runtime dependency，同样 external。
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
await build({
  entryPoints: [join(srcPlugin, 'index.ts')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outfile: join(distDir, 'index.js'),
  external: ['@deepseek-ai/cordis', '@webcontainer/api', '@standard-schema/spec'],
  logLevel: 'info',
});

// 2) .d.ts：tsc 按 packages/engine/tsconfig.plugin.json 编译插件入口 + 类型依赖。
const tsc = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(pkgDir, 'tsconfig.plugin.json')],
  { stdio: 'inherit' }
);
if (tsc.status !== 0) {
  throw new Error(`tsc plugin declaration emit failed (exit ${tsc.status})`);
}

// 3) host 资产复制进包 + SHA-256 清单（加载前完整性校验用）。
rmSync(assetsDir, { recursive: true, force: true });
mkdirSync(assetsDir, { recursive: true });
cpSync(hostJs, join(assetsDir, 'host.js'));
cpSync(lifoCoreJs, join(assetsDir, 'lifo-core.js'));
const pythonAssetsDir = join(root, 'public', 'pyodide');
if (existsSync(pythonAssetsDir)) {
  cpSync(pythonAssetsDir, join(assetsDir, 'pyodide'), { recursive: true });
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest = {
  'host.js': sha256(join(assetsDir, 'host.js')),
  'lifo-core.js': sha256(join(assetsDir, 'lifo-core.js')),
};
writeFileSync(join(assetsDir, 'sha256.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 4) 导出面快照校验（0.6.0 只保留五个键）。
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const expectedExports = new Set(['.', './host.js', './lifo-core.js', './assets/*', './package.json']);
const actualExports = new Set(Object.keys(pkg.exports ?? {}));
if (actualExports.size !== expectedExports.size || [...expectedExports].some((key) => !actualExports.has(key))) {
  throw new Error(`package exports mismatch: expected [${[...expectedExports].join(', ')}], got [${[...actualExports].join(', ')}]`);
}

console.log('@succinix/engine 0.6.0 package built → packages/engine/ (dist/ + assets/)');
