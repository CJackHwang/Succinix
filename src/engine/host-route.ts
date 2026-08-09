// host.ts 的纯逻辑抽取（P1-4）：无副作用、可单测的路由判定 / 路径映射 / 字符串处理。
// host.ts 保留进程生命周期与文件 RPC 编排；本模块是纯函数集合，vitest 门禁覆盖。
// 双根语义（TASK24）：浏览器 wc.fs 的 `/` == host 进程 cwd（/home/<wc-id>），Lifo 的
// /workspace 是同一目录的挂载别名。路径映射统一以 root = process.cwd() 为基准。
// 引擎自包含：本模块不 import 系统层（persist/log/config），只依赖 node 全局。

export const WORKSPACE_MOUNT = '/workspace';

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
  if (p === WORKSPACE_MOUNT) return root;
  if (p.startsWith(WORKSPACE_MOUNT + '/')) return root + p.slice(WORKSPACE_MOUNT.length);
  return p;
}

// 会话 cwd → spawn 真实 cwd（TASK24：子进程 spawn 前必须把 VFS 路径映射回 host 真实路径，
// 否则 chdir /workspace 会在 WebContainer 里挂起）。非 /workspace 路径原样使用。
export function spawnCwdFor(sessionCwd: string, root: string): string {
  return vfsToReal(sessionCwd, root);
}

// 浏览器视角绝对路径 → host 真实路径。wc.fs 的 `/` 与 Lifo 的 /workspace 都映射到 root，
// 所以 `/foo` 和 `/workspace/foo` 的真实位置都是 root/foo。node/python 子进程收到这类
// 绝对路径参数（如 `python /script.py`）时若原样传给真实容器根 `/`（bin/dev/etc...）会
// 找不到文件；映射后脚本可读。相对路径由 spawn cwd（真实路径）解析，原样返回。
export function resolveBrowserPath(p: string, root: string): string {
  if (!p.startsWith('/')) return p;
  const rel = p === WORKSPACE_MOUNT ? '/' : p.startsWith(WORKSPACE_MOUNT + '/') ? p.slice(WORKSPACE_MOUNT.length) : p;
  return root + rel;
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

// ─── 输出截断 / EACCES 提示 ───

// TASK18：单命令 stdout/stderr 各自最多保留的字符数（防超大输出 OOM）。正常命令
// （seq 1 5000 约 25KB / npm install 日志 / cat 中大型文件）远低于此上限。
export const MAX_OUTPUT_BYTES = 1024 * 1024;

// 输出截断：超出上限保留尾部（用户关心结尾）。在 settle 时应用最终截断。
export function capOutput(s: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
  return s.length > maxBytes ? s.slice(-maxBytes) : s;
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
