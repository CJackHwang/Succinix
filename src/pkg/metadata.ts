// 包管理元数据与纯函数（O10 拆分自 pkg.ts）：类型、超时/截断常量、包名校验、
// lifo search 输出解析、表格格式化。无 IO 依赖。
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from '../engine/index.js';

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
export const TIMEOUT = {
  lifoSearch: { opts: { timeout: 20000 }, wait: 30000 },
  npmSearch: { opts: { timeout: 25000 }, wait: 35000 },
  install: { opts: { timeout: 120000 }, wait: 150000 },
  view: { opts: { timeout: 30000 }, wait: 45000 },
  remove: { opts: { timeout: 60000 }, wait: 90000 },
};

// 输出尾部截断：install/remove 回显真实命令 stdout 的尾部，避免刷屏。
export const OUTPUT_TAIL_CHARS = 600;

// lifo 包名归一：lifo-pkg-<name> → <name>（lifo search 内部按 lifo-pkg-<term> 搜索，
// 传原始前缀会搜成 lifo-pkg-lifo-pkg-<name>；install/remove 两形式都接受，这里统一成裸名）。
export function lifoTerm(name: string): string {
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
export function q(name: string): string {
  return `"${name}"`;
}

// lifo search 输出解析：固定宽表 NAME 30 / VERSION 12 / DESCRIPTION（lifo 内核源码 padEnd 对齐）。
// 表头行以 NAME 开头、分隔行以 ---- 开头，都跳过。
export function parseLifoSearch(stdout: string): SearchEntry[] {
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
