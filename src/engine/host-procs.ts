// 进程表模块：登记 host 通过 child_process.spawn 拉起的真实子进程。
// 供 ps / kill 协议使用；Lifo 侧进程由 sandbox 内部管理，不在本表内（仅支持列表）。
import type { ChildProcess } from 'node:child_process';

export interface ProcInfo {
  pid: number;
  cmd: string;
  status: 'running' | 'exited';
  startTime: number;
  exitCode?: number | null;
  /** spawn 后台进程的最近输出尾部（最长 OUTPUT_TAIL_MAX 字符），供 ps 附带查看 */
  outputTail?: string;
}

interface ProcEntry extends ProcInfo {
  child: ChildProcess;
}

const table = new Map<number, ProcEntry>();
const MAX_ENTRIES = 100;
const OUTPUT_TAIL_MAX = 500;

// 登记一个刚 spawn 的子进程；进程退出时自动把状态更新为 exited。
export function registerProcess(cmd: string, child: ChildProcess): number {
  const pid = child.pid ?? -1;
  const entry: ProcEntry = { pid, cmd, status: 'running', startTime: Date.now(), child };
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

// 供 ps 使用：返回进程表的只读快照（不含 child 引用）。
export function listProcesses(): ProcInfo[] {
  return [...table.values()].map((e) => ({
    pid: e.pid,
    cmd: e.cmd,
    status: e.status,
    startTime: e.startTime,
    exitCode: e.exitCode,
    ...(e.outputTail !== undefined ? { outputTail: e.outputTail } : {}),
  }));
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
