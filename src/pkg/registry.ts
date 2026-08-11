// 包通道与合并视图（O10 拆分自 pkg.ts）：lifo list/search 与 npm node_modules 列表/search
// 两条通道的读取、解析、合并，以及 install/remove/info 共用的来源判定。
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from '../engine/index.js';
import { lifoTerm, q, parseLifoSearch, TIMEOUT, type PackageEntry, type PkgContext, type SearchEntry, type SearchOutcome } from './metadata.js';

// lifo list 输出解析：Installed 段每行 "  <name>@<version>  [commands]"。Dev-linked 行是
// "  <name>  <path>  [commands]"，不是安装，跳过。"No lifo packages installed" → 空。
export async function listLifo(client: TerminalClient): Promise<PackageEntry[]> {
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
export async function listNpm(wc: WebContainer): Promise<PackageEntry[]> {
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

// ─── 来源判定 ───

// lifo 系判定：显式 lifo-pkg- 前缀 → 直接 lifo；否则 lifo search <name> 命中 lifo-pkg-<name> → lifo；
// 探测失败（网络不可达）回落 npm 并标记 fellBack（TASK16：调用方输出附加
// "(lifo unavailable — fell back to npm)" 提示，不吞错）。
export async function detectSource(ctx: PkgContext, name: string): Promise<{ source: 'lifo' | 'npm'; fellBack: boolean }> {
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
