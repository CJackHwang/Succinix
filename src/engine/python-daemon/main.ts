// Succinix Python daemon — Pyodide 314 常驻实例（TASK27）。
//
// host 在首次 python/pip 命令时 spawn 本进程（`node python-daemon.js`），进程内 loadPyodide
// 持有共享 Pyodide 实例；后续所有 python/pip 命令经 stdin/stdout JSON 行协议复用同一实例。
// Python 状态（import 的模块、pip 装好的包）在实例内跨命令累积 —— 这是"pip 装包后持续可用"
// 的机制；实例由 host 常驻，重启/刷新后 host 重建本进程（装过的包经 NODEFS 站点包 + manifest
// 恢复，见 pip.ts）。
//
// 协议（host 侧实现见 src/engine/python-daemon-client.ts）：
//   daemon → host: {"ready":true,"python":"3.14.2"}        启动握手（stdout 首行）
//   host  → daemon: {"id":number,"args":string[],"cwd":string}  命令请求（cwd 为 host 真实路径）
//   daemon → host: {"id":number,"exitCode":number,"stdout":string,"stderr":string}  响应
//
// pip 持久化（尽力而为，详见 pip.ts）：
//   - 站点包 NODEFS 挂载：/lib/python3.14/site-packages → ${process.cwd()}/.pyodide/site-packages。
//     快照（浏览器 FS 根 == host process.cwd()）持久该目录 → 纯 Python wheel 刷新后仍可 import。
//   - 编译包（.so）边界：快照仅文本（persist.ts 跳过二进制），numpy 的 .so 会被丢弃 → 包不完整。
//     启动时检测到不完整包会清掉（避免 import 崩溃），恢复路径 = 用户再次 pip install <pkg>。
//     支持矩阵标注该边界（如实记录，不假装）。
//   - manifest：${process.cwd()}/.pyodide/installed.json（每次成功 pip install 追加 spec）。
//
// 行为兼容：python -c / python <script.py> / python -m <module> / python --version 语义保持；
// 交互式 REPL 仍是边界（AGENTS.md），-m pip 映射到 micropip。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  getPyodide,
  initPyodide,
  note,
  errBuf,
  resetOutput,
  setError,
  setOutput,
  setPythonCwd,
  setPythonEnv,
  PYTHON_VERSION,
} from './loader.js';
import { enqueue, formatError, appendInstallHint, type PydRequest } from './rpc.js';
import { ensureMicropip, handlePip, restorePersisted } from './pip.js';

// ─── 命令处理 ───
function handleC(code: string): number {
  resetOutput();
  try {
    getPyodide().runPython(code);
    return 0;
  } catch (e) {
    if (!errBuf) setError(formatError(e));
    setError(appendInstallHint(errBuf));
    return 1;
  }
}

function handleScript(scriptArg: string, cwd: string | undefined): number {
  // 脚本路径：host 已把 /foo 与 /workspace/foo 映射为真实绝对路径；相对路径按请求 cwd 解析。
  const realPath = scriptArg.startsWith('/') ? scriptArg : path.resolve(cwd || process.cwd(), scriptArg);
  let code: string;
  try {
    code = fs.readFileSync(realPath, 'utf8');
  } catch (e) {
    setError(`python: can't open file '${scriptArg}': ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  resetOutput();
  try {
    getPyodide().runPython(code);
    return 0;
  } catch (e) {
    if (!errBuf) setError(formatError(e));
    setError(appendInstallHint(errBuf));
    return 1;
  }
}

function handleVersion(): number {
  resetOutput();
  try {
    getPyodide().runPython(`import sys; print("Python " + sys.version.split()[0])`);
    return 0;
  } catch {
    setOutput(`Python ${PYTHON_VERSION}\n`);
    return 0;
  }
}

async function handleM(target: string, rest: string[]): Promise<number> {
  if (target === 'pip' || target === 'pip3') return handlePip(rest);
  resetOutput();
  try {
    await getPyodide().runPythonAsync(
      `import runpy, sys
sys.argv = ${JSON.stringify(['', ...rest])}
runpy.run_module(${JSON.stringify(target)}, run_name='__main__')
`
    );
    return 0;
  } catch (e) {
    if (!errBuf) setError(formatError(e));
    setError(appendInstallHint(errBuf));
    return 1;
  }
}

async function handleRequest(req: PydRequest): Promise<{ code: number }> {
  const args = req.args ?? [];
  // 先跟随会话 cwd（相对路径读写 / os.getcwd() 语义）。
  setPythonCwd(req.cwd);
  setPythonEnv(req.env);
  const first = args[0];
  if (first === undefined) {
    setError(
      'python: interactive REPL is not supported here; use: python -c "<code>" | python <script.py> | python -m pip <cmd>\n'
    );
    return { code: 1 };
  }
  if (first === '--version' || first === '-V') return { code: handleVersion() };
  if (first === '-c') {
    const code = args[1];
    if (code === undefined) {
      setError('python: -c requires an argument: python -c "<code>"\n');
      return { code: 2 };
    }
    return { code: handleC(code) };
  }
  if (first === '-m') {
    const target = args[1];
    if (target === undefined) {
      setError('python: -m requires a module name: python -m <module>\n');
      return { code: 2 };
    }
    return { code: await handleM(target, args.slice(2)) };
  }
  if (first.startsWith('-')) {
    setError(`python: unknown option '${first}'\n`);
    return { code: 2 };
  }
  return { code: handleScript(first, req.cwd) };
}

// ─── 主流程 ───
async function main(): Promise<void> {
  try {
    await initPyodide();
    // 先恢复持久化（可能重装编译包，需网络），再报 READY —— 首个命令返回时状态已就绪。
    await restorePersisted();
    await ensureMicropip();
    process.stdout.write(JSON.stringify({ ready: true, python: PYTHON_VERSION }) + '\n');
  } catch (e) {
    const detail = formatError(e);
    note(`init failed: ${detail}`);
    process.stdout.write(JSON.stringify({ ready: false, error: detail }) + '\n');
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    let req: PydRequest;
    try {
      req = JSON.parse(line) as PydRequest;
    } catch {
      return;
    }
    enqueue(req, (r) => handleRequest(r));
  });
  // host 退出 → stdin EOF → 本进程跟着退出（不残留孤儿进程）。
  rl.on('close', () => process.exit(0));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ready: false, error: formatError(e) }) + '\n');
  process.exitCode = 1;
});
