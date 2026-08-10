// 系统信息命令域：uname / motd / lang（O1 拆分）。
import type { Terminal } from '@xterm/xterm';
import { readMotd, writeMotd, resetMotd } from '../motd.js';
import { SUCCINIX_VERSION } from '../version.js';
import type { CommandContext } from './types.js';
// TASK27：内置语言运行时版本（lang 命令）。
// python 版本构建期固定：Pyodide 314.0.4 打包的 Python 3.14.2（sys.version 首段实测）；
// node 版本实时查询（node --version）；typescript 走 node 22 的 strip-types。
const PYTHON_BUNDLED_VERSION = '3.14.2 (Pyodide 314.0.4)';
const TS_RUNTIME_NOTE = 'via node --experimental-strip-types (Node 22)';

// ─── 系统信息（TASK15）：uname / motd ───

// uname：诚实数据，不冒充 Linux。内核标识写 js-runtime+webcontainer（保留项），
// 不编造 linux 版本号。架构从 UA 提取（x86_64 / arm64），缺失显示 unknown。
// uname -r 用 @webcontainer/api 运行时版本（浏览器侧拿不到容器 node 版本）。
// R1（TASK17）：版本改为构建期注入——vite.config.ts 的 define 从 node_modules 已安装
// 版本读入，依赖升级后自动跟随，不再硬编码 1.6.4（消除漂移，uname 不输出假数据）。
declare const __UNAME_RUNTIME__: string;

// 架构提取：UA 含 x86_64/amd64/Win64 → x86_64；aarch64/arm64 → arm64；否则 unknown。
export function detectUnameArch(): string {
  const ua = navigator.userAgent;
  if (/x86_64|amd64|Win64/.test(ua)) return 'x86_64';
  if (/aarch64|arm64/i.test(ua)) return 'arm64';
  return 'unknown';
}

// uname -r 的运行时版本（TASK17/R1）：构建期由 vite.config.ts 注入。vitest 环境无该全局
// （vite define 不作用于 vitest），typeof 守卫回落空串 —— 与 version.ts 的 SUCCINIX_VERSION
// 同款模式，让 uname 纯函数在单测里可调用。
const UNAME_RUNTIME: string = typeof __UNAME_RUNTIME__ === 'string' ? __UNAME_RUNTIME__ : '';

interface UnameFields {
  s: string; // 系统名（uname -s）
  n: string; // 主机名（uname -n，与提示符 guest@succinix 一致）
  version: string; // Succinix 版本
  v: string; // 内核标识（uname -v）
  r: string; // 运行时版本（uname -r）
  m: string; // 架构（uname -m）
  o: string; // 操作系统（uname -o）
}

function unameFields(): UnameFields {
  return {
    s: 'Succinix',
    n: 'succinix',
    version: SUCCINIX_VERSION,
    v: 'js-runtime+webcontainer',
    r: UNAME_RUNTIME,
    m: detectUnameArch(),
    o: 'browser-native',
  };
}

// 无参数 uname 摘要行（样例格式：系统名 版本 内核 运行时 架构）。
export function buildUnameLine(): string {
  const f = unameFields();
  return `${f.s} ${f.version} ${f.v} ${f.r} ${f.m}`;
}

// uname -r 输出：@webcontainer/api 运行时版本（R2 自检经命令分发路径断言用）。
export function unameRuntimeVersion(): string {
  return unameFields().r;
}

// uname -a 完整信息：全部字段一行（主机名 + 操作系统并入）。
export function buildUnameAllLine(): string {
  const f = unameFields();
  return `${f.s} ${f.n} ${f.version} ${f.v} ${f.r} ${f.m} ${f.o}`;
}

const UNAME_USAGE = 'usage: uname | uname -a | uname -s | uname -n | uname -r | uname -v | uname -m | uname -o';

// uname 命令族：无参数 → 摘要行；-a → 全部字段；单个/组合短 flag 按标准顺序输出对应字段。
export function unameCmd(term: Terminal, args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    term.writeln(UNAME_USAGE);
    return;
  }
  const flags = args.join('').replace(/^-+/, '');
  if (!flags) {
    term.writeln(buildUnameLine());
    return;
  }
  if (flags.includes('a')) {
    term.writeln(buildUnameAllLine());
    return;
  }
  const f = unameFields();
  const order: Array<keyof UnameFields> = ['s', 'n', 'r', 'v', 'm', 'o'];
  const parts: string[] = [];
  for (const ch of order) {
    if (flags.includes(ch)) parts.push(f[ch]);
  }
  if (parts.length === 0) {
    term.writeln(UNAME_USAGE);
    return;
  }
  term.writeln(parts.join(' '));
}

// motd：查看 / 设置 / 恢复登录横幅（/etc/succinix.motd，随快照持久）。
//   motd          查看当前内容
//   motd <text>   设置（多词用空格 join）
//   motd reset    恢复默认
export async function motdCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term, wc } = ctx;
  const inst = ctx.instanceId;
  const prefix = ctx.statePrefix;
  const sub = args[0] ?? '';
  if (sub === '') {
    const text = await readMotd(wc.fs, inst, prefix);
    term.writeln(text ?? '(no motd set)');
    return;
  }
  if (sub === 'reset') {
    await resetMotd(wc.fs, inst, prefix);
    term.writeln('motd reset to default');
    return;
  }
  const text = args.join(' ');
  await writeMotd(wc.fs, text, inst, prefix);
  term.writeln(`motd set: ${text}`);
}

// ─── 内置语言运行时（TASK23）：lang 命令 ───
// 列出系统内置语言与版本（系统资产，非用户安装）。python 版本构建期固定；node 实时查询。
export async function langCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === 'python' || sub === 'python3') {
    term.writeln(`Python ${PYTHON_BUNDLED_VERSION}`);
    return;
  }
  if (sub === 'node') {
    term.writeln(`Node.js ${await nodeVersion(ctx)}`);
    return;
  }
  if (sub === 'typescript' || sub === 'ts' || sub === 'tsx') {
    term.writeln(`TypeScript ${TS_RUNTIME_NOTE}`);
    return;
  }
  if (sub === '') {
    term.writeln('Built-in language runtimes');
    term.writeln(`  node        Node.js ${await nodeVersion(ctx)}`);
    term.writeln(`  python      Python ${PYTHON_BUNDLED_VERSION}`);
    term.writeln(`  typescript  ${TS_RUNTIME_NOTE}`);
    return;
  }
  term.writeln(`lang: unknown language '${sub}' (known: node, python, typescript)`);
}

// node 版本实时查询（node --version 走 host 路由）；失败显示 --（不阻塞 lang 输出）。
async function nodeVersion(ctx: CommandContext): Promise<string> {
  try {
    const r = await ctx.client.terminal('node --version', undefined, 15000);
    if (r.ok) return String(r.stdout ?? '').trim();
  } catch {
    /* host 不可达：显示 -- */
  }
  return '--';
}
