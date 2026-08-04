// 包管理封装（TASK13）：pkg 命令族，统一 lifo + npm 两通道。
// 通道：
//   lifo —— 真实命令：lifo list / lifo search <term> / lifo install <name> / lifo remove <name>
//           （lifo 是 Lifo 扩展包管理器：安装 lifo-pkg-<name>，如 git/ffmpeg/vi/nano）
//   npm  —— 真 Node（host 统一路由 node|npm|npx → 子进程）：npm install / npm uninstall /
//            npm search / npm view；已装列表读 node_modules 顶层目录（"顶层直装"简化，
//            不解析依赖树，README 已注明）。
// 来源判定：lifo-pkg-<name> 在 npm 上存在（lifo search <name> 命中）→ lifo；否则 → npm。
// 同名冲突优先 lifo（工具类，README 注明规则）。
// 约束：网络类操作失败按"已知边界"处理 —— 明确提示原因，不吞错、不假装成功。
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from './terminal-client.js';
import { log } from './log.js';

export interface PackageEntry {
  name: string;
  source: 'lifo' | 'npm';
  version: string;
}

export interface SearchEntry {
  name: string;
  version: string;
  description: string;
  source: 'lifo' | 'npm';
}

export interface PkgContext {
  wc: WebContainer;
  client: TerminalClient;
}

// 命令执行结果：install/remove 共享同一形状。outputTail 为真实命令 stdout 尾部
// （调用方原样呈现，兑现"输出真实命令反馈"）；message 为成功/失败摘要。
export interface ActionResult {
  ok: boolean;
  message: string;
  source?: 'lifo' | 'npm';
  outputTail?: string;
}

// 搜索结果 + 通道可用性提示（lifo/npm 任一侧网络失败时给出，不吞错）。
export interface SearchOutcome {
  entries: SearchEntry[];
  notes: string[];
}

// 网络类操作统一超时：opts.timeout 是 host 侧 kill 子进程/Lifo 超时，wait 是浏览器 RPC 等待上限。
const TIMEOUT = {
  lifoSearch: { opts: { timeout: 20000 }, wait: 30000 },
  npmSearch: { opts: { timeout: 25000 }, wait: 35000 },
  install: { opts: { timeout: 120000 }, wait: 150000 },
  view: { opts: { timeout: 30000 }, wait: 45000 },
  remove: { opts: { timeout: 60000 }, wait: 90000 },
};

// 输出尾部截断：install/remove 回显真实命令 stdout 的尾部，避免刷屏。
const OUTPUT_TAIL_CHARS = 600;

// lifo 包名归一：lifo-pkg-<name> → <name>（lifo search 内部按 lifo-pkg-<term> 搜索，
// 传原始前缀会搜成 lifo-pkg-lifo-pkg-<name>；install/remove 两形式都接受，这里统一成裸名）。
function lifoTerm(name: string): string {
  return name.startsWith('lifo-pkg-') ? name.slice('lifo-pkg-'.length) : name;
}

// 包名校验（TASK16）：拒绝空名 / 含空白 / 以 - 开头。
// 合法：@scope/name（scope 与 name 均为 [a-zA-Z0-9-_.]+）或裸名 [a-zA-Z0-9-_.]+。
// 保证 pkg install --help 之类不当作真实包名去装（-- 开头一律拒绝，不返回假成功）。
export function isValidPackageName(name: string): boolean {
  if (!name) return false;
  if (name !== name.trim()) return false; // 首尾空白拒绝
  if (/\s/.test(name)) return false; // 内部空白拒绝
  if (name.startsWith('-')) return false;
  if (name.startsWith('@')) return /^@[A-Za-z0-9-_.]+\/[A-Za-z0-9-_.]+$/.test(name);
  return /^[A-Za-z0-9-_.]+$/.test(name);
}

// 命令参数双引号包裹：包名/搜索词可能含 @ 前缀等 shell 特殊字符，插值进命令必须加引号（TASK16）。
function q(name: string): string {
  return `"${name}"`;
}

// ─── lifo 通道 ───

// lifo list 输出解析：Installed 段每行 "  <name>@<version>  [commands]"。Dev-linked 行是
// "  <name>  <path>  [commands]"，不是安装，跳过。"No lifo packages installed" → 空。
async function listLifo(client: TerminalClient): Promise<PackageEntry[]> {
  try {
    const r = await client.terminal('lifo list', undefined, 20000);
    if (!r.ok) return [];
    const out: PackageEntry[] = [];
    for (const raw of String(r.stdout ?? '').split('\n')) {
      const m = /^\s+([^\s@]+)@(\S+)\s+\[/.exec(raw);
      if (m) out.push({ name: m[1], source: 'lifo', version: m[2] });
    }
    return out;
  } catch {
    // lifo 通道不可达：按空列表处理，不阻断 npm 侧合并。
    return [];
  }
}

// lifo search 输出解析：固定宽表 NAME 30 / VERSION 12 / DESCRIPTION（lifo 内核源码 padEnd 对齐）。
// 表头行以 NAME 开头、分隔行以 ---- 开头，都跳过。
function parseLifoSearch(stdout: string): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('NAME') || line.startsWith('---')) continue;
    const name = line.slice(0, 30).trim();
    const version = line.slice(30, 42).trim();
    if (!name || !version) continue;
    out.push({ name, version, description: line.slice(42).trim(), source: 'lifo' });
  }
  return out;
}

async function lifoSearch(client: TerminalClient, term: string): Promise<{ entries: SearchEntry[]; available: boolean }> {
  const t = lifoTerm(term);
  if (!t) return { entries: [], available: false };
  try {
    const r = await client.terminal(`lifo search "${t}"`, TIMEOUT.lifoSearch.opts, TIMEOUT.lifoSearch.wait);
    if (r.ok) return { entries: parseLifoSearch(String(r.stdout ?? '')), available: true };
    return { entries: [], available: false };
  } catch {
    return { entries: [], available: false };
  }
}

// ─── npm 通道 ───

// 读一个已装 npm 包的版本：/node_modules/<dir>/package.json；缺失/损坏显示 ?。
async function npmPackageEntry(wc: WebContainer, dir: string): Promise<PackageEntry | null> {
  let version = '?';
  try {
    const raw = await wc.fs.readFile(`/node_modules/${dir}/package.json`, 'utf8');
    version = String((JSON.parse(raw) as { version?: unknown }).version ?? '?');
  } catch {
    /* package.json 缺失/损坏：版本列显示 ? */
  }
  return { name: dir, source: 'npm', version };
}

// npm 已装列表：node_modules 顶层目录名即已装包（"顶层直装"简化）。
// scoped 包是 @scope 目录下的子目录，展开成 @scope/name；. 开头目录（.bin 等）跳过。
async function listNpm(wc: WebContainer): Promise<PackageEntry[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await wc.fs.readdir('/node_modules', { withFileTypes: true });
  } catch {
    return []; // node_modules 不存在（尚未安装任何 npm 包）
  }
  const out: PackageEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      try {
        const subs = await wc.fs.readdir(`/node_modules/${e.name}`, { withFileTypes: true });
        for (const s of subs) {
          if (s.isDirectory()) {
            const p = await npmPackageEntry(wc, `${e.name}/${s.name}`);
            if (p) out.push(p);
          }
        }
      } catch {
        /* 读取该 scope 失败：跳过 */
      }
    } else {
      const p = await npmPackageEntry(wc, e.name);
      if (p) out.push(p);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// npm search：真 Node npm，--json 输出结构化结果。lifo-pkg-* 结果过滤掉 ——
// lifo 系由 lifo 通道呈现，避免同名重复（lifo 侧 NAME 是裸名，npm 侧是 lifo-pkg- 前缀）。
async function npmSearch(client: TerminalClient, term: string): Promise<{ entries: SearchEntry[]; available: boolean }> {
  try {
    const r = await client.terminal(`npm search "${term}" --json`, TIMEOUT.npmSearch.opts, TIMEOUT.npmSearch.wait);
    if (!r.ok || !String(r.stdout ?? '').trim()) return { entries: [], available: false };
    let data: Array<Record<string, unknown>>;
    try {
      data = JSON.parse(String(r.stdout)) as Array<Record<string, unknown>>;
    } catch {
      return { entries: [], available: false }; // 非 JSON（registry 异常）
    }
    const entries: SearchEntry[] = [];
    for (const o of data) {
      const name = String(o.name ?? '');
      if (!name || name.startsWith('lifo-pkg-')) continue;
      entries.push({
        name,
        version: String(o.version ?? '?'),
        description: String(o.description ?? ''),
        source: 'npm',
      });
    }
    return { entries, available: true };
  } catch {
    return { entries: [], available: false };
  }
}

// ─── 合并视图 ───

// 已安装列表：两条通道合并去重，同名冲突优先 lifo（工具类优先）。
export async function listPackages(ctx: PkgContext): Promise<PackageEntry[]> {
  const [lifo, npm] = await Promise.all([listLifo(ctx.client), listNpm(ctx.wc)]);
  const map = new Map<string, PackageEntry>();
  for (const e of npm) map.set(e.name, e); // 先 npm
  for (const e of lifo) map.set(e.name, e); // lifo 覆盖 → 同名冲突优先 lifo
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// pkg list 表格：Packages / NAME SOURCE VERSION / 行。空表也保留表头（自检断言两通道表头在）。
export function formatPackageList(entries: PackageEntry[]): string[] {
  const lines = ['Packages'];
  const nameW = Math.max(4, ...entries.map((e) => e.name.length)) + 2;
  const srcW = Math.max(6, ...entries.map((e) => e.source.length)) + 2;
  lines.push('  ' + 'NAME'.padEnd(nameW) + 'SOURCE'.padEnd(srcW) + 'VERSION');
  if (entries.length === 0) {
    lines.push('  (none installed)');
    return lines;
  }
  for (const e of entries) {
    lines.push(`  ${e.name.padEnd(nameW)}${e.source.padEnd(srcW)}${e.version}`);
  }
  return lines;
}

// 搜索：lifo + npm 两通道合并（并行，互不阻塞），通道网络失败进 notes 不吞错。
export async function searchPackages(ctx: PkgContext, term: string): Promise<SearchOutcome> {
  const [lifo, npm] = await Promise.all([lifoSearch(ctx.client, term), npmSearch(ctx.client, term)]);
  const notes: string[] = [];
  if (!lifo.available) notes.push('(lifo search unavailable — registry/network error)');
  if (!npm.available) notes.push('(npm search unavailable — registry/network error)');
  const map = new Map<string, SearchEntry>();
  for (const e of npm.entries) map.set(e.name, e);
  for (const e of lifo.entries) map.set(e.name, e); // lifo 优先
  return {
    entries: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)),
    notes,
  };
}

// pkg search 表格：Search results for '<term>' / NAME SOURCE VERSION DESCRIPTION / 行。
// description 超长截断（一行 56 列上限，超出以 ... 收尾）。
export function formatSearchResults(term: string, entries: SearchEntry[]): string[] {
  const lines = [`Search results for '${term}'`];
  if (entries.length === 0) {
    lines.push('  (no results)');
    return lines;
  }
  const nameW = Math.max(4, ...entries.map((e) => e.name.length)) + 2;
  const srcW = Math.max(6, ...entries.map((e) => e.source.length)) + 2;
  lines.push('  ' + 'NAME'.padEnd(nameW) + 'SOURCE'.padEnd(srcW) + 'VERSION'.padEnd(10) + 'DESCRIPTION');
  for (const e of entries) {
    const desc = e.description.length > 56 ? `${e.description.slice(0, 53)}...` : e.description;
    lines.push(`  ${e.name.padEnd(nameW)}${e.source.padEnd(srcW)}${e.version.padEnd(10)}${desc}`);
  }
  return lines;
}

// ─── 来源判定 ───

// lifo 系判定：显式 lifo-pkg- 前缀 → 直接 lifo；否则 lifo search <name> 命中 lifo-pkg-<name> → lifo；
// 探测失败（网络不可达）回落 npm 并标记 fellBack（TASK16：调用方输出附加
// "(lifo unavailable — fell back to npm)" 提示，不吞错）。
async function detectSource(ctx: PkgContext, name: string): Promise<{ source: 'lifo' | 'npm'; fellBack: boolean }> {
  if (name.startsWith('lifo-pkg-')) return { source: 'lifo', fellBack: false };
  const base = lifoTerm(name);
  try {
    const r = await ctx.client.terminal(`lifo search ${q(base)}`, TIMEOUT.lifoSearch.opts, TIMEOUT.lifoSearch.wait);
    // lifo 通道可达但无此包 → 正当 npm（不标记回落）；通道不可达 → 回落 npm 并标记。
    if (r.ok && parseLifoSearch(String(r.stdout ?? '')).some((h) => h.name === base)) return { source: 'lifo', fellBack: false };
    if (r.ok) return { source: 'npm', fellBack: false };
    return { source: 'npm', fellBack: true };
  } catch {
    return { source: 'npm', fellBack: true };
  }
}

// ─── install / remove / info ───

// pkg install <name>：按来源判定走 lifo 或 npm；回显真实命令 stdout 尾部 + 成功/失败摘要。
export async function installPackage(ctx: PkgContext, rawName: string): Promise<ActionResult> {
  const name = rawName.trim();
  if (!name) return { ok: false, message: 'pkg install: package name required' };
  if (!isValidPackageName(name)) {
    return { ok: false, message: `pkg install: invalid package name '${name}' (scoped @scope/name or [a-zA-Z0-9-_.]+, no whitespace, no leading dash)` };
  }
  const base = lifoTerm(name);

  const { source, fellBack } = await detectSource(ctx, name);
  const hint = fellBack ? ' (lifo unavailable — fell back to npm)' : '';
  if (source === 'lifo') {
    const r = await ctx.client.terminal(`lifo install ${q(base)}`, TIMEOUT.install.opts, TIMEOUT.install.wait);
    const out = String(r.stdout ?? '').trim();
    if (r.ok) {
      void log('INFO', `pkg install: ${base} via lifo`);
      return { ok: true, message: `'${base}' installed (source: lifo)`, source: 'lifo', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
    }
    const why = r.stderr || out || r.error || 'lifo install exited non-zero';
    void log('WARN', `pkg install failed: ${base} via lifo (${String(why).slice(0, 120)})`);
    return { ok: false, message: `install failed: ${String(why).slice(0, 300)}`, source: 'lifo', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
  }

  const r = await ctx.client.terminal(`npm install ${q(name)} --no-audit --no-fund`, TIMEOUT.install.opts, TIMEOUT.install.wait);
  const out = String(r.stdout ?? '').trim();
  if (r.ok) {
    void log('INFO', `pkg install: ${name} via npm`);
    return { ok: true, message: `'${name}' installed (source: npm)${hint}`, source: 'npm', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
  }
  const why = r.stderr || out || r.error || 'npm install exited non-zero';
  void log('WARN', `pkg install failed: ${name} via npm (${String(why).slice(0, 120)})`);
  return { ok: false, message: `install failed: ${String(why).slice(0, 300)}`, source: 'npm', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
}

// pkg remove <name>：按已装来源走对应通道（同名冲突优先 lifo，与 list 判定一致）。
export async function removePackage(ctx: PkgContext, rawName: string): Promise<ActionResult> {
  const name = rawName.trim();
  if (!name) return { ok: false, message: 'pkg remove: package name required' };
  if (!isValidPackageName(name)) {
    return { ok: false, message: `pkg remove: invalid package name '${name}' (scoped @scope/name or [a-zA-Z0-9-_.]+, no whitespace, no leading dash)` };
  }
  const base = lifoTerm(name);

  if ((await listLifo(ctx.client)).some((p) => p.name === base)) {
    const r = await ctx.client.terminal(`lifo remove ${q(base)}`, TIMEOUT.remove.opts, TIMEOUT.remove.wait);
    const out = String(r.stdout ?? '').trim();
    if (r.ok) {
      void log('INFO', `pkg remove: ${base} via lifo`);
      return { ok: true, message: `'${base}' removed (source: lifo)`, source: 'lifo', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
    }
    const why = r.stderr || out || r.error || 'lifo remove exited non-zero';
    void log('WARN', `pkg remove failed: ${base} via lifo (${String(why).slice(0, 120)})`);
    return { ok: false, message: `remove failed: ${String(why).slice(0, 300)}`, source: 'lifo', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
  }

  if ((await listNpm(ctx.wc)).some((p) => p.name === name)) {
    const r = await ctx.client.terminal(`npm uninstall ${q(name)} --no-audit --no-fund`, TIMEOUT.remove.opts, TIMEOUT.remove.wait);
    const out = String(r.stdout ?? '').trim();
    if (r.ok) {
      void log('INFO', `pkg remove: ${name} via npm`);
      return { ok: true, message: `'${name}' removed (source: npm)`, source: 'npm', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
    }
    const why = r.stderr || out || r.error || 'npm uninstall exited non-zero';
    void log('WARN', `pkg remove failed: ${name} via npm (${String(why).slice(0, 120)})`);
    return { ok: false, message: `remove failed: ${String(why).slice(0, 300)}`, source: 'npm', outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
  }

  void log('WARN', `pkg remove: ${name} not installed`);
  return { ok: false, message: `'${name}' is not installed (nothing to remove)` };
}

// pkg info <name>：来源判定（lifo 优先）→ 版本/描述。entry 供调用方渲染。
export async function packageInfo(ctx: PkgContext, rawName: string): Promise<{ ok: boolean; message: string; entry?: SearchEntry }> {
  const name = rawName.trim();
  if (!name) return { ok: false, message: 'pkg info: package name required' };
  if (!isValidPackageName(name)) {
    return { ok: false, message: `pkg info: invalid package name '${name}' (scoped @scope/name or [a-zA-Z0-9-_.]+, no whitespace, no leading dash)` };
  }
  const base = lifoTerm(name);

  // lifo 探测（来源判定规则）：命中即返回 lifo 侧信息；探测失败标记回落，供失败提示附加。
  let lifoProbeFailed = false;
  try {
    const r = await ctx.client.terminal(`lifo search ${q(base)}`, TIMEOUT.lifoSearch.opts, TIMEOUT.lifoSearch.wait);
    if (r.ok) {
      const hit = parseLifoSearch(String(r.stdout ?? '')).find((h) => h.name === base);
      if (hit) return { ok: true, message: '', entry: hit };
    }
  } catch {
    lifoProbeFailed = true; /* registry 探测失败 → 走 npm view */
  }

  // npm 通道：npm view <name> name version description --json（真 Node，registry 探测）。
  try {
    const r = await ctx.client.terminal(`npm view ${q(name)} name version description --json`, TIMEOUT.view.opts, TIMEOUT.view.wait);
    if (r.ok && String(r.stdout ?? '').trim()) {
      const o = JSON.parse(String(r.stdout)) as Record<string, unknown>;
      return {
        ok: true,
        message: '',
        entry: {
          name: String(o.name ?? name),
          version: String(o.version ?? '?'),
          description: String(o.description ?? ''),
          source: 'npm',
        },
      };
    }
    const why = r.stderr || String(r.stdout ?? '').trim().slice(0, 120) || r.error || 'npm view exited non-zero';
    const fallback = lifoProbeFailed ? ' (lifo unavailable — fell back to npm)' : '';
    return { ok: false, message: `'${name}' not found: ${why}${fallback}` };
  } catch (e) {
    const fallback = lifoProbeFailed ? ' (lifo unavailable — fell back to npm)' : '';
    return { ok: false, message: `'${name}' not found: ${String(e).slice(0, 200)}${fallback}` };
  }
}
