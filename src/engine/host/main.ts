// Succinix POC host v4.1 — TerminalExecutor：WebContainer 内常驻的统一终端执行器。
// 通道：文件型 RPC（WC 环境中 stdin→进程 不可靠，已实测弃用，不要改用 stdin）。
//   浏览器 → /cmd.json          { id, cmd, opts? }
//   host   → /result-<id>.json  { id, ok, ... }（每个请求独立结果文件，
//            避免异步 close 写入把更新的结果覆盖掉 —— v4 曾因此丢 kill 响应）
// 命令协议：
//   run   统一路由执行（node|npm|npx 前缀 → 真 Node 子进程；其余 → Lifo sandbox）
//   spawn 后台长驻进程（仅 node 系；立即返回 pid，输出持续收集进进程表 outputTail）
//   ps   列出进程表（host 拉起的真实子进程）
//   kill 终止真实子进程（Lifo 侧进程不在表内，明确返回"仅支持列表"）
//   cwd  返回统一 cwd（process.cwd()，即挂载点，与 Lifo 侧天然一致）
//   ping 连通性探测
//   exit 优雅退出握手
// 统一路由结果必须带 runtime: 'node' | 'lifo' 字段，方便验证走的是哪条路径。

import fs from 'node:fs';
import { CMD_FILE, beginRequest, writeAck, writeProtocolError, writeResult, instanceOf, type CommandRequest } from './rpc.js';
import { setCurrentInstanceId, currentInstanceId, getSessionCwd } from './config.js';
import { dispatchRun } from './run.js';
import { dispatchSpawn } from './spawn.js';
import { dispatchPs, dispatchKill, dispatchResetInstance, dispatchInterrupt, dispatchSetCwd } from './ps-kill.js';
import { pruneStaleResults } from './rpc.js';
import { BoundedProcessedIds, RPC_HOST_EPOCH_FILE, RPC_PROTOCOL_VERSION, isRpcHostEpoch, isValidRpcRequestId, type RpcStructuredError } from '../rpc-v2.js';
import { RpcTerminal, TerminalMailboxHost } from './terminal.js';
import { setTerminalDimensions } from './terminal-dimensions.js';
import { PROCESS_TERMINATION_GRACE_MS, terminateProcessesForInstance } from '../host-procs.js';
import { TERMINAL_MAILBOX_ROOT } from '../../terminal/transport-protocol.js';
import { attachRpcTerminal, detachRpcTerminal, resetSandboxContext } from './run.js';

const activeInstanceIds = new Set<string>(['default']);
let shuttingDown = false;

// 统一命令入口：各分支自行写 result-<id>.json。
// node 子进程的 run 会立即返回（结果异步写回），保证 ps/kill 在长命令期间仍可用。
export async function handleCommand(req: CommandRequest): Promise<void> {
  const previousInstance = currentInstanceId();
  setCurrentInstanceId(instanceOf(req));
  const inst = instanceOf(req);
  activeInstanceIds.add(inst);
  try {
    switch (req.cmd) {
      case 'ping':
        writeResult(req.id, { ok: true, kind: 'pong' }, inst);
        return;
      case 'cwd':
        writeResult(req.id, { ok: true, kind: 'cwd', cwd: getSessionCwd(inst), hostRoot: process.cwd() }, inst);
        return;
      case 'setCwd':
        dispatchSetCwd(req);
        return;
      case 'run':
        await dispatchRun(req);
        return;
      case 'spawn':
        dispatchSpawn(req);
        return;
      case 'ps':
        await dispatchPs(req);
        return;
      case 'kill':
        await dispatchKill(req);
        return;
      case 'reset-instance':
        await dispatchResetInstance(req);
        return;
      case 'interrupt':
        dispatchInterrupt(req);
        return;
      case 'exit':
        await shutdownExecutionWorld();
        writeResult(req.id, { ok: true, kind: 'bye' }, inst);
        setTimeout(() => process.exit(0), 0);
        return;
      default:
        writeResult(req.id, { ok: false, error: `unknown command: ${req.cmd}` }, inst);
    }
  } finally {
    setCurrentInstanceId(previousInstance);
  }
}

// ─── 轮询循环：文件 RPC 通道 ───
// 保持原有的 cmd.json → result-<id>.json 轮询协议，仅把处理逻辑结构化。
const processedIds = new BoundedProcessedIds(4096);
let busy = false;
let priorityBusy = false;

function currentHostEpoch(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(RPC_HOST_EPOCH_FILE.slice(1), 'utf8')) as unknown;
    return isRpcHostEpoch(parsed) ? parsed.bootNonce : null;
  } catch {
    return null;
  }
}

const hostEpoch = currentHostEpoch();
if (!hostEpoch) throw new Error('host epoch is missing or invalid');

// Interactive terminal transport is a separate session-scoped mailbox.  It
// runs alongside the batch RPC loop and never parses commands or owns shell
// state; the Lifo Sandbox/ Shell remains the execution-world owner.
const terminalMailbox = new TerminalMailboxHost((open, options) => {
  activeInstanceIds.add(open.instanceId);
  setTerminalDimensions(open.instanceId, open.cols, open.rows);
  const terminal = new RpcTerminal(open, {
    ...options,
    onResize: (cols, rows) => setTerminalDimensions(open.instanceId, cols, rows),
  }, { cols: open.cols, rows: open.rows });
  attachRpcTerminal(open.instanceId, terminal);
  return terminal;
}, {
  onSessionClose: (identity, terminal) => { void detachRpcTerminal(identity.instanceId, terminal); },
});
terminalMailbox.start(16);

async function shutdownExecutionWorld(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  terminalMailbox.stop();
  try { fs.rmSync(TERMINAL_MAILBOX_ROOT.slice(1), { recursive: true, force: true }); } catch { /* best effort */ }
  for (const instanceId of activeInstanceIds) {
    terminateProcessesForInstance(instanceId, PROCESS_TERMINATION_GRACE_MS);
  }
  await Promise.allSettled([...activeInstanceIds].map((instanceId) => resetSandboxContext(instanceId)));
  // `killProcess()` escalates each unresponsive real child at this boundary.
  await new Promise((resolve) => setTimeout(resolve, PROCESS_TERMINATION_GRACE_MS + 25));
}

function removeIfSame(id: string | number): void {
  try {
    const current = fs.readFileSync(CMD_FILE, 'utf8');
    const parsed = JSON.parse(current) as { id?: unknown };
    if (parsed.id === id) fs.unlinkSync(CMD_FILE);
  } catch {
    /* file was replaced or removed */
  }
}

function protocolError(error: RpcStructuredError, id?: string | number, bootNonce?: string, instanceId?: string): void {
  writeProtocolError(error, id, bootNonce, instanceId);
}

// 定期清理被放弃请求留下的陈旧结果文件（浏览器已超时放弃的请求）。
setInterval(pruneStaleResults, 60000);

setInterval(async () => {
  if (busy) {
    if (!priorityBusy) void processPriorityRequest();
    return;
  }
  let req: CommandRequest | null = null;
  try {
    if (!fs.existsSync(CMD_FILE)) return;
    const raw = fs.readFileSync(CMD_FILE, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      protocolError({ code: 'MALFORMED_JSON', message: 'RPC request is not valid JSON' });
      try { fs.unlinkSync(CMD_FILE); } catch { /* ignore */ }
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      protocolError({ code: 'INVALID_REQUEST', message: 'RPC request must be an object' });
      try { fs.unlinkSync(CMD_FILE); } catch { /* ignore */ }
      return;
    }
    const candidate = parsed as Partial<CommandRequest>;
    if (!isValidRpcRequestId(candidate.id)) {
      protocolError({ code: 'INVALID_REQUEST_ID', message: 'RPC request id is invalid' });
      try { fs.unlinkSync(CMD_FILE); } catch { /* ignore */ }
      return;
    }
    if (candidate.protocolVersion !== RPC_PROTOCOL_VERSION) {
      protocolError({ code: 'UNSUPPORTED_PROTOCOL', message: `unsupported RPC protocol version: ${String(candidate.protocolVersion)}` }, candidate.id, typeof candidate.bootNonce === 'string' ? candidate.bootNonce : undefined);
      removeIfSame(candidate.id);
      return;
    }
    if (typeof candidate.bootNonce !== 'string' || candidate.bootNonce.length < 1 || typeof candidate.cmd !== 'string') {
      protocolError({ code: 'INVALID_REQUEST', message: 'RPC request requires bootNonce and cmd' }, candidate.id, candidate.bootNonce);
      removeIfSame(candidate.id);
      return;
    }
    if (candidate.bootNonce !== hostEpoch) {
      protocolError({ code: 'STALE_BOOT_NONCE', message: 'RPC request belongs to a stale host epoch' }, candidate.id, candidate.bootNonce);
      removeIfSame(candidate.id);
      return;
    }
    req = candidate as CommandRequest;
    if (processedIds.has(req.id)) {
      // A retried delivery gets an acknowledgement, but is never executed a
      // second time. The original result remains independently readable.
      writeAck(req);
      removeIfSame(req.id);
      return;
    }
    processedIds.add(req.id);
    beginRequest(req);
    writeAck(req);
    busy = true;
    try {
      await handleCommand(req);
    } catch (e) {
      writeResult(req.id, { ok: false, error: String(e).slice(0, 200) }, instanceOf(req));
    } finally {
      busy = false;
    }
  } catch (e) {
    busy = false;
    try {
      protocolError({ code: 'INVALID_REQUEST', message: String(e).slice(0, 200) });
    } catch {
      /* FS 不可用 */
    }
  } finally {
    // P0-2（正确性）：处理完（或失败）后删除 /cmd.json —— 防陈旧命令在 host 重启后被执行一次。
    // processedId 是 host 进程内变量，新 host 起步是 -1，跨进程无法去重；若残留未删的
    // /cmd.json，看门狗 kill + respawn 后新 host 会把旧请求当作新命令真实执行一次。
    // 但只删「内容仍是刚处理的那个请求」的文件：处理期间可能已有绕过互斥队列的直接写入
    // （pingDirect / interruptDirect，见 client.ts）把 /cmd.json 覆盖成新请求（如看门狗在
    // host 忙于长 Lifo/Python 命令时写 ping）。盲目删除会吞掉它 —— 看门狗等不到 pong 误判
    // host 失联（连续 2 次即重启），Ctrl+C 中断丢失。保留待下一轮轮询处理（决策见 host-route.ts）。
    if (req) {
      removeIfSame(req.id);
    }
  }
}, 50); // TASK18：轮询 120ms → 50ms（命令往返的 host 侧等待减半；fs.existsSync 每 50ms 一次开销可忽略）

/** While a long Lifo/Python/Node request owns the normal scheduler, accept
 * only the priority controls that must not wait behind it.  The mailbox
 * remains single-slot, so ordinary requests stay untouched until the active
 * request completes; this prevents watchdog/Ctrl+C from being swallowed. */
async function processPriorityRequest(): Promise<void> {
  priorityBusy = true;
  let req: CommandRequest | null = null;
  try {
    if (!fs.existsSync(CMD_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(CMD_FILE, 'utf8')) as Partial<CommandRequest>;
    if (!isValidRpcRequestId(parsed.id) || parsed.protocolVersion !== RPC_PROTOCOL_VERSION || typeof parsed.bootNonce !== 'string' || typeof parsed.cmd !== 'string') return;
    if (parsed.bootNonce !== hostEpoch) {
      protocolError({ code: 'STALE_BOOT_NONCE', message: 'RPC request belongs to a stale host epoch' }, parsed.id, parsed.bootNonce);
      removeIfSame(parsed.id);
      return;
    }
    if (parsed.cmd !== 'ping' && parsed.cmd !== 'interrupt' && parsed.cmd !== 'exit') return;
    req = parsed as CommandRequest;
    if (processedIds.has(req.id)) {
      writeAck(req);
      removeIfSame(req.id);
      return;
    }
    processedIds.add(req.id);
    beginRequest(req);
    writeAck(req);
    await handleCommand(req);
  } catch {
    /* The normal loop will report malformed/ordinary requests after busy clears. */
  } finally {
    if (req) removeIfSame(req.id);
    priorityBusy = false;
  }
}
