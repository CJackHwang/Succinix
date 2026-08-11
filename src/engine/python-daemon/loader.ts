// Pyodide 加载 + FS 挂载（O7 拆分自 python-daemon.ts）。
// 职责：Pyodide 实例生命周期、站点包/工作区 NODEFS 挂载、会话 cwd 映射、
// 输出缓冲（stdout/stderr 回调累积，供 rpc.send 与各 handler 读取/重置）、daemon.log。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Pyodide ESM 胶水（构建时同目录注入；indexURL = 本文件所在目录）。
// esbuild external：保留运行时相对 import，不把 17KB 胶水打进 daemon bundle。
// @ts-expect-error -- pyodide.mjs 是构建期注入的 Pyodide 胶水，无 TS 声明；loadPyodide 类型见下
import { loadPyodide as loadPyodideRaw } from './pyodide.mjs';

// ─── Pyodide 返回类型窄化（构建产物无 TS 类型）───
interface PyodideFS {
  mkdir(p: string, opts?: { recursive?: boolean }): void;
  mount(type: unknown, opts: { root: string }, path: string): void;
  filesystems: Record<string, unknown>;
  stat(p: string): { mode: number };
  isDir(mode: number): boolean;
  readdir(p: string): string[];
  unlink(p: string): void;
  rmdir(p: string): void;
}
interface PyodideAPI {
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  loadPackage(pkg: string | string[]): Promise<unknown>;
  pyimport(name: string): unknown;
  FS: PyodideFS;
}
interface PyodideLoader {
  loadPyodide(opts: {
    indexURL: string;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
  }): Promise<PyodideAPI>;
}
const loadPyodide = loadPyodideRaw as PyodideLoader['loadPyodide'];

// Python 版本：Pyodide 314.0.4 内置（sys.version 首段实测 3.14.2）。
export const PYTHON_VERSION = '3.14.2';

// host process.cwd() == 浏览器 FS 根（随快照持久）。持久化目录固定在此，不随会话 cwd 漂移。
const CWD = process.cwd();
export const PERSIST_DIR = path.join(CWD, '.pyodide');
export const SITE_PACKAGES = path.join(PERSIST_DIR, 'site-packages');
export const MANIFEST_FILE = path.join(PERSIST_DIR, 'installed.json');
// Pyodide 虚拟 FS 布局（3.14）。
export const PY_SITE = '/lib/python3.14/site-packages';
const PY_HOME = '/home/pyodide';
// 每次命令的执行超时兜底（host 侧另有请求级超时，这里是 Python 内 prevent 卡死）。
export const PY_EXEC_TIMEOUT_MS = 120000;

// stdout/stderr 捕获缓冲（loadPyodide 回调逐段累积；每次命令前重置）。
export let outBuf = '';
export let errBuf = '';

/** 重置命令级输出缓冲（每个 handler 开始前调用）。 */
export function resetOutput(): void {
  outBuf = '';
  errBuf = '';
}
/** 直接设置 stderr 缓冲（覆盖；handler 错误/提示输出）。 */
export function setError(msg: string): void {
  errBuf = msg;
}
/** 直接设置 stdout 缓冲（覆盖；固定输出如 usage/help）。 */
export function setOutput(msg: string): void {
  outBuf = msg;
}

let pyodide: PyodideAPI | undefined;

/** 已初始化的 Pyodide 实例（handleRequest 均在 init 之后运行，调用时必已就绪）。 */
export function getPyodide(): PyodideAPI {
  if (!pyodide) throw new Error('pyodide not initialized');
  return pyodide;
}

// ─── Pyodide 初始化 + FS 挂载 ───
export async function initPyodide(): Promise<void> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  pyodide = await loadPyodide({
    indexURL: dir + '/',
    stdout: (s) => {
      // Pyodide 的 stdout 回调按"完整行"投递且剥掉行尾 \n（实测 print('a');print('b') → 'ab'）。
      // 这里补回 \n 还原行结构，否则多行输出会连成一行（如 pip show / 标准库矩阵）。
      outBuf += s;
      if (!s.endsWith('\n')) outBuf += '\n';
    },
    stderr: (s) => {
      errBuf += s;
    },
  });
  mountFS();
}

function mountFS(): void {
  const fsapi = getPyodide().FS;
  // 站点包持久化：NODEFS → .pyodide/site-packages（随快照持久，纯 Python wheel 离线可用）。
  fs.mkdirSync(SITE_PACKAGES, { recursive: true });
  try {
    fsapi.mkdir(PY_SITE, { recursive: true });
  } catch {
    /* Pyodide 已建该目录：存在时 mkdir 抛 errno，忽略 */
  }
  fsapi.mount(fsapi.filesystems.NODEFS, { root: SITE_PACKAGES }, PY_SITE);
  // Python cwd 映射容器根：相对路径读写（open('x.txt') / os.getcwd()）落在浏览器 FS 根。
  try {
    fsapi.mkdir(PY_HOME, { recursive: true });
  } catch {
    /* 同上 */
  }
  fsapi.mount(fsapi.filesystems.NODEFS, { root: CWD }, PY_HOME);
}

// 会话 cwd 跟随：host 请求带真实 cwd（spawnCwd() 映射后的 host 路径），映射到 Pyodide FS。
function mapRealCwdToPy(realCwd: string): string {
  const rel = realCwd === CWD ? '' : realCwd.startsWith(CWD + '/') ? realCwd.slice(CWD.length) : '';
  return PY_HOME + rel;
}
export function setPythonCwd(realCwd: string | undefined): void {
  const target = mapRealCwdToPy(realCwd || CWD);
  try {
    getPyodide().runPython(`import os; os.chdir(${JSON.stringify(target)})`);
  } catch {
    try {
      getPyodide().runPython(`import os; os.chdir(${JSON.stringify(PY_HOME)})`);
    } catch {
      /* 兜底失败：保持当前 cwd */
    }
  }
}

// daemon.log 随快照持久累积 → 简单轮转（TASK27 复审项 4）：超过 256KB 先截断再追加，
// 量小但避免无界增长（刷新后仍在，不清理会一直膨胀）。
const DAEMON_LOG = path.join(PERSIST_DIR, 'daemon.log');
const DAEMON_LOG_MAX_BYTES = 256 * 1024;
export function note(msg: string): void {
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(DAEMON_LOG).size;
    } catch {
      /* 首次写入：文件不存在 */
    }
    if (size > DAEMON_LOG_MAX_BYTES) fs.writeFileSync(DAEMON_LOG, '');
    fs.appendFileSync(DAEMON_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 日志写失败不影响运行 */
  }
}
