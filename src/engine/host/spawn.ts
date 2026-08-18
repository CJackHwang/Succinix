// host spawn 域（O3 拆分）：共享子进程工具（spawnTracked/输出接线/后台 spawn）。
import { spawn } from 'node:child_process';
import {
  PROCESS_TERMINATION_GRACE_MS,
  appendProcessOutput,
  killProcess,
  markProcessExited,
  registerProcess,
} from '../host-procs.js';
import { NODE_PREFIX_RE, mapDataDirArgs, capOutput, withEaccesHint, MAX_OUTPUT_BYTES, CurrentRunRegistry } from '../host-route.js';
import { mergedEnvFor, resolveRequestCwd } from './config.js';
import { tryTokenize } from '../tokenize.js';
import { writeResult, instanceOf, type CommandRequest } from './rpc.js';
import type { RpcRequestId } from '../rpc-v2.js';
import type { ProcessRuntime, RegisterProcessOptions } from '../host-procs.js';

// node 子进程默认超时兜底（runNode / spawnChild）。
const NODE_TIMEOUT_MS = 30000;
// TASK19：spawn 确认窗口（ms）。后台进程（node/npm/npx）在此窗口内以非零退出视为"启动失败"，
// 立即向浏览器报 ok:false（如 npx 包不存在、node 脚本语法错误、端口被占直接退出）。
// 后台服务（tinbase / http server）都会存活超过该窗口，仅多等一拍，对调用方无感知。
const SPAWN_CONFIRM_MS = 2000;

// ─── 共享子进程工具（P2-8）───
// 三处 spawn（Lifo 混合链 forward / run 的 spawnChild / 后台 dispatchSpawn）都做同一件事的变体：
// spawn(prog, args, {cwd, env}) → registerProcess → stdout/stderr 接线。差异只在输出去向：
//   accumulate —— 累积字符串（增量 2 倍上限截断），settle 时写结果文件
//   append     —— 追加进进程表 outputTail（ps 尾部展示，不截断）
//   both       —— 两者都要（Lifo 混合链：既写 ctx 流也登记进程表）
type OutputMode = 'accumulate' | 'append' | 'both';

// 接线 stdout/stderr 数据处理器。返回累积取读函数（accumulate/both 模式）。
export function attachOutputCollector(
  child: ReturnType<typeof spawn>,
  pid: number,
  mode: OutputMode
): { stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  const collect = (which: 'stdout' | 'stderr') => (d: Buffer) => {
    const s = d.toString();
    if (mode !== 'append') {
      // Keep stdout and stderr combined below one UTF-8 byte budget. JS string
      // length measures UTF-16 code units and lets CJK/astral output bypass a
      // byte limit, so it is never used for this boundary.
      if (which === 'stdout') {
        stdout += s;
        stdout = capOutput(stdout, Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(stderr)));
      } else {
        stderr += s;
        stderr = capOutput(stderr, Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(stdout)));
      }
    }
    if (mode !== 'accumulate') appendProcessOutput(pid, s);
  };
  child.stdout?.on('data', collect('stdout'));
  child.stderr?.on('data', collect('stderr'));
  return { stdout: () => stdout, stderr: () => stderr };
}

// spawn + 进程登记 + 输出接线一步到位（三处共用）。登记时记录 spawn cwd
// （TASK-CISOL：容器根 → scope=container + containerId）。
function spawnTracked(
  prog: string,
  args: string[],
  opts: { cwd: string; mode: OutputMode; instanceId: string; env?: NodeJS.ProcessEnv; runtime?: ProcessRuntime; interactive?: boolean; terminalSessionId?: string }
): { pid: number; child: ReturnType<typeof spawn>; out: ReturnType<typeof attachOutputCollector> } {
  const child = spawn(prog, args, { cwd: opts.cwd, env: opts.env ?? mergedEnvFor(opts.instanceId, undefined) });
  // M5：登记时带请求实例 id —— 实例会话 cwd 是容器 home（无状态根段），显式归属保证
  // 实例 ps 视图 / service 状态能看到自己的进程（默认实例不标，行为全等）。
  const registration: RegisterProcessOptions = {
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
    ...(opts.terminalSessionId ? { terminalSessionId: opts.terminalSessionId } : {}),
  };
  const pid = registerProcess(prog + (args.length ? ' ' + args.join(' ') : ''), child, opts.cwd, opts.instanceId, registration);
  const out = attachOutputCollector(child, pid, opts.mode);
  return { pid, child, out };
}

// 共享子进程捕获逻辑：runNode（node/npm/npx）与 runPython（python 运行时）共用。
// 结果带 runtime: 'node'（python 实际也是 node 子进程 —— 协议路由字段不变）。
// 立即返回；子进程结束时异步写 result-<id>.json。cwd 用会话 cwd（TASK23）。
export function spawnChild(
  prog: string,
  args: string[],
  opts: Record<string, unknown> | undefined,
  reqId: RpcRequestId,
  label: string,
  instanceId: string
): void {
  const cwd = resolveRequestCwd(instanceId, opts?.cwd);
  if ('error' in cwd) {
    writeResult(reqId, { ok: false, exitCode: 1, stdout: '', stderr: cwd.error, runtime: 'node' }, instanceId);
    return;
  }
  const realCwd = cwd.cwd;
  const { pid, child, out } = spawnTracked(prog, args, {
    cwd: realCwd,
    mode: 'accumulate',
    instanceId,
    env: mergedEnvFor(instanceId, opts?.env),
  });
  // P5-15 / M3：按实例登记为当前前台 run（Ctrl+C 中断目标，只中断该实例的 run）；settle 时清除。
  currentRunByInstance.register(instanceId, pid);

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = (payload: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    currentRunByInstance.clearIf(instanceId, pid);
    // TASK18 输出上限：最终截断在 settle 应用，保证结果文件有界。
    // TASK24 坑 3：EACCES 提示在截断之后追加，保证即使输出超上限提示也在。
    writeResult(reqId, {
      ...payload,
      stdout: capOutput(out.stdout()),
      stderr: withEaccesHint(capOutput(out.stderr())),
    }, instanceId);
  };

  // 超时兜底：避免挂死的子进程永久占坑；可被 opts.timeout 覆盖
  const timeoutMs = typeof opts?.timeout === 'number' ? opts.timeout : NODE_TIMEOUT_MS;
  timer = setTimeout(() => {
    if (child.exitCode === null) {
      killProcess(pid, PROCESS_TERMINATION_GRACE_MS, 'SIGTERM');
      settle({
        ok: false,
        exitCode: -1,
        stderr: `${label} subprocess timed out after ${timeoutMs}ms, terminating`,
        runtime: 'node',
      });
    }
  }, timeoutMs);

  child.on('close', (code: number | null) =>
    settle({ ok: code === 0, exitCode: code ?? -1, runtime: 'node' })
  );
  child.on('error', (e: Error) =>
    settle({ ok: false, exitCode: -1, stderr: String(e), runtime: 'node' })
  );
}

// spawn：后台长驻进程（端口管理 / 数据库服务等）。
// 只支持 node 系命令（spawn 用于服务器；Lifo 侧没有后台概念，明确返回"不支持"）。
// 与 run 的 node 分支不同：不写最终结果文件，立即返回 { ok, pid, runtime: 'node' }；
// 子进程输出持续收集进进程表条目（outputTail，ps 返回最近 ~500 字符）。
export function dispatchSpawn(req: CommandRequest): void {
  const inst = instanceOf(req);
  const command = String(req.opts?.command ?? '').trim();
  if (!command) {
    writeResult(req.id, { ok: false, error: 'empty command', runtime: 'node' }, inst);
    return;
  }
  if (!NODE_PREFIX_RE.test(command)) {
    writeResult(req.id, {
      ok: false,
      error: 'spawn only supports node/npm/npx background processes (Lifo side has no background concept)',
      runtime: 'lifo',
    }, inst);
    return;
  }
  const t = tryTokenize(command);
  if (!t.ok) {
    writeResult(req.id, { ok: false, error: t.error, runtime: 'node' }, inst);
    return;
  }
  const [prog, ...args] = mapDataDirArgs(t.tokens, process.cwd());
  const cwd = resolveRequestCwd(inst, req.opts?.cwd);
  if ('error' in cwd) {
    writeResult(req.id, { ok: false, error: cwd.error, runtime: 'node' }, inst);
    return;
  }
  const realCwd = cwd.cwd;
  // 后台进程输出只追加进程表 outputTail（不截断累积）；TASK-CISOL 登记 cwd 供归属判定。
  const rawInteractive = req.opts?.interactive;
  const { pid, child } = spawnTracked(prog, args, {
    cwd: realCwd,
    mode: 'append',
    instanceId: inst,
    env: mergedEnvFor(inst, req.opts?.env),
    interactive: rawInteractive === true,
  });
  let settled = false;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = (payload: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    if (confirmTimer) clearTimeout(confirmTimer);
    writeResult(req.id, payload, inst);
  };
  child.on('error', (e: Error) => {
    appendProcessOutput(pid, `[spawn error] ${e}\n`);
    markProcessExited(pid); // close 事件在 spawn 失败时不触发，进程表条目会永远停在 running —— 纠正为 exited
    settle({ ok: false, error: `spawn failed: ${e.message}`, runtime: 'node' });
  });
  // TASK19：确认窗口内非零退出 = 启动失败（如 npx 包不存在 / node 脚本语法错误）。
  // 旧实现只在 setImmediate 确认 ok:true，把注定失败的启动误报为成功（浏览器读到 ok:true + pid，
  // 之后进程才退出非零，结果文件对浏览器已不可见）。close(code!==0) 先于窗口到达即报失败。
  child.on('close', (code) => {
    if (!settled && code !== 0) {
      appendProcessOutput(pid, `[spawn early exit] code ${code ?? -1}\n`);
      settle({ ok: false, exitCode: code ?? -1, error: `spawned process exited early (code ${code ?? -1})`, runtime: 'node' });
    }
  });
  confirmTimer = setTimeout(() => {
    // M4：spawn 成功响应带启动 cwd（additive；实例归属 / 服务视图按 cwd 前缀判定）。
    if (!settled) settle({ ok: true, pid, runtime: 'node', cwd: realCwd });
  }, SPAWN_CONFIRM_MS);
}

// P5-15 / M3：当前前台 run 的 node 子进程 pid 按实例登记（interrupt 协议用；缺省 default 键
// = 现状单值全等）。spawnChild 启动时 register、settle 时 clearIf（只清自己启动的）。
// 后台 spawn / Lifo 混合链 / 纯 Lifo 命令不在此列——后台服务不应被 Ctrl+C 误杀，
// Lifo 沙箱无 abort API（host 侧 busy 期间 interrupt 也进不来）。
export const currentRunByInstance = new CurrentRunRegistry();
