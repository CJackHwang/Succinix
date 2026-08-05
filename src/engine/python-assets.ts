// Python 运行时懒注入（TASK23）：python 是系统资产，不依赖用户 npm install（装不坏）。
// build-host.mjs 把 python-runtime.js + python.wasm + python-stdlib.zip + kernel.wasm + termcap
// 发布到 public/python/；这里在首次 python 命令前把资产写入容器 FS（复用 lifo-core.js 的
// 懒加载模式：首用才注入，注入完成后后续命令零开销）。
// 容器布局与 host.ts 的 PYTHON_RUNTIME_JS 约定一致：
//   /usr/lib/webunix/python/  python-runtime.js + 二进制资产（__dirname 同目录解析）
//   /usr/lib/webunix/termcap  父目录（@cowasm/kernel 从 join(__dirname,'..','termcap') 读取）
import type { FileSystemAPI } from '@webcontainer/api';

export const PYTHON_RUNTIME_DIR = '/usr/lib/webunix/python';

interface PythonAssetSpec {
  /** 容器内路径 */
  path: string;
  /** 构建资产 URL（vite 静态资源） */
  url: string;
}

const PYTHON_ASSETS: PythonAssetSpec[] = [
  { path: `${PYTHON_RUNTIME_DIR}/python-runtime.js`, url: '/python/python-runtime.js' },
  { path: `${PYTHON_RUNTIME_DIR}/python.wasm`, url: '/python/python.wasm' },
  { path: `${PYTHON_RUNTIME_DIR}/python-stdlib.zip`, url: '/python/python-stdlib.zip' },
  { path: `${PYTHON_RUNTIME_DIR}/kernel.wasm`, url: '/python/kernel.wasm' },
  { path: '/usr/lib/webunix/termcap', url: '/python/termcap' },
];

let injecting: Promise<void> | null = null;

// 确保 python 资产已注入。已注入（python-runtime.js 可读）直接返回；否则注入全部资产。
// 并发调用复用同一个注入 Promise（去重，防止两个 python 命令同时触发重复写）。
export async function ensurePythonRuntime(wc: { fs: FileSystemAPI }): Promise<void> {
  try {
    await wc.fs.readFile(`${PYTHON_RUNTIME_DIR}/python-runtime.js`, 'utf8');
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
