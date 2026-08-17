// host.ts 的纯逻辑抽取（P1-4）：无副作用、可单测的路由判定 / 路径映射 / 字符串处理。
// host.ts 保留进程生命周期与文件 RPC 编排；本模块是纯函数集合，vitest 门禁覆盖。
// 双根语义（TASK24）：浏览器 wc.fs 的 `/` == host 进程 cwd（/home/<wc-id>），Lifo 的
// /workspace 是同一目录的挂载别名。路径映射统一以 root = process.cwd() 为基准。
// 引擎自包含：本模块不 import 系统层（persist/log/config），只依赖 node 全局。

export const WORKSPACE_MOUNT = '/workspace';

/** Normalize an absolute execution-world path.  The returned value never has
 * duplicate separators, trailing separators, `.` segments, or unresolved
 * `..` segments. */
export function canonicalizeVirtualPath(raw: string): string {
  if (!raw || raw.includes('\0') || !raw.startsWith('/')) {
    throw new Error('path must be an absolute string');
  }
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

// 路径是否落在 /workspace 挂载下（Lifo 侧可同步会话 cwd 的判定）。
export function isUnderWorkspace(p: string): boolean {
  return p === WORKSPACE_MOUNT || p.startsWith(WORKSPACE_MOUNT + '/');
}

// ─── 命令路由前缀 ───

// 以 node / npm / npx 开头（后跟空格或直接结束）的整条命令 → 真 Node 子进程
export const NODE_PREFIX_RE = /^(node|npm|npx)(\s|$)/;
// TASK27：python / python3 开头 → 专用 python 运行时（host 常驻 Pyodide daemon）。
export const PYTHON_PREFIX_RE = /^(python|python3)(\s|$)/;
// TASK27：pip / pip3 命令 → 映射到 Pyodide 的 micropip（daemon 内 `-m pip <args>`）。
export const PIP_PREFIX_RE = /^(pip|pip3)(\s|$)/;
// TASK23：Lifo 的 cd 命令（成功后会同步会话 cwd）。只匹配整条命令以 cd 开头。
export const CD_PREFIX_RE = /^cd(\s|$)/;

// 路由类型：node / python 走真运行时；lifo 走 Lifo sandbox（含 node/python 混合链回退）。
export type RouteKind = 'node' | 'python' | 'lifo';

// 前缀判定：node|npm|npx → node；python|python3|pip|pip3 → python；其余 → lifo。
// 纯前缀（不含 shell 元字符决策）；混合链回退由 classifyRoute 组合。
export function classifyPrefix(command: string): RouteKind {
  if (NODE_PREFIX_RE.test(command)) return 'node';
  if (PYTHON_PREFIX_RE.test(command) || PIP_PREFIX_RE.test(command)) return 'python';
  return 'lifo';
}

// 统一路由（TASK24 坑 1）：node/python 系命令含 shell 元字符（&& / | / > / 2>&1 ...）时
// 整条回退给 Lifo shell 执行 —— Lifo 的 shell 层解析管道/重定向/链，各段经
// registerRealBinaryCommands 转回真二进制。结果 runtime 仍标 'lifo'（shell 层执行）。
export function classifyRoute(command: string, hasShellMeta: boolean): RouteKind {
  const prefix = classifyPrefix(command);
  if (prefix !== 'lifo' && hasShellMeta) return 'lifo';
  return prefix;
}

// ─── 会话 cwd / 路径映射（TASK23 / TASK24 双根修复）───

// VFS 路径 → host 真实路径：/workspace → root，/workspace/foo → root/foo。
// 非 /workspace 路径（真实路径 / 其他 VFS 私有路径）原样返回。
export function vfsToReal(p: string, root: string): string {
  p = canonicalizeVirtualPath(p);
  if (p === WORKSPACE_MOUNT) return root;
  if (p.startsWith(WORKSPACE_MOUNT + '/')) return root + p.slice(WORKSPACE_MOUNT.length);
  return p;
}

// 会话 cwd → spawn 真实 cwd（TASK24：子进程 spawn 前必须把 VFS 路径映射回 host 真实路径，
// 否则 chdir /workspace 会在 WebContainer 里挂起）。非 /workspace 路径原样使用。
export function spawnCwdFor(sessionCwd: string, root: string): string {
  return vfsToReal(sessionCwd, root);
}

// 终端用户视角绝对路径 → host 真实路径（Lifo 视图：Lifo 的 /workspace 挂载到 root，
// 所以 Lifo `/workspace/foo` 的真实位置是 root/foo）。node/python 子进程收到这类绝对
// 路径参数（如 `python /script.py`）时若原样传给真实容器根 `/`（bin/dev/etc...）会找不到
// 文件；映射后脚本可读。相对路径由 spawn cwd（真实路径）解析，原样返回。
// 注意：浏览器 wc.fs 的 `/workspace` 是 root/workspace（真实子目录），与 Lifo 视图不同；
// 浏览器侧计算出的路径（statePath/tinbaseDataDir 等）不经本函数，见 mapDataDirArgs。
export function resolveBrowserPath(p: string, root: string): string {
  if (!p.startsWith('/')) return p;
  p = canonicalizeVirtualPath(p);
  const rel = p === WORKSPACE_MOUNT ? '/' : p.startsWith(WORKSPACE_MOUNT + '/') ? p.slice(WORKSPACE_MOUNT.length) : p;
  return root + rel;
}

// M5 修复（2026-08 实测确认的 FS 模型）：node 子进程看到的是容器真实根
// （bin/dev/etc/home/...，其中没有 /workspace）；浏览器 wc.fs 的 `/` == host
// process.cwd()（/home/<wc-id>），浏览器 `/workspace` == cwd/workspace（真实子目录）。
// 因此浏览器侧计算出的绝对路径（实例状态根 `/workspace/.succinix-<id>/...` 等）必须
// 映射到 host 真实路径 `root + p` 才能被 node 进程访问（否则 ENOENT，实例模式
// `db start` 失败）。映射 `--data-dir <path>` 与 `--data-dir=<path>` 两种写法；
// 相对路径由 spawn cwd 解析，原样返回。
export function mapDataDirArgs(tokens: string[], root: string): string[] {
  const out = tokens.slice();
  for (let i = 0; i < out.length; i++) {
    const tok = out[i];
    if (tok === '--data-dir' && i + 1 < out.length) {
      const p = out[i + 1];
      if (p.startsWith('/')) out[i + 1] = root + p;
    } else if (tok.startsWith('--data-dir=')) {
      const p = tok.slice('--data-dir='.length);
      out[i] = `--data-dir=${p.startsWith('/') ? root + p : p}`;
    }
  }
  return out;
}

// python 运行时参数：脚本模式（第一个参数是文件路径，非 -c/--version）的绝对路径映射到 host
// 真实路径，否则 `python /script.py` 在真实容器根找不到浏览器写入的脚本。
export function pythonRuntimeArgs(rawArgs: string[], root: string): string[] {
  const first = rawArgs[0];
  if (first !== undefined && first !== '-c' && first !== '--version') {
    return [resolveBrowserPath(first, root), ...rawArgs.slice(1)];
  }
  return rawArgs;
}

// Lifo 混合链内真实二进制命令的 spawn cwd：Lifo 命令上下文的 VFS cwd 映射回 host 真实路径
// （链内 `cd /workspace/sub` 也能跟随）；非 /workspace 的 Lifo 私有路径回落会话 cwd。
export function lifoSpawndCwd(vfsCwd: string, sessionCwd: string, root: string): string {
  if (vfsCwd === WORKSPACE_MOUNT) return root;
  if (vfsCwd.startsWith(WORKSPACE_MOUNT + '/')) {
    return root + vfsCwd.slice(WORKSPACE_MOUNT.length);
  }
  return spawnCwdFor(sessionCwd, root);
}

// P5-16 复审：会话 cwd（Lifo 视图）→ 浏览器 wc.fs 可读路径。浏览器 `/` == host 进程
// process.cwd() == Lifo `/workspace` 挂载点，因此 /workspace → `/`、/workspace/proj → `/proj`；
// 其余回落根 `/`（host 真实路径如 /home/<wc-id> 的浏览器视图即根 `/`，Lifo 私有路径在
// 浏览器 FS 不可读也回落根）。Tab 补全按此定位「当前目录」。
export function sessionCwdToBrowserPath(cwd: string): string {
  if (cwd === WORKSPACE_MOUNT) return '/';
  if (cwd.startsWith(WORKSPACE_MOUNT + '/')) return cwd.slice(WORKSPACE_MOUNT.length);
  return '/';
}

/** 浏览器 wc.fs 的绝对路径转换为同一文件在 Lifo 挂载中的 cwd。浏览器根是
 * `process.cwd()`，Lifo 的 `/workspace` 也挂载到该根，因此浏览器 `/workspace/x`
 * 在 Lifo 中必须写成 `/workspace/workspace/x`。 */
export function browserPathToLifoCwd(path: string): string {
  const normalized = canonicalizeVirtualPath(path.startsWith('/') ? path : `/${path}`);
  return `${WORKSPACE_MOUNT}${normalized}`;
}

// 提示符目录标签（cd 后提示符随目录更新）：home 参数（缺省 /workspace = guest 现状）优先
// —— cwd === home → `~`，home 下 → `~/...`。其余沿用工作区根语义：/workspace → `~`，
// /workspace/proj → `~/proj`；其他路径（如初始的 host 真实路径 /home/<wc-id>）回落 `~`。
export function sessionCwdPromptLabel(cwd: string, home: string = WORKSPACE_MOUNT): string {
  if (cwd === home) return '~';
  if (cwd.startsWith(home + '/')) return '~' + cwd.slice(home.length);
  if (cwd === WORKSPACE_MOUNT || cwd.startsWith(WORKSPACE_MOUNT + '/')) {
    return '~' + cwd.slice(WORKSPACE_MOUNT.length);
  }
  return '~';
}

// cd 后 Lifo 新 cwd → 会话 cwd（TASK23 同步 + cd / 映射）。/workspace 下原样同步；
// Lifo VFS 根 `/` 映射到工作区根 /workspace（用户"cd / 回根目录"的直觉 —— 否则 isUnderWorkspace('/')
// 为 false，会话 cwd 不更新，回到根目录不可达）；其余（Lifo 私有路径如 /tmp，无 host 等价物）
// 返回 null 表示不同步（会话 cwd 保持旧值）。
export function lifoCwdToSessionCwd(lifoCwd: string): string | null {
  if (lifoCwd === '/') return WORKSPACE_MOUNT;
  if (isUnderWorkspace(lifoCwd)) return lifoCwd;
  return null;
}

// ─── 输出截断 / EACCES 提示 ───

// TASK18：单命令 stdout/stderr 各自最多保留的字符数（防超大输出 OOM）。正常命令
// （seq 1 5000 约 25KB / npm install 日志 / cat 中大型文件）远低于此上限。
export const MAX_OUTPUT_BYTES = 1024 * 1024;

// 输出截断：超出上限保留尾部（用户关心结尾）。在 settle 时应用最终截断。
export function capOutput(s: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength <= maxBytes) return s;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.slice(start));
}

// TASK24 坑 3：npm i -g 在 /usr/local 只读时的可操作提示。只在 stderr 含 EACCES + /usr/local
// 时**追加**一行（不替换原错误），权限语义保持（真实 Linux 同样无 sudo 装不了全局）。
export const EACCES_HINT =
  'hint: /usr/local is read-only for guest. Install locally: npm i <pkg>  (or set a user prefix: npm config set prefix ~/.npm-global)';

export function withEaccesHint(stderr: string, hint: string = EACCES_HINT): string {
  if (!stderr.includes('EACCES') || !stderr.includes('/usr/local')) return stderr;
  return `${stderr.replace(/\s+$/, '')}\n${hint}\n`;
}

// ─── kill 协议 pid 解析 ───
// 支持 { cmd: 'kill', opts: { pid } } 与 "kill 1234" 字符串形式。解析失败返回 NaN。
export function parseKillPid(cmd: string, optsPid: unknown): number {
  const fromOpts = Number(optsPid);
  if (Number.isInteger(fromOpts) && fromOpts > 0) return fromOpts;
  const m = /^kill\s+(\d+)$/.exec(cmd);
  return m ? Number(m[1]) : NaN;
}

// ─── /cmd.json 处理后的删除决策（P0-2）───
// 轮询循环处理完一个请求后应删除 /cmd.json，防陈旧命令在 host 重启（processedId 回到 -1）
// 后被新 host 当作新命令真实执行。但**只删「内容仍是刚处理的那个请求」的文件**：
// 若处理期间有绕过互斥队列的直接写入（pingDirect / interruptDirect）把 /cmd.json 覆盖成
// 新请求（如看门狗在 host 忙于长 Lifo 命令时写 ping），盲目删除会吞掉该请求 —— 看门狗
// 等不到 pong 误判 host 失联、Ctrl+C 中断丢失。保留它，下一轮轮询会读取并处理。
export function shouldRemoveCmdFile(processedId: number, currentJson: string | null): boolean {
  if (currentJson === null) return false; // 文件已被删除：无需再删
  try {
    const cur = JSON.parse(currentJson) as { id?: unknown };
    return typeof cur.id === 'number' && cur.id === processedId;
  } catch {
    return false; // 内容损坏 / 不可读：不删（下轮重读；解析错误由读取路径兜底）
  }
}

// ─── 实例状态路径（M2，host 侧；纯函数，供 host.ts 与单测）───
// 浏览器 /workspace/.succinix-<id>（wc.fs 视角）== host 真实路径 root/workspace/.succinix-<id>
// （root = process.cwd()）。缺省实例状态根 = root（/etc 即 root/etc，现状语义全等）。
// 本模块被终端 SDK bundle（dist/terminal.js）引用 —— 不引入 node: 依赖，纯字符串拼接。

export const DEFAULT_INSTANCE_ID = 'default';

/** 协议请求的 instanceId 归一化：缺失/空串 → 'default'（additive 向后兼容）。 */
export function normalizeInstanceId(raw: unknown): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_INSTANCE_ID;
}

/** host 侧实例状态根（DM-12：/workspace/.succinix-<id> 的 host 真实路径视图）。 */
export function instanceStateRootFor(instanceId: string, root: string): string {
  if (instanceId === DEFAULT_INSTANCE_ID) return root;
  return `${root}/workspace/.succinix-${instanceId}`;
}

/** 实例化状态文件路径（host 侧）：instanceStateFile('c-1', root, 'etc/succinix.env')。 */
export function instanceStateFile(instanceId: string, root: string, name: string): string {
  const clean = name.replace(/^\/+/, '');
  return `${instanceStateRootFor(instanceId, root)}/${clean}`;
}

// ─── 实例路由（M3，纯函数）───
// ps 过滤与 interrupt 分键是 host 协议按实例路由的核心，抽成纯函数供协议级单测。
// 归属以 host-procs 的启发式为准（scope/containerId），非安全边界。

/**
 * ps 响应按实例过滤：请求带 instanceId 时只返回该实例 + system 进程；
 * 缺省实例（'default'）不过滤（现状全等）。实例进程判定：
 *   - scope=system → 恒包含（运行时进程）；
 *   - containerId === `.succinix-<id>`（M2 实例状态根命名空间）→ 该实例；
 *   - containerId === `c-<id>`（CISOL 兼容命名空间，DM-12 共存）→ 同 id 归该实例；
 *   - 其余（unknown / 其他实例）→ 排除。
 */
export function filterProcessesForInstance<T extends { scope: string; containerId?: string }>(
  procs: T[],
  instanceId: string
): T[] {
  if (instanceId === DEFAULT_INSTANCE_ID) return procs;
  return procs.filter((p) => {
    if (p.scope === 'system') return true;
    // 状态根命名空间：containerId = `.succinix-<id>`；CISOL 兼容命名空间：containerId = `c-<id>`。
    // 两处 id 段都已含前缀（instanceIdFromPath 返回整段），直接整段比较。
    return p.containerId === `.succinix-${instanceId}` || p.containerId === instanceId;
  });
}

/**
 * kill 越权拒绝（U1，host 侧收口）：非默认实例的请求只能 kill 自己归属的进程
 * （归属 = M5 显式 instanceId 登记 + `.succinix-<id>` / `c-<id>` cwd 启发式，见 host-procs）；
 * system 进程（共享 host 运行时）与归属不明的进程一律拒绝。默认实例 = 现状全等（可 kill 全表）。
 * 纯函数供协议级单测；组织性隔离，非安全边界（进程表启发式可被伪装，见 host-procs 声明）。
 */
export function canKillProcess(proc: { scope?: string; containerId?: string } | undefined, instanceId: string): boolean {
  if (instanceId === DEFAULT_INSTANCE_ID) return true;
  if (!proc) return false;
  if (proc.scope === 'system') return false;
  return proc.containerId === `.succinix-${instanceId}` || proc.containerId === instanceId;
}

/**
 * 实例归属进程收集（D3，reset-instance 用）：非默认实例 = 该实例状态根
 * （.succinix-<id> / c-<id> 命名空间）下的非 system 进程；默认实例返回空数组
 * （默认实例重置 = 整页刷新语义，浏览器侧 location.reload，host 不批量 kill）。
 * 与 filterProcessesForInstance 同启发式；组织性隔离，非安全边界。
 */
export function processesOwnedByInstance(
  procs: Array<{ scope?: string; containerId?: string; pid: number }>,
  instanceId: string
): Array<{ pid: number }> {
  if (instanceId === DEFAULT_INSTANCE_ID) return [];
  return procs.filter(
    (p) =>
      p.scope !== 'system' &&
      (p.containerId === `.succinix-${instanceId}` || p.containerId === instanceId)
  );
}

/**
 * 当前前台 run 的按实例注册表（M3）：interrupt 只杀请求实例的当前 run。
 * 缺省 default 键 = 现状单值语义全等。spawnChild 登记 / settle 清除 / interrupt 查询。
 */
export class CurrentRunRegistry {
  private runs = new Map<string, number>();

  register(instanceId: string, pid: number): void {
    this.runs.set(instanceId, pid);
  }

  /** settle 时清除自己启动的 run（只清自己，防串号）。 */
  clearIf(instanceId: string, pid: number): void {
    if (this.runs.get(instanceId) === pid) this.runs.delete(instanceId);
  }

  get(instanceId: string): number | null {
    return this.runs.get(instanceId) ?? null;
  }

  /** 清空某实例的当前 run（D3，reset-instance：重启后旧 interrupt 目标不再残留）。 */
  clear(instanceId: string): void {
    this.runs.delete(instanceId);
  }
}
