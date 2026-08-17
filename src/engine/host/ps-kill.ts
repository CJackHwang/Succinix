// host ps/kill 域（O3 拆分）：进程表快照 / 终止 / 实例级重置 / interrupt / setCwd。
import fs from 'node:fs';
import { listProcesses, killProcess } from '../host-procs.js';
import { filterProcessesForInstance, canKillProcess, processesOwnedByInstance, parseKillPid, vfsToReal } from '../host-route.js';
import { setSessionCwd, clearSessionCwd, currentInstanceId } from './config.js';
import { currentRunByInstance } from './spawn.js';
import { interruptLifoRun, killLifoProcess, listLifoProcesses, resetSandboxContext } from './run.js';
import { writeResult, instanceOf, type CommandRequest } from './rpc.js';

// ps：进程表快照。请求带 instanceId 时按实例过滤（该实例 + system）；缺省不过滤（现状全等）。
// 归属判定以 host-procs 启发式为准（M2 状态根 .succinix-<id> + CISOL c-<id> 命名空间），
// 非安全边界（UI 展示 / 查询过滤用）。
export async function dispatchPs(req: CommandRequest): Promise<void> {
  const inst = instanceOf(req);
  const runtime = typeof req.opts?.runtime === 'string' ? req.opts.runtime : undefined;
  const scope = typeof req.opts?.scope === 'string' ? req.opts.scope : undefined;
  const lifo = await listLifoProcesses(inst);
  const processes = [...filterProcessesForInstance(listProcesses(), inst), ...filterProcessesForInstance(lifo, inst)].filter((process) =>
    (runtime === undefined || process.runtime === runtime) &&
    (scope === undefined || process.scope === scope)
  );
  writeResult(req.id, { ok: true, kind: 'ps', processes }, inst);
}

// kill：真实子进程交给进程表模块；Lifo 侧进程不在表内，明确返回"仅支持列表"。
export async function dispatchKill(req: CommandRequest): Promise<void> {
  const inst = instanceOf(req);
  const pid = parsePid(req);
  if (!Number.isInteger(pid) || pid <= 0) {
    writeResult(req.id, { ok: false, killed: false, message: `invalid pid: ${req.opts?.pid ?? req.cmd}` }, inst);
    return;
  }
  // U1：kill 越权拒绝（host 侧收口）—— 非默认实例只能 kill 自己归属的进程（M5 显式
  // instanceId 登记 + `.succinix-<id>` / `c-<id>` cwd 启发式）；system 进程与归属不明
  // 的进程拒绝。默认实例 = 现状全等（可 kill 全表）。组织性隔离，非安全边界。
  const lifo = await listLifoProcesses(inst, inst === 'default');
  const target = [...filterProcessesForInstance(listProcesses(), inst), ...filterProcessesForInstance(lifo, inst)].find((p) => p.pid === pid);
  if (!canKillProcess(target, inst)) {
    writeResult(req.id, {
      ok: false,
      killed: false,
      message: `permission denied: process ${pid} is not owned by instance '${inst}'`,
    }, inst);
    return;
  }
  const rawForce = Number(req.opts?.forceAfterMs);
  const forceAfterMs = Number.isFinite(rawForce) && rawForce > 0 ? rawForce : undefined;
  const rawSignal = req.opts?.signal;
  const signal = rawSignal === 'SIGINT' || rawSignal === 'SIGTERM' || rawSignal === 'SIGKILL'
    ? rawSignal
    : 'SIGTERM';
  const lifoResult = await killLifoProcess(pid, signal);
  const r = lifoResult ?? killProcess(pid, forceAfterMs, signal);
  writeResult(req.id, { ok: r.killed, killed: r.killed, message: r.message }, inst);
}

// D3：实例级重置（reset-instance 协议命令）—— 停掉该实例仍运行的进程（按实例归属，
// 与 ps 过滤/kill 授权同启发式）、清 host 侧实例缓存（会话 cwd / 当前 interrupt run）。
// 默认实例 = 整页刷新语义（浏览器侧 location.reload），host 侧只清缓存不批量 kill。
export async function dispatchResetInstance(req: CommandRequest): Promise<void> {
  const inst = instanceOf(req);
  const killed: number[] = [];
  for (const p of processesOwnedByInstance(listProcesses(), inst)) {
    const r = killProcess(p.pid);
    if (r.killed) killed.push(p.pid);
  }
  const lifo = await listLifoProcesses(inst, false);
  for (const p of processesOwnedByInstance(lifo, inst)) {
    const r = await killLifoProcess(p.pid, 'SIGKILL');
    if (r?.killed) killed.push(p.pid);
  }
  clearSessionCwd(inst);
  currentRunByInstance.clear(inst);
  await resetSandboxContext(inst);
  writeResult(req.id, { ok: true, kind: 'reset-instance', killed }, inst);
}

// interrupt（P5-15）：浏览器 Ctrl+C —— 终止当前前台 run 的 node 子进程。
// 只杀 currentRunPid（spawnChild 登记的当前 run），不动后台 spawn 服务。
// 进程被杀后 close 事件触发 spawnChild settle → 写 run 结果文件、清 currentRunPid，
// 浏览器侧在途 exec 随即读到结果，busy 结束回到提示符。
// 无当前 run（纯 Lifo 命令 / 空闲）→ 返回 pid:null，浏览器如实提示。
export function dispatchInterrupt(req: CommandRequest): void {
  // M3：只中断请求实例的当前前台 run（按实例分键；缺省 default 键 = 现状单值全等）。
  const inst = instanceOf(req);
  const runPid = currentRunByInstance.get(inst);
  if (runPid !== null) {
    const r = killProcess(runPid);
    writeResult(req.id, {
      ok: true,
      kind: 'interrupted',
      pid: runPid,
      killed: r.killed,
      message: r.message,
    }, inst);
    return;
  }
  if (interruptLifoRun(inst)) {
    writeResult(req.id, { ok: true, kind: 'interrupted', pid: null, killed: true, message: 'Lifo command aborted' }, inst);
    return;
  }
  writeResult(req.id, { ok: true, kind: 'interrupted', pid: null }, inst);
}

// setCwd：显式设置会话 cwd（TASK23 协议新增，向后兼容 —— 客户端可选使用）。
// 校验绝对路径且为已存在目录；cd 命令的自动同步已覆盖交互路径，此命令供生态/自检显式设置。
export function dispatchSetCwd(req: CommandRequest): void {
  const inst = instanceOf(req);
  const raw = String(req.opts?.cwd ?? '');
  if (!raw.startsWith('/')) {
    writeResult(req.id, { ok: false, error: `setCwd: cwd must be an absolute path: ${raw}` }, inst);
    return;
  }
  try {
    const real = vfsToReal(raw, process.cwd());
    if (!fs.statSync(real).isDirectory()) {
      writeResult(req.id, { ok: false, error: `setCwd: not a directory: ${raw}` }, inst);
      return;
    }
  } catch {
    writeResult(req.id, { ok: false, error: `setCwd: not a directory: ${raw}` }, inst);
    return;
  }
  setSessionCwd(currentInstanceId(), raw);
  writeResult(req.id, { ok: true, kind: 'cwd', cwd: raw }, inst);
}

// kill 协议支持 { cmd: 'kill', opts: { pid } }，也兼容 "kill 1234" 字符串形式。
// 解析逻辑在 host-route.ts（P1-4）。
function parsePid(req: CommandRequest): number {
  return parseKillPid(req.cmd, req.opts?.pid);
}
