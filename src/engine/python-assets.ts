// Python 运行时懒注入（TASK23 → TASK27 换 Pyodide）：python 是系统资产，不依赖用户 npm install。
// build-host.mjs 把 python-daemon.js + Pyodide 314.0.4 资产发布到 public/pyodide/；这里在首次
// python/pip 命令前把资产写入容器 FS（复用 lifo-core.js 的懒加载模式：首用才注入，幂等）。
// 容器布局与 host.ts 的 PYTHON_DAEMON_JS 约定一致：
//   /usr/lib/succinix/python/  python-daemon.js + pyodide.mjs + pyodide.asm.mjs +
//                             pyodide.asm.wasm + python_stdlib.zip + pyodide-lock.json
//                             （daemon 从自身目录 import './pyodide.mjs'，indexURL = 同目录）
import type { FileSystemAPI } from '@webcontainer/api';

export const PYTHON_RUNTIME_DIR = '/usr/lib/succinix/python';

const PYTHON_ASSETS: ReadonlyArray<string> = [
  'python-daemon.js',
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

let injecting: Promise<void> | null = null;

// 确保 python 资产已注入。已注入（python-daemon.js 可读）直接返回；否则注入全部资产。
// 并发调用复用同一个注入 Promise（去重，防止两个 python 命令同时触发重复写）。
// assetsBase 默认指向 vite public 的 /pyodide/；插件把 config.pythonAssetsUrl 传入即可。
export async function ensurePythonRuntime(wc: { fs: FileSystemAPI }, assetsBase = '/pyodide/'): Promise<void> {
  try {
    await wc.fs.readFile(`${PYTHON_RUNTIME_DIR}/python-daemon.js`, 'utf8');
    return;
  } catch {
    /* 未注入 */
  }
  if (!injecting) {
    injecting = doInject(wc.fs, assetsBase).finally(() => {
      injecting = null;
    });
  }
  return injecting;
}

async function doInject(fs: FileSystemAPI, assetsBase: string): Promise<void> {
  const base = assetsBase.replace(/\/+$/, '') + '/';
  for (const asset of PYTHON_ASSETS) {
    const url = `${base}${asset}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`python asset fetch failed: ${url} (HTTP ${resp.status})`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    const path = `${PYTHON_RUNTIME_DIR}/${asset}`;
    const parent = path.slice(0, path.lastIndexOf('/'));
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(path, buf);
  }
}
