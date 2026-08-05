// Succinix Python daemon — Pyodide 314 常驻实例（TASK27）。
//
// host 在首次 python/pip 命令时 spawn 本进程（`node python-daemon.js`），进程内 loadPyodide
// 持有共享 Pyodide 实例；后续所有 python/pip 命令经 stdin/stdout JSON 行协议复用同一实例。
// Python 状态（import 的模块、pip 装好的包）在实例内跨命令累积 —— 这是"pip 装包后持续可用"
// 的机制；实例由 host 常驻，重启/刷新后 host 重建本进程（装过的包经 NODEFS 站点包 + manifest
// 恢复，见下）。
//
// 协议（host 侧实现见 src/engine/python-daemon-client.ts）：
//   daemon → host: {"ready":true,"python":"3.14.2"}        启动握手（stdout 首行）
//   host  → daemon: {"id":number,"args":string[],"cwd":string}  命令请求（cwd 为 host 真实路径）
//   daemon → host: {"id":number,"exitCode":number,"stdout":string,"stderr":string}  响应
//
// pip 持久化（尽力而为）：
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
const PYTHON_VERSION = '3.14.2';

// host process.cwd() == 浏览器 FS 根（随快照持久）。持久化目录固定在此，不随会话 cwd 漂移。
const CWD = process.cwd();
const PERSIST_DIR = path.join(CWD, '.pyodide');
const SITE_PACKAGES = path.join(PERSIST_DIR, 'site-packages');
const MANIFEST_FILE = path.join(PERSIST_DIR, 'installed.json');
// Pyodide 虚拟 FS 布局（3.14）。
const PY_SITE = '/lib/python3.14/site-packages';
const PY_HOME = '/home/pyodide';
// 每次命令的执行超时兜底（host 侧另有请求级超时，这里是 Python 内 prevent 卡死）。
const PY_EXEC_TIMEOUT_MS = 120000;

// stdout/stderr 捕获缓冲（loadPyodide 回调逐段累积；每次命令前重置）。
let outBuf = '';
let errBuf = '';

interface PydRequest {
  id: number;
  args: string[];
  cwd?: string;
}

// ─── 文件 RPC 请求链（host 侧单槽串行，防御式排队保证按序处理）───
let reqChain: Promise<unknown> = Promise.resolve();
function enqueue(req: PydRequest, handle: (r: PydRequest) => Promise<{ code: number }>): void {
  reqChain = reqChain.then(async () => {
    const res = await Promise.race([
      handle(req),
      new Promise<{ code: number }>((_, reject) => {
        setTimeout(() => reject(new Error('python command timed out')), PY_EXEC_TIMEOUT_MS);
      }),
    ]);
    send({ id: req.id, code: res.code });
  });
}
function send(resp: { id: number; code: number }): void {
  process.stdout.write(JSON.stringify({ id: resp.id, exitCode: resp.code, stdout: outBuf, stderr: errBuf }) + '\n');
}

// ─── 工具 ───
function formatError(e: unknown): string {
  if (e instanceof Error) return e.message.split('\n').slice(0, 20).join('\n');
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
// 缺模块错误 → 追加可操作 hint（TASK27 复审项 3）。冷启动边界：C 扩展包（numpy 等）的
// .so 二进制不随文本快照持久，刷新后被启动清理移除，再次 import 报缺包 —— 保持如实报错
// （不吞原始错误），仅提示指向 `pip install <pkg>` 解决路径（Pyodide 固有约束，不强行自动重装）。
const NO_MODULE_RE = /No module named '([^']+)'|Cannot load package '([^']+)'|loadPackage\('([^']+)'\)/;
function appendInstallHint(errMsg: string): string {
  const m = NO_MODULE_RE.exec(errMsg);
  const pkg = m ? (m[1] ?? m[2] ?? m[3]) : '';
  if (!pkg) return errMsg;
  return `${errMsg}\nhint: install it with: pip install ${pkg}`;
}
// daemon.log 随快照持久累积 → 简单轮转（TASK27 复审项 4）：超过 256KB 先截断再追加，
// 量小但避免无界增长（刷新后仍在，不清理会一直膨胀）。
const DAEMON_LOG = path.join(PERSIST_DIR, 'daemon.log');
const DAEMON_LOG_MAX_BYTES = 256 * 1024;
function note(msg: string): void {
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

// ─── Pyodide 初始化 + FS 挂载 ───
let pyodide: PyodideAPI;

async function initPyodide(): Promise<void> {
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
  const fsapi = pyodide.FS;
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
function setPythonCwd(realCwd: string | undefined): void {
  const target = mapRealCwdToPy(realCwd || CWD);
  try {
    pyodide.runPython(`import os; os.chdir(${JSON.stringify(target)})`);
  } catch {
    try {
      pyodide.runPython(`import os; os.chdir(${JSON.stringify(PY_HOME)})`);
    } catch {
      /* 兜底失败：保持当前 cwd */
    }
  }
}

// ─── pip 持久化（manifest + 完整度恢复）───
function loadManifest(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as string[]).filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveManifest(specs: string[]): void {
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(specs));
  } catch {
    /* 尽力而为 */
  }
}
// spec 的包名（去掉版本限定）：pyparsing / numpy / "pyparsing==3.3.2" → pyparsing。
function specName(spec: string): string {
  return spec.split(/[<>=!~ ]+/)[0]?.trim() || spec;
}
function distInfoDirs(pkgName: string): string[] {
  try {
    const norm = (s: string) => s.replace(/-/g, '_').toLowerCase();
    const target = norm(pkgName);
    return fs.readdirSync(SITE_PACKAGES).filter((e) => {
      const m = /^(.+?)-(\d[^-]*)\.dist-info$/.exec(e);
      return !!m && norm(m[1]) === target;
    });
  } catch {
    return [];
  }
}
// 完整度检查：dist-info 存在 + RECORD 列出的 .so 全部在盘（快照仅文本，.so 可能被丢）。
function needsReinstall(spec: string): boolean {
  const dists = distInfoDirs(specName(spec));
  if (dists.length === 0) return true;
  for (const d of dists) {
    let record = '';
    try {
      record = fs.readFileSync(path.join(SITE_PACKAGES, d, 'RECORD'), 'utf8');
    } catch {
      return true;
    }
    for (const line of record.split('\n')) {
      const p = line.split(',')[0]?.trim();
      if (p && p.endsWith('.so') && !p.startsWith('../') && !fs.existsSync(path.join(SITE_PACKAGES, p))) {
        return true;
      }
    }
  }
  return false;
}
// 卸载：按 RECORD 收集顶层模块目录 + dist-info，经 pyodide.FS 删除（保持 NODEFS 一致）。
function uninstallPackage(spec: string): void {
  const name = specName(spec);
  const dists = distInfoDirs(name);
  const toRemove = new Set<string>(dists);
  for (const d of dists) {
    try {
      const record = fs.readFileSync(path.join(SITE_PACKAGES, d, 'RECORD'), 'utf8');
      for (const line of record.split('\n')) {
        const p = line.split(',')[0]?.trim();
        if (!p || p.startsWith('../')) continue;
        const top = p.includes('/') ? p.split('/')[0] : p;
        if (top && !top.endsWith('.dist-info')) toRemove.add(top);
      }
    } catch {
      /* RECORD 不可读：至少 dist-info 已入集合 */
    }
  }
  const fsapi = pyodide.FS;
  const rmPath = (p: string): void => {
    const st = fsapi.stat(p);
    if (fsapi.isDir(st.mode)) {
      for (const f of fsapi.readdir(p).filter((x) => x !== '.' && x !== '..')) rmPath(`${p}/${f}`);
      fsapi.rmdir(p);
    } else {
      fsapi.unlink(p);
    }
  };
  for (const entry of toRemove) {
    try {
      rmPath(`${PY_SITE}/${entry}`);
    } catch {
      /* 已不存在/并发删除 */
    }
  }
}

// 确保 micropip 可用（幂等；首次会加载进持久站点包）。
let micropipReady: Promise<void> | null = null;
function ensureMicropip(): Promise<void> {
  if (!micropipReady) {
    micropipReady = pyodide.loadPackage('micropip').then(() => undefined).catch(() => undefined);
  }
  return micropipReady;
}

// micropip.install 支持数组（逐个按 PEP 508 解析），与真实 pip 的多包语义一致（TASK27 复审项 1）。
// 此前 `pkgs.join(' ')` 拼成一个字符串会被当单个 requirement 拒掉。
async function pipInstallSpec(specs: string[]): Promise<void> {
  await ensureMicropip();
  await pyodide.runPythonAsync(
    `import micropip\nawait micropip.install(${JSON.stringify(specs)})\nprint("installed: " + ${JSON.stringify(specs.join(' '))})`
  );
}

// 启动恢复（尽力而为 + 明确边界）：manifest 里的包若缺失/不完整 → 清掉并移出 manifest。
// 纯 Python wheel 全部是文本文件 → NODEFS 站点包随快照完整恢复，import 直接可用。
// 编译包（numpy 等）的 .so 是二进制 → 文本快照丢弃 → 包不完整；此时若保留会让 import 崩
// （Pyodide 异步加载 .so 失败以 processImmediate 逃逸）。因此不完整包在启动时被移除，
// 恢复路径 = 用户再次 `pip install <pkg>`（会干净重装）。这是如实记录的边界，不假装。
async function restorePersisted(): Promise<void> {
  const specs = loadManifest();
  if (specs.length === 0) return;
  for (const spec of specs) {
    try {
      if (!needsReinstall(spec)) continue;
      uninstallPackage(spec);
      saveManifest(loadManifest().filter((s) => s !== spec));
      note(`dropped incomplete package (binary .so not persisted in text snapshot): ${spec}`);
    } catch (e) {
      note(`persistence scan failed for ${spec}: ${formatError(e).split('\n')[0]}`);
    }
  }
}

// ─── 命令处理 ───
async function handlePipInstall(pkgs: string[]): Promise<number> {
  await ensureMicropip();
  try {
    // 已安装（含陈旧/不完整）→ 先干净卸载再装，保证重装可恢复。
    for (const p of pkgs) {
      if (distInfoDirs(specName(p)).length > 0) uninstallPackage(p);
    }
    await pipInstallSpec(pkgs);
    const specs = loadManifest();
    for (const p of pkgs) {
      if (!specs.includes(p)) specs.push(p);
    }
    saveManifest(specs);
    return 0;
  } catch (e) {
    if (!errBuf) errBuf = formatError(e);
    return 1;
  }
}

function handlePipList(): number {
  outBuf = '';
  errBuf = '';
  try {
    pyodide.runPython(
      `import importlib.metadata as md
names = sorted(md.distributions(), key=lambda d: (d.metadata['Name'] or '').lower())
for d in names:
    print(d.metadata['Name'] + ' ' + d.version)
`
    );
    return 0;
  } catch (e) {
    if (!errBuf) errBuf = formatError(e);
    return 1;
  }
}

async function handlePipUninstall(pkgs: string[]): Promise<number> {
  const specs = loadManifest();
  let removed = false;
  for (const p of pkgs) {
    const name = specName(p);
    if (distInfoDirs(name).length > 0) {
      uninstallPackage(p);
      removed = true;
    }
    const i = specs.findIndex((s) => specName(s) === name);
    if (i >= 0) specs.splice(i, 1);
  }
  saveManifest(specs);
  if (removed) {
    outBuf = '';
    errBuf = '';
    outBuf = `Successfully uninstalled ${pkgs.join(' ')}\n`;
    return 0;
  }
  errBuf = `pip: package ${pkgs.join(' ')} is not installed\n`;
  return 1;
}

async function handlePip(args: string[]): Promise<number> {
  const sub = args[0] ?? '';
  if (sub === '' || sub === 'help') {
    outBuf = '';
    errBuf = '';
    outBuf = 'Usage: pip <command> [options]\n\nCommands:\n  install <pkg>    install packages via micropip (PyPI / Pyodide wheels)\n  uninstall <pkg>  uninstall a package\n  list             list installed packages\n  show <pkg>       show package metadata\n  --version        show pip (micropip) version\n';
    return 0;
  }
  if (sub === '--version' || sub === '-V') {
    outBuf = '';
    errBuf = '';
    await ensureMicropip();
    pyodide.runPython('import micropip; print("pip " + micropip.__version__ + " (micropip, Pyodide)")');
    return 0;
  }
  if (sub === 'install') {
    if (args.length < 2) {
      errBuf = 'pip: install requires at least one package\n';
      return 2;
    }
    return handlePipInstall(args.slice(1));
  }
  if (sub === 'list') return handlePipList();
  if (sub === 'uninstall') return handlePipUninstall(args.slice(1));
  if (sub === 'show') {
    if (args.length < 2) {
      // 真实 pip：缺包名参数 → 输出 usage 并 exit 2（TASK27 复审项 2）。
      // 此前 `args[1] ?? ''` 会生成 md.distribution('') → NameError → exit 1，非 pip 式提示。
      outBuf = '';
      errBuf = '';
      errBuf = 'Usage: pip show <package>\n';
      return 2;
    }
    outBuf = '';
    errBuf = '';
    try {
      pyodide.runPython(
        `import importlib.metadata as md
try:
    d = md.distribution(${JSON.stringify(args[1])})
    print('Name: ' + (d.metadata['Name'] or '?'))
    print('Version: ' + d.version)
    print('Summary: ' + (d.metadata['Summary'] or ''))
except Exception:
    raise SystemExit('pip: package not found')
`
      );
      return 0;
    } catch (e) {
      if (!errBuf) errBuf = formatError(e);
      return 1;
    }
  }
  errBuf = `pip: unknown command '${sub}' (supported: install, uninstall, list, show, --version)\n`;
  return 2;
}

function handleC(code: string): number {
  outBuf = '';
  errBuf = '';
  try {
    pyodide.runPython(code);
    return 0;
  } catch (e) {
    if (!errBuf) errBuf = formatError(e);
    errBuf = appendInstallHint(errBuf);
    return 1;
  }
}

function handleScript(scriptArg: string, cwd: string | undefined): number {
  // 脚本路径：host 已把 /foo 与 /workspace/foo 映射为真实绝对路径；相对路径按请求 cwd 解析。
  const realPath = scriptArg.startsWith('/') ? scriptArg : path.resolve(cwd || CWD, scriptArg);
  let code: string;
  try {
    code = fs.readFileSync(realPath, 'utf8');
  } catch (e) {
    errBuf = `python: can't open file '${scriptArg}': ${e instanceof Error ? e.message : String(e)}\n`;
    return 2;
  }
  outBuf = '';
  errBuf = '';
  try {
    pyodide.runPython(code);
    return 0;
  } catch (e) {
    if (!errBuf) errBuf = formatError(e);
    errBuf = appendInstallHint(errBuf);
    return 1;
  }
}

function handleVersion(): number {
  outBuf = '';
  errBuf = '';
  try {
    pyodide.runPython(`import sys; print("Python " + sys.version.split()[0])`);
    return 0;
  } catch {
    outBuf = `Python ${PYTHON_VERSION}\n`;
    return 0;
  }
}

async function handleM(target: string, rest: string[]): Promise<number> {
  if (target === 'pip' || target === 'pip3') return handlePip(rest);
  outBuf = '';
  errBuf = '';
  try {
    await pyodide.runPythonAsync(
      `import runpy, sys
sys.argv = ${JSON.stringify(['', ...rest])}
runpy.run_module(${JSON.stringify(target)}, run_name='__main__')
`
    );
    return 0;
  } catch (e) {
    if (!errBuf) errBuf = formatError(e);
    errBuf = appendInstallHint(errBuf);
    return 1;
  }
}

async function handleRequest(req: PydRequest): Promise<{ code: number }> {
  const args = req.args ?? [];
  // 先跟随会话 cwd（相对路径读写 / os.getcwd() 语义）。
  setPythonCwd(req.cwd);
  const first = args[0];
  if (first === undefined) {
    errBuf =
      'python: interactive REPL is not supported here; use: python -c "<code>" | python <script.py> | python -m pip <cmd>\n';
    return { code: 1 };
  }
  if (first === '--version' || first === '-V') return { code: handleVersion() };
  if (first === '-c') {
    const code = args[1];
    if (code === undefined) {
      errBuf = 'python: -c requires an argument: python -c "<code>"\n';
      return { code: 2 };
    }
    return { code: handleC(code) };
  }
  if (first === '-m') {
    const target = args[1];
    if (target === undefined) {
      errBuf = 'python: -m requires a module name: python -m <module>\n';
      return { code: 2 };
    }
    return { code: await handleM(target, args.slice(2)) };
  }
  if (first.startsWith('-')) {
    errBuf = `python: unknown option '${first}'\n`;
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
