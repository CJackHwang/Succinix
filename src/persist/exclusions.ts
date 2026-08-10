// 快照遍历排除规则（O4）：系统资产 / 重建缓存 / RPC 临时文件 / 实例 tinbase（D5），
// 以及同页多实例归属隔离（D4，excludedByInstanceScope）。

// ─── 排除规则（快照遍历时跳过，避免 node_modules 巨量 & RPC 临时文件 & 重建缓存）───
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git']);
// host.js / lifo-core.js：运行时注入的 host 进程脚本，非用户数据（随 boot 重新注入）；
// cmd.json：文件 RPC 通道文件；succinix.engine.json：引擎配置（TASK21，随 boot 重写，非用户数据）。
const EXCLUDED_FILES = new Set(['host.js', 'lifo-core.js', 'cmd.json', 'succinix.engine.json']);
// TASK23：内置语言运行时系统资产（/usr/lib/succinix —— python-runtime.js + wasm/zip，~13MB）。
// 系统资产懒注入、随 boot 重建，非用户数据；排除避免每次快照遍历读 13MB 二进制。
const EXCLUDED_PREFIXES = ['/usr/lib/succinix'];
// 结果文件：/result-<id>.json（文件 RPC 每请求独立结果文件，瞬态）。
const RESULT_FILE_RE = /^\/result-\d+\.json$/;

// 快照遍历的排除判定（导出供单测）。
export function isExcludedPath(path: string): boolean {
  if (EXCLUDED_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) return true;
  const segments = path.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if (EXCLUDED_DIRS.has(segments[i])) return true;
    if (segments[i] === '.tinbase') return true;
    // D5：实例状态根下的 tinbase 二进制 DB 目录（.succinix-<id>/tinbase）排除；
    // 默认实例的 /workspace/.tinbase 已由上方 `.tinbase` 段规则覆盖。
    if (segments[i].startsWith('.succinix-') && segments[i + 1] === 'tinbase') return true;
  }
  const base = segments[segments.length - 1] ?? '';
  return EXCLUDED_FILES.has(base) || RESULT_FILE_RE.test(path);
}

// D4：同页快照按实例归属隔离 —— 自己的状态根 / home 保留，其他实例的根排除。
export function excludedByInstanceScope(
  path: string,
  scope: { stateRoot?: string; home?: string },
  extraPrefixes: string[]
): boolean {
  if (extraPrefixes.some((p) => path === p || path.startsWith(p + '/'))) return true;
  const segments = path.split('/').filter(Boolean);
  const inOwnRoot = scope.stateRoot
    ? path === scope.stateRoot || path.startsWith(`${scope.stateRoot}/`)
    : false;
  for (let i = 0; i < segments.length; i++) {
    // 其他实例的状态根整棵排除（自己的保留，其 tinbase 由 isExcludedPath 排除）。
    if (segments[i].startsWith('.succinix-') && !inOwnRoot) return true;
    // 其他用户的 home 排除（自己的保留；无 home 的实例不拥有任何 users/*，整棵排除）。
    if (segments[i] === 'users' && segments[i + 1] !== undefined) {
      const own = scope.home;
      if (!own || !(path === own || path.startsWith(`${own}/`))) return true;
    }
  }
  return false;
}
