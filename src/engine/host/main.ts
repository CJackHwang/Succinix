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
import { CMD_FILE, writeResult, instanceOf, type CommandRequest } from './rpc.js';
import { setCurrentInstanceId, getSessionCwd } from './config.js';
import { dispatchRun } from './run.js';
import { dispatchSpawn } from './spawn.js';
import { dispatchPs, dispatchKill, dispatchResetInstance, dispatchInterrupt, dispatchSetCwd } from './ps-kill.js';
import { pruneStaleResults } from './rpc.js';
import { shouldRemoveCmdFile } from '../host-route.js';

// 统一命令入口：各分支自行写 result-<id>.json。
// node 子进程的 run 会立即返回（结果异步写回），保证 ps/kill 在长命令期间仍可用。
export async function handleCommand(req: CommandRequest): Promise<void> {
  setCurrentInstanceId(instanceOf(req));
  const inst = instanceOf(req);
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
      dispatchPs(req);
      return;
    case 'kill':
      dispatchKill(req);
      return;
    case 'reset-instance':
      dispatchResetInstance(req);
      return;
    case 'interrupt':
      dispatchInterrupt(req);
      return;
    case 'exit':
      writeResult(req.id, { ok: true, kind: 'bye' }, inst);
      return;
    default:
      writeResult(req.id, { ok: false, error: `unknown command: ${req.cmd}` }, inst);
  }
}

// ─── 轮询循环：文件 RPC 通道 ───
// 保持原有的 cmd.json → result-<id>.json 轮询协议，仅把处理逻辑结构化。
let processedId = -1;
let busy = false;

// 定期清理被放弃请求留下的陈旧结果文件（浏览器已超时放弃的请求）。
setInterval(pruneStaleResults, 60000);

setInterval(async () => {
  if (busy) return;
  let req: CommandRequest | null = null;
  try {
    if (!fs.existsSync(CMD_FILE)) return;
    req = JSON.parse(fs.readFileSync(CMD_FILE, 'utf8')) as CommandRequest;
    if (typeof req.id !== 'number' || req.id === processedId) return;
    processedId = req.id;
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
      writeResult(-1, { ok: false, error: String(e).slice(0, 200) });
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
      try {
        const current = fs.readFileSync(CMD_FILE, 'utf8');
        if (shouldRemoveCmdFile(req.id, current)) fs.unlinkSync(CMD_FILE);
      } catch {
        /* 文件已被删除 / 不可读：忽略 */
      }
    }
  }
}, 50); // TASK18：轮询 120ms → 50ms（命令往返的 host 侧等待减半；fs.existsSync 每 50ms 一次开销可忽略）
