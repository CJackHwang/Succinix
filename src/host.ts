// WebUnix POC host v4.1 — TerminalExecutor：WebContainer 内常驻的统一终端执行器。
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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { registerProcess, listProcesses, killProcess, appendProcessOutput, markProcessExited } from './host-procs.js';

const CMD_FILE = 'cmd.json';
const RESULT_PREFIX = 'result-'; // result-<id>.json
const RESULT_TTL_MS = 120000; // 陈旧结果文件（浏览器已放弃的请求）存活上限
const LIFO_TIMEOUT_MS = 25000; // Lifo 命令默认超时
const NODE_TIMEOUT_MS = 30000; // node 子进程默认超时兜底
// TASK18：单命令 stdout/stderr 各自最多保留的字符数（防超大输出 OOM）。
// 正常命令（seq 1 5000 约 25KB / npm install 日志 / cat 中大型文件）远低于此上限；
// 超出时保留尾部，避免容器内内存与结果文件无限增长。
const MAX_OUTPUT_BYTES = 1024 * 1024;
// TASK19：spawn 确认窗口（ms）。后台进程（node/npm/npx）在此窗口内以非零退出视为"启动失败"，
// 立即向浏览器报 ok:false（如 npx 包不存在、node 脚本语法错误、端口被占直接退出）。
// 后台服务（tinbase / http server）都会存活超过该窗口，仅多等一拍，对调用方无感知。
const SPAWN_CONFIRM_MS = 2000;

// 输出截断：超出上限保留尾部（用户关心结尾）。在 settle 时应用最终截断。
function capOutput(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? s.slice(-MAX_OUTPUT_BYTES) : s;
}

// TASK18：Lifo 内核懒加载 + 延迟预热（评估成本后的选择）。
// @lifo-sh/core 单独 bundle（lifo-core.js，~1MB），解析执行都慢；若静态 import 进 host.js，
// host 启动就要解析整个 1MB bundle，实测 boot 探活 ping 被拖慢 ~640ms。
// 因此：host.js 保持轻量（RPC/进程表/node 子进程），Lifo 内核经动态 import('./lifo-core.js')
// 在首次使用时加载；并延迟预热（setTimeout 150ms，host 响应完首批 ping 后在后台加载）。
// 协议不变：只把内核加载从"启动阻塞"改为"延迟预热 + 首次使用懒加载"。
let sandboxPromise: Promise<Awaited<ReturnType<typeof import('./lifo-core.js').Sandbox.create>>> | null = null;

function getSandbox(): Promise<Awaited<ReturnType<typeof import('./lifo-core.js').Sandbox.create>>> {
  if (!sandboxPromise) {
    sandboxPromise = import('./lifo-core.js')
      .then(({ Sandbox }) =>
        Sandbox.create({
          mounts: [
            {
              virtualPath: '/workspace',
              hostPath: process.cwd(),
              fsModule: fs as never,
            },
          ],
        })
      )
      .catch((e) => {
        // 预热/首用失败（如 lifo-core.js 尚未注入完成）：清空缓存，下次调用重试。
        sandboxPromise = null;
        throw e;
      });
  }
  return sandboxPromise;
}

// 延迟预热：host 模块加载完成 + 首批 ping 响应后启动内核加载（见上注释）。
// 预热失败（lifo-core.js 可能还在注入中）时静默，首个 Lifo 命令会重试。
setTimeout(() => {
  void getSandbox().catch(() => {});
}, 150);

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

// ─── /etc/webunix.env 合并（TASK10）───
// env 命令把环境变量持久化到 /etc/webunix.env（浏览器侧 wc.fs 写入，随快照保留）。
// host 是常驻进程，启动后无法更新自身 process.env —— 改为 spawn 子进程时
// 解析该文件并合并进 env 选项，使 node/npm/npx 子进程能读到配置的变量。
const ENV_FILE = '/etc/webunix.env';

function loadEnvFile(): Record<string, string> {
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    const env: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      env[line.slice(0, idx).trim()] = line.slice(idx + 1);
    }
    return env;
  } catch {
    return {}; // 文件不存在 / 不可读：空合并，不影响 spawn
  }
}

// 子进程环境 = host 自身环境 + env 文件覆盖（文件是配置的权威来源）。
function mergedEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...loadEnvFile() };
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
    case 'spawn':
      dispatchSpawn(req);
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
      writeResult(req.id, { ok: false, error: `unknown command: ${req.cmd}` });
  }
}

// 统一路由：node|npm|npx → spawn 真 Node；其余 → lifo sandbox。
async function dispatchRun(req: CommandRequest): Promise<void> {
  const command = String(req.opts?.command ?? '').trim();
  if (!command) {
    writeResult(req.id, { ok: false, exitCode: -1, stdout: '', stderr: 'empty command', runtime: 'lifo' });
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
  const child = spawn(prog, args, { cwd: process.cwd(), env: mergedEnv() });
  registerProcess(prog + (args.length ? ' ' + args.join(' ') : ''), child);

  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = (payload: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    // TASK18 输出上限：最终截断在 settle 应用，保证结果文件有界。
    writeResult(reqId, { ...payload, stdout: capOutput(stdout), stderr: capOutput(stderr) });
  };

  // 增量截断：累积超过 2 倍上限时先裁到 1 倍，防止内存随输出无限增长（OOM 防护）。
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString();
    if (stdout.length > MAX_OUTPUT_BYTES * 2) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > MAX_OUTPUT_BYTES * 2) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
  });

  // 超时兜底：避免挂死的子进程永久占坑；可被 opts.timeout 覆盖
  const timeoutMs = typeof opts?.timeout === 'number' ? opts.timeout : NODE_TIMEOUT_MS;
  timer = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill();
      settle({ ok: false, exitCode: -1, stdout, stderr: `node subprocess timed out after ${timeoutMs}ms, killed`, runtime: 'node' });
    }
  }, timeoutMs);

  child.on('close', (code: number | null) =>
    settle({ ok: code === 0, exitCode: code ?? -1, stdout, stderr, runtime: 'node' })
  );
  child.on('error', (e: Error) =>
    settle({ ok: false, exitCode: -1, stdout, stderr: String(e), runtime: 'node' })
  );
}

// spawn：后台长驻进程（端口管理 / 数据库服务等）。
// 只支持 node 系命令（spawn 用于服务器；Lifo 侧没有后台概念，明确返回"不支持"）。
// 与 run 的 node 分支不同：不写最终结果文件，立即返回 { ok, pid, runtime: 'node' }；
// 子进程输出持续收集进进程表条目（outputTail，ps 返回最近 ~500 字符）。
function dispatchSpawn(req: CommandRequest): void {
  const command = String(req.opts?.command ?? '').trim();
  if (!command) {
    writeResult(req.id, { ok: false, error: 'empty command', runtime: 'node' });
    return;
  }
  if (!NODE_PREFIX_RE.test(command)) {
    writeResult(req.id, {
      ok: false,
      error: 'spawn only supports node/npm/npx background processes (Lifo side has no background concept)',
      runtime: 'lifo',
    });
    return;
  }
  const [prog, ...args] = tokenize(command);
  const child = spawn(prog, args, { cwd: process.cwd(), env: mergedEnv() });
  const pid = registerProcess(prog + (args.length ? ' ' + args.join(' ') : ''), child);
  child.stdout?.on('data', (d: Buffer) => appendProcessOutput(pid, d.toString()));
  child.stderr?.on('data', (d: Buffer) => appendProcessOutput(pid, d.toString()));
  let settled = false;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = (payload: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    if (confirmTimer) clearTimeout(confirmTimer);
    writeResult(req.id, payload);
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
    if (!settled) settle({ ok: true, pid, runtime: 'node' });
  }, SPAWN_CONFIRM_MS);
}

// Lifo sandbox：Unix 工具（grep / cat / wc / echo / curl ...）。结果带 runtime: 'lifo'。
async function runLifo(command: string, opts: Record<string, unknown> | undefined, reqId: number): Promise<void> {
  try {
    const timeout = typeof opts?.timeout === 'number' ? opts.timeout : LIFO_TIMEOUT_MS;
    // 首次使用才 await sandbox 初始化（懒加载兜底；延迟预热通常已让内核就绪）。
    const sandbox = await getSandbox();
    const r = await sandbox.commands.run(command, { timeout });
    writeResult(reqId, {
      ok: r.exitCode === 0,
      exitCode: r.exitCode,
      // TASK18 输出上限：Lifo 结果同样截断，保证结果文件有界。
      stdout: capOutput(r.stdout),
      stderr: capOutput(r.stderr),
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
    writeResult(req.id, { ok: false, killed: false, message: `invalid pid: ${req.opts?.pid ?? req.cmd}` });
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
}, 50); // TASK18：轮询 120ms → 50ms（命令往返的 host 侧等待减半；fs.existsSync 每 50ms 一次开销可忽略）
