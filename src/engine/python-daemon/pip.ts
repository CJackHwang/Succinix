// pip 命令 + 持久化恢复（O7 拆分自 python-daemon.ts）。
// 职责：manifest 读写、完整度检查（.so 边界）、卸载、micropip 安装、restorePersisted、
// pip install/list/uninstall/show/--version 各子命令。
import fs from 'node:fs';
import path from 'node:path';
import {
  getPyodide,
  note,
  errBuf,
  resetOutput,
  setError,
  setOutput,
  SITE_PACKAGES,
  MANIFEST_FILE,
  PY_SITE,
  PERSIST_DIR,
} from './loader.js';
import { formatError } from './rpc.js';

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
  const fsapi = getPyodide().FS;
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
export function ensureMicropip(): Promise<void> {
  if (!micropipReady) {
    micropipReady = getPyodide()
      .loadPackage('micropip')
      .then(() => undefined)
      .catch(() => undefined);
  }
  return micropipReady;
}

// micropip.install 支持数组（逐个按 PEP 508 解析），与真实 pip 的多包语义一致（TASK27 复审项 1）。
// 此前 `pkgs.join(' ')` 拼成一个字符串会被当单个 requirement 拒掉。
async function pipInstallSpec(specs: string[]): Promise<void> {
  await ensureMicropip();
  await getPyodide().runPythonAsync(
    `import micropip\nawait micropip.install(${JSON.stringify(specs)})\nprint("installed: " + ${JSON.stringify(specs.join(' '))})`
  );
}

// 启动恢复（尽力而为 + 明确边界）：manifest 里的包若缺失/不完整 → 清掉并移出 manifest。
// 纯 Python wheel 全部是文本文件 → NODEFS 站点包随快照完整恢复，import 直接可用。
// 编译包（numpy 等）的 .so 是二进制 → 文本快照丢弃 → 包不完整；此时若保留会让 import 崩
// （Pyodide 异步加载 .so 失败以 processImmediate 逃逸）。因此不完整包在启动时被移除，
// 恢复路径 = 用户再次 `pip install <pkg>`（会干净重装）。这是如实记录的边界，不假装。
export async function restorePersisted(): Promise<void> {
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

// ─── pip 子命令 ───
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
    if (!errBuf) setError(formatError(e));
    return 1;
  }
}

function handlePipList(): number {
  resetOutput();
  try {
    getPyodide().runPython(
      `import importlib.metadata as md
names = sorted(md.distributions(), key=lambda d: (d.metadata['Name'] or '').lower())
for d in names:
    print(d.metadata['Name'] + ' ' + d.version)
`
    );
    return 0;
  } catch (e) {
    if (!errBuf) setError(formatError(e));
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
    setOutput(`Successfully uninstalled ${pkgs.join(' ')}\n`);
    return 0;
  }
  setError(`pip: package ${pkgs.join(' ')} is not installed\n`);
  return 1;
}

export async function handlePip(args: string[]): Promise<number> {
  const sub = args[0] ?? '';
  if (sub === '' || sub === 'help') {
    setOutput('Usage: pip <command> [options]\n\nCommands:\n  install <pkg>    install packages via micropip (PyPI / Pyodide wheels)\n  uninstall <pkg>  uninstall a package\n  list             list installed packages\n  show <pkg>       show package metadata\n  --version        show pip (micropip) version\n');
    return 0;
  }
  if (sub === '--version' || sub === '-V') {
    resetOutput();
    await ensureMicropip();
    getPyodide().runPython('import micropip; print("pip " + micropip.__version__ + " (micropip, Pyodide)")');
    return 0;
  }
  if (sub === 'install') {
    if (args.length < 2) {
      setError('pip: install requires at least one package\n');
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
      setError('Usage: pip show <package>\n');
      return 2;
    }
    resetOutput();
    try {
      getPyodide().runPython(
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
      if (!errBuf) setError(formatError(e));
      return 1;
    }
  }
  setError(`pip: unknown command '${sub}' (supported: install, uninstall, list, show, --version)\n`);
  return 2;
}
