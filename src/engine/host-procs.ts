// 进程表模块：登记 host 通过 child_process.spawn 拉起的真实子进程。
// 供 ps / kill 协议使用。
// V1 H1-2：除 run 的 node 直启分支 / spawn 后台进程外，Lifo 混合链中经
// registerRealBinaryCommands 转发拉起的 node/npm/npx 真实子进程也登记进本表——
// 前台 `cd <root> && npm test` 这类命令的活跃子进程因此 ps() 可见、kill 可终止。
// 纯 Lifo 内置命令（echo / mkdir / grep ...）在 sandbox 内执行，不占本表（仅支持列表）。
// TASK-CISOL（R1）：登记时记录子进程启动 cwd，ps() 响应为每个进程附加归属字段
// scope（system/container/unknown）+ containerId（scope=container 时）——容器隔离完善：
// 不同容器的 Agent 据此在 SunamAI 侧做查询过滤 / kill 拦截。现有契约字段一字不改，只加新字段。
//
// ⚠️ 边界声明（P1-5）：scope 判定是**启发式**（命令串正则 + spawn cwd 路径），可被伪装 ——
// 任何用户进程只要命令串长得像系统进程（如 `node /usr/lib/succinix/fake.js`）就会被标为 system。
// 该字段面向 **UI 展示与查询过滤**（ps 归属列、按容器过滤），**不是安全边界**：不能作为
// 权限 / 隔离 / kill 拦截的信任依据。需要硬语义时改显式声明制（spawn 时调用方显式传 scope）。
import type { ChildProcess } from 'node:child_process';

/** 进程归属：system（Succinix 运行时）/ container（某虚拟容器 c-*）/ unknown（无法判定）。 */
export type ProcessScope = 'system' | 'container' | 'unknown';

export interface ProcInfo {
  pid: number;
  cmd: string;
  status: 'running' | 'exited';
  startTime: number;
  exitCode?: number | null;
  /** spawn 后台进程的最近输出尾部（最长 OUTPUT_TAIL_MAX 字符），供 ps 附带查看 */
  outputTail?: string;
  /** 进程归属（ps() 新增字段）：system / container / unknown */
  scope: ProcessScope;
  /** scope=container 时所属虚拟容器 id（如 c-1） */
  containerId?: string;
}

interface ProcEntry extends Omit<ProcInfo, 'scope' | 'containerId'> {
  child: ChildProcess;
  /** 启动时工作目录（host 真实路径，spawn 的 cwd 选项）；归属判定的依据 */
  cwd?: string;
  /** M5：RPC 请求显式携带的实例 id（非默认实例时登记）；归属判定的权威依据 */
  instanceId?: string;
}

const table = new Map<number, ProcEntry>();
const MAX_ENTRIES = 100;
const OUTPUT_TAIL_MAX = 500;

// ─── 归属判定（TASK-CISOL R1，启发式）───
// 与 SunamAI 侧 src/features/runtime/succinixProcesses.ts 的 SYSTEM_CMD_PATTERNS 对齐：
// host 自身进程（node host.js）/ python daemon（node python-daemon.js）/ /usr/lib/succinix
// 路径启动 → system。系统判定优先于容器路径判定（/usr/lib/succinix 下的 python daemon 虽在
// 容器 FS 里，但属 Succinix 运行时，不得误标为容器进程）。
const SYSTEM_PROCESS_PATTERNS: ReadonlyArray<RegExp> = [
  // TerminalExecutor 守护进程（node host.js / node /path/to/host.js）
  /(?:^|\s)(?:node|npm|npx)\s+(?:\S*\/)?host\.js(?:\s|$)/,
  // Pyodide 常驻 daemon（node python-daemon.js / node /path/to/python-daemon.js）
  /(?:^|\s)(?:node|npm|npx)\s+(?:\S*\/)?python-daemon\.js(?:\s|$)/,
  // 任何 /usr/lib/succinix/ 路径启动的进程（系统资产目录）
  /\/usr\/lib\/succinix\//,
];

// 容器/实例根路径段（M2 / DM-12，两命名空间共存）：
//   1) c-<id>（CISOL 既有）：agent/用户终端命令带 `cd /workspace/c-<id> &&` 前缀执行，
//      子进程 spawn cwd 落在容器根（VFS `/workspace/c-<id>` 或 host 真实路径），
//      从 cwd 解析出 c-<id> 即容器归属；
//   2) .succinix-<id>（实例状态根）：同页/多实例模式的实例根 `/workspace/.succinix-<id>`，
//      spawn cwd 落在其下即归该实例（与 c-<id> 共存，不冲突）。
// 取路径中**首个**命中段（根在挂载点下第一位）。
const CONTAINER_SEGMENT_PATTERN = /(?:^|\/)((?:c-[A-Za-z0-9_-]+)|(?:\.succinix-[A-Za-z0-9_-]+))(?:\/|$)/;
// 实例状态根段（单独模式：优先匹配 .succinix-<id>，M3 ps 过滤 / M4 service 归属以 stateRoot 为准）。
const STATE_ROOT_SEGMENT_PATTERN = /(?:^|\/)\.succinix-([A-Za-z0-9_-]+)(?:\/|$)/;

/**
 * 判定一个进程的归属。cmd 命中系统模式 → system；否则 cwd 含容器根段 → container（带 containerId）；
 * 都无法判定 → unknown（如实标注，不硬造）。导出供单测覆盖。
 */
export function classifyProcess(cmd: string, cwd?: string): { scope: ProcessScope; containerId?: string } {
  if (SYSTEM_PROCESS_PATTERNS.some((pattern) => pattern.test(cmd))) {
    return { scope: 'system' };
  }
  if (cwd) {
    const match = CONTAINER_SEGMENT_PATTERN.exec(cwd);
    if (match) return { scope: 'container', containerId: match[1]! };
  }
  return { scope: 'unknown' };
}

/**
 * 从 spawn cwd 解析实例归属（M2，供 ps 过滤 / kill 越权 / service 归属）：
 * 优先 .succinix-<id> 状态根段（返回裸 id，如 'c-1'），回落 c-<id> 容器段（CISOL 兼容）。
 * 无法判定 → undefined。启发式（同 scope 判定），非安全边界。
 */
export function instanceIdFromPath(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const stateRoot = STATE_ROOT_SEGMENT_PATTERN.exec(cwd);
  if (stateRoot) return stateRoot[1]!;
  const legacy = CONTAINER_SEGMENT_PATTERN.exec(cwd);
  return legacy ? legacy[1]! : undefined;
}

// 登记一个刚 spawn 的子进程；进程退出时自动把状态更新为 exited。
// cwd 为 spawn 时的启动工作目录（host 真实路径），供归属判定（R5：Lifo 链等 cwd 不可解析时
// 归 unknown 并如实标注）。缺省不传时按 unknown 归属。
export function registerProcess(cmd: string, child: ChildProcess, cwd?: string, instanceId?: string): number {
  const pid = child.pid ?? -1;
  const entry: ProcEntry = { pid, cmd, status: 'running', startTime: Date.now(), cwd, child, ...(instanceId ? { instanceId } : {}) };
  table.set(pid, entry);
  child.on('close', (code) => {
    entry.status = 'exited';
    entry.exitCode = code;
  });
  prune();
  return pid;
}

// 上限保护：超过 MAX_ENTRIES 时清掉最老的已退出条目，避免进程表无限增长。
function prune(): void {
  if (table.size <= MAX_ENTRIES) return;
  const exited = [...table.values()]
    .filter((e) => e.status === 'exited')
    .sort((a, b) => a.startTime - b.startTime);
  for (const e of exited.slice(0, table.size - MAX_ENTRIES)) {
    table.delete(e.pid);
  }
}

// 供 ps 使用：返回进程表的只读快照（不含 child 引用），并附加归属字段（scope/containerId）。
export function listProcesses(): ProcInfo[] {
  return [...table.values()].map((e) => {
    // M5：显式实例归属优先于 cwd 启发式 —— 实例会话 cwd 是容器 home（/workspace 根），
    // 不含 `.succinix-<id>` 段；仅靠 cwd 判定会把实例进程判为 unknown，实例 ps 视图
    // 会漏掉自己的进程（service start 误报 exited）。请求带 instanceId 即权威归属。
    // 默认实例不标（现状全等：default 视图不过滤，标了反而被 processBelongsToInstance 排除）。
    if (e.instanceId && e.instanceId !== 'default') {
      return {
        pid: e.pid,
        cmd: e.cmd,
        status: e.status,
        startTime: e.startTime,
        exitCode: e.exitCode,
        scope: 'container' as const,
        containerId: `.succinix-${e.instanceId}`,
        ...(e.outputTail !== undefined ? { outputTail: e.outputTail } : {}),
      };
    }
    const { scope, containerId } = classifyProcess(e.cmd, e.cwd);
    return {
      pid: e.pid,
      cmd: e.cmd,
      status: e.status,
      startTime: e.startTime,
      exitCode: e.exitCode,
      scope,
      ...(containerId !== undefined ? { containerId } : {}),
      ...(e.outputTail !== undefined ? { outputTail: e.outputTail } : {}),
    };
  });
}

// 把子进程的一块输出追加到进程表条目；只保留最近 OUTPUT_TAIL_MAX 字符。
export function appendProcessOutput(pid: number, text: string): void {
  const entry = table.get(pid);
  if (!entry) return;
  entry.outputTail = ((entry.outputTail ?? '') + text).slice(-OUTPUT_TAIL_MAX);
}

// 强制把条目标记为 exited（TASK18：spawn 失败 ENOENT 等场景 close 事件不会触发，
// 进程表条目会永远停在 running；配合 dispatchSpawn 的 error 处理把状态纠正为 exited）。
export function markProcessExited(pid: number, code?: number | null): void {
  const entry = table.get(pid);
  if (!entry || entry.status === 'exited') return;
  entry.status = 'exited';
  entry.exitCode = code ?? null;
}

export interface KillResult {
  killed: boolean;
  message?: string;
}

// 终止真实子进程；不在表内（或本就是 Lifo 侧进程）时明确返回"仅支持列表"，不假装支持。
export function killProcess(pid: number): KillResult {
  const entry = table.get(pid);
  if (!entry) {
    return { killed: false, message: `process ${pid} not in process table; Lifo-side processes are list-only (kill not supported)` };
  }
  if (entry.status === 'exited') {
    return { killed: false, message: `process ${pid} already exited (exit=${entry.exitCode ?? '?'}), nothing to kill` };
  }
  const ok = entry.child.kill();
  return ok
    ? { killed: true, message: `SIGTERM sent to process ${pid}` }
    : { killed: false, message: `failed to send signal to process ${pid}` };
}
