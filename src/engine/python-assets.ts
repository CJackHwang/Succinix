// Python 运行时懒注入（TASK23 → TASK27 换 Pyodide）：python 是系统资产，不依赖用户 npm install。
// build-host.mjs 把 python-daemon.js + Pyodide 314.0.4 资产发布到 public/pyodide/；这里在首次
// python/pip 命令前把资产写入容器 FS（复用 lifo-core.js 的懒加载模式：首用才注入，幂等）。
// 容器布局与 host.ts 的 PYTHON_DAEMON_JS 约定一致：
//   /usr/lib/succinix/python/  python-daemon.js + pyodide.mjs + pyodide.asm.mjs +
//                             pyodide.asm.wasm + python_stdlib.zip + pyodide-lock.json
//                             （daemon 从自身目录 import './pyodide.mjs'，indexURL = 同目录）
import type { FileSystemAPI } from '@webcontainer/api';

export const PYTHON_RUNTIME_DIR = '/usr/lib/succinix/python';

interface PythonAssetSpec {
  /** 容器内路径 */
  path: string;
  /** 构建资产 URL（vite 静态资源，public/pyodide/） */
  url: string;
}

const PYTHON_ASSETS: PythonAssetSpec[] = [
  { path: `${PYTHON_RUNTIME_DIR}/python-daemon.js`, url: '/pyodide/python-daemon.js' },
  { path: `${PYTHON_RUNTIME_DIR}/pyodide.mjs`, url: '/pyodide/pyodide.mjs' },
  { path: `${PYTHON_RUNTIME_DIR}/pyodide.asm.mjs`, url: '/pyodide/pyodide.asm.mjs' },
  { path: `${PYTHON_RUNTIME_DIR}/pyodide.asm.wasm`, url: '/pyodide/pyodide.asm.wasm' },
  { path: `${PYTHON_RUNTIME_DIR}/python_stdlib.zip`, url: '/pyodide/python_stdlib.zip' },
  { path: `${PYTHON_RUNTIME_DIR}/pyodide-lock.json`, url: '/pyodide/pyodide-lock.json' },
];

let injecting: Promise<void> | null = null;

// 确保 python 资产已注入。已注入（python-daemon.js 可读）直接返回；否则注入全部资产。
// 并发调用复用同一个注入 Promise（去重，防止两个 python 命令同时触发重复写）。
export async function ensurePythonRuntime(wc: { fs: FileSystemAPI }): Promise<void> {
  try {
    await wc.fs.readFile(`${PYTHON_RUNTIME_DIR}/python-daemon.js`, 'utf8');
    return;
  } catch {
    /* 未注入 */
  }
  if (!injecting) {
    injecting = doInject(wc.fs).finally(() => {
      injecting = null;
    });
  }
  return injecting;
}

async function doInject(fs: FileSystemAPI): Promise<void> {
  for (const asset of PYTHON_ASSETS) {
    const resp = await fetch(asset.url);
    if (!resp.ok) {
      throw new Error(`python asset fetch failed: ${asset.url} (HTTP ${resp.status})`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    const parent = asset.path.slice(0, asset.path.lastIndexOf('/'));
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(asset.path, buf);
  }
}
