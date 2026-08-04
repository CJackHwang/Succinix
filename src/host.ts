// WebUnix POC host v4.1 — TerminalExecutor：WebContainer 内常驻的统一终端执行器。
// 通道：文件型 RPC（WC 环境中 stdin→进程 不可靠，已实测弃用，不要改用 stdin）。
//   浏览器 → /cmd.json          { id, cmd, opts? }
//   host   → /result-<id>.json  { id, ok, ... }（每个请求独立结果文件，
//            避免异步 close 写入把更新的结果覆盖掉 —— v4 曾因此丢 kill 响应）
// 命令协议：
//   run  统一路由执行（node|npm|npx 前缀 → 真 Node 子进程；其余 → Lifo sandbox）
//   ps   列出进程表（host 拉起的真实子进程）
//   kill 终止真实子进程（Lifo 侧进程不在表内，明确返回"仅支持列表"）
//   cwd  返回统一 cwd（process.cwd()，即挂载点，与 Lifo 侧天然一致）
//   ping 连通性探测
//   exit 优雅退出握手
// 统一路由结果必须带 runtime: 'node' | 'lifo' 字段，方便验证走的是哪条路径。
import { Sandbox } from '@lifo-sh/core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { registerProcess, listProcesses, killProcess } from './host-procs.js';

const CMD_FILE = 'cmd.json';
const RESULT_PREFIX = 'result-'; // result-<id>.json
const RESULT_TTL_MS = 120000; // 陈旧结果文件（浏览器已放弃的请求）存活上限
const LIFO_TIMEOUT_MS = 25000; // Lifo 命令默认超时
const NODE_TIMEOUT_MS = 30000; // node 子进程默认超时兜底

const sandbox = await Sandbox.create({
  mounts: [
    {
      virtualPath: '/workspace',
      hostPath: process.cwd(),
      fsModule: fs as never,
    },
  ],
});
console.log('HOST_READY');

// ─── 命令路由 ───

// 以 node / npm / npx 开头（后跟空格或直接结束）的整条命令 → 真 Node 子进程
const NODE_PREFIX_RE = /^(node|npm|npx)(\s|$)/;

interface CommandRequest {
  id: number;
  cmd: string;
  opts?: Record<string, unknown>;
}

function writeResult(id: number, payload: Record<string, unknown>): void {
  fs.writeFileSync(RESULT_PREFIX + id + '.json', JSON.stringify({ id, ...payload }));
}

// 清理被放弃请求留下的陈旧 result-*.json，避免无限累积。
function pruneStaleResults(): void {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync('.')) {
      if (!name.startsWith(RESULT_PREFIX) || !name.endsWith('.json')) continue;
      const st = fs.statSync(name);
      if (now - st.mtimeMs > RESULT_TTL_MS) fs.unlinkSync(name);
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

// 统一命令入口：各分支自行写 result-<id>.json。
// node 子进程的 run 会立即返回（结果异步写回），保证 ps/kill 在长命令期间仍可用。
async function handleCommand(req: CommandRequest): Promise<void> {
  switch (req.cmd) {
    case 'ping':
      writeResult(req.id, { ok: true, kind: 'pong' });
      return;
    case 'cwd':
      writeResult(req.id, { ok: true, kind: 'cwd', cwd: process.cwd() });
      return;
    case 'run':
      await dispatchRun(req);
      return;
    case 'ps':
      writeResult(req.id, { ok: true, kind: 'ps', processes: listProcesses() });
      return;
    case 'kill':
      dispatchKill(req);
      return;
    case 'exit':
      writeResult(req.id, { ok: true, kind: 'bye' });
      return;
    default:
      writeResult(req.id, { ok: false, error: `未知命令: ${req.cmd}` });
  }
}

// 统一路由：node|npm|npx → spawn 真 Node；其余 → lifo sandbox。
async function dispatchRun(req: CommandRequest): Promise<void> {
  const command = String(req.opts?.command ?? '').trim();
  if (!command) {
    writeResult(req.id, { ok: false, exitCode: -1, stdout: '', stderr: '空命令', runtime: 'lifo' });
    return;
  }
  if (NODE_PREFIX_RE.test(command)) {
    runNode(command, req.opts, req.id); // 立即返回；子进程结束时异步写结果
    return;
  }
  await runLifo(command, req.opts, req.id);
}

// 真 Node 子进程：命令串 → 简单分词 → spawn(prog, args, { cwd: process.cwd() })。
// 结果带 runtime: 'node'。进程登记进进程表，可被 ps / kill 管理。
function runNode(command: string, opts: Record<string, unknown> | undefined, reqId: number): void {
  const [prog, ...args] = tokenize(command);
  const child = spawn(prog, args, { cwd: process.cwd() });
  registerProcess(prog + (args.length ? ' ' + args.join(' ') : ''), child);

  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = (payload: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    writeResult(reqId, payload);
  };

  child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

  // 超时兜底：避免挂死的子进程永久占坑；可被 opts.timeout 覆盖
  const timeoutMs = typeof opts?.timeout === 'number' ? opts.timeout : NODE_TIMEOUT_MS;
  timer = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill();
      settle({ ok: false, exitCode: -1, stdout, stderr: `node 子进程超时（${timeoutMs}ms），已终止`, runtime: 'node' });
    }
  }, timeoutMs);

  child.on('close', (code: number | null) =>
    settle({ ok: code === 0, exitCode: code ?? -1, stdout, stderr, runtime: 'node' })
  );
  child.on('error', (e: Error) =>
    settle({ ok: false, exitCode: -1, stdout, stderr: String(e), runtime: 'node' })
  );
}

// Lifo sandbox：Unix 工具（grep / cat / wc / echo / curl …）。结果带 runtime: 'lifo'。
async function runLifo(command: string, opts: Record<string, unknown> | undefined, reqId: number): Promise<void> {
  try {
    const timeout = typeof opts?.timeout === 'number' ? opts.timeout : LIFO_TIMEOUT_MS;
    const r = await sandbox.commands.run(command, { timeout });
    writeResult(reqId, {
      ok: r.exitCode === 0,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      runtime: 'lifo',
    });
  } catch (e) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: String(e).slice(0, 200), runtime: 'lifo' });
  }
}

// kill：真实子进程交给进程表模块；Lifo 侧进程不在表内，明确返回"仅支持列表"。
function dispatchKill(req: CommandRequest): void {
  const pid = parsePid(req);
  if (!Number.isInteger(pid) || pid <= 0) {
    writeResult(req.id, { ok: false, killed: false, message: `无效 pid: ${req.opts?.pid ?? req.cmd}` });
    return;
  }
  const r = killProcess(pid);
  writeResult(req.id, { ok: r.killed, killed: r.killed, message: r.message });
}

// kill 协议支持 { cmd: 'kill', opts: { pid } }，也兼容 "kill 1234" 字符串形式。
function parsePid(req: CommandRequest): number {
  const fromOpts = Number(req.opts?.pid);
  if (Number.isInteger(fromOpts) && fromOpts > 0) return fromOpts;
  const m = /^kill\s+(\d+)$/.exec(req.cmd);
  return m ? Number(m[1]) : NaN;
}

// 简单 shell 分词：支持单/双引号包裹；不支持转义与变量展开（POC 够用）。
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// ─── 轮询循环：文件 RPC 通道 ───
// 保持原有的 cmd.json → result-<id>.json 轮询协议，仅把处理逻辑结构化。
let processedId = -1;
let busy = false;

// 定期清理被放弃请求留下的陈旧结果文件（浏览器已超时放弃的请求）。
setInterval(pruneStaleResults, 60000);

setInterval(async () => {
  if (busy) return;
  try {
    if (!fs.existsSync(CMD_FILE)) return;
    const req = JSON.parse(fs.readFileSync(CMD_FILE, 'utf8')) as CommandRequest;
    if (typeof req.id !== 'number' || req.id === processedId) return;
    processedId = req.id;
    busy = true;
    try {
      await handleCommand(req);
    } catch (e) {
      writeResult(req.id, { ok: false, error: String(e).slice(0, 200) });
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
  }
}, 120);
