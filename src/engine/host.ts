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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { registerProcess, listProcesses, killProcess, appendProcessOutput, markProcessExited } from './host-procs.js';
import { tokenize, hasShellMetaToken } from './tokenize.js';
import { pythonDaemon, PYTHON_DAEMON_JS } from './python-daemon-client.js';

const CMD_FILE = 'cmd.json';
const RESULT_PREFIX = 'result-'; // result-<id>.json
// 陈旧结果文件（浏览器已放弃的请求）存活上限。可被 /etc/succinix.engine.json 的
// { resultTtlMs } 覆盖（TASK21：引擎选项经容器内小配置文件传给 host，浏览器侧 boot 时写入）。
let RESULT_TTL_MS = 120000;
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

// 引擎配置文件：浏览器侧 boot 时写入（仅当显式传了 resultTtlMs），host 启动读取。
// TASK24 双根修复：浏览器 wc.fs 的 `/` == host 进程 cwd，写 `wc.fs /etc/succinix.engine.json`
// 即 host 视角的 `process.cwd()/etc/succinix.engine.json`；若仍读 node 虚拟系统根 `/etc/...`
// （bin/dev/etc 那个根）会读不到 → resultTtlMs 覆盖从未生效。统一用 process.cwd() 拼接。
// 失败静默回落默认值 —— 配置文件是可选优化，不影响协议。
function loadEngineConfig(): { resultTtlMs?: number } {
  try {
    const cfgPath = `${process.cwd()}/etc/succinix.engine.json`;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { resultTtlMs?: unknown };
    if (typeof cfg.resultTtlMs === 'number' && Number.isFinite(cfg.resultTtlMs) && cfg.resultTtlMs > 0) {
      return { resultTtlMs: cfg.resultTtlMs };
    }
  } catch {
    /* 文件缺失 / 非法：回落默认 */
  }
  return {};
}

// 启动即读一次引擎配置（host 常驻，之后不再变化）。
const ENGINE_CFG = loadEngineConfig();
if (ENGINE_CFG.resultTtlMs !== undefined) RESULT_TTL_MS = ENGINE_CFG.resultTtlMs;

// ─── 会话 cwd（TASK23，融合基石）───
// node/npm/npx/python 子进程统一用会话 cwd（初始 = process.cwd()），不再固定 host cwd。
// Lifo 的 cd 成功后 host 同步会话 cwd（仅当新 cwd 在 /workspace 挂载下 —— 那是映射到 host
// 真实文件系统的路径，Lifo VFS 私有路径如 /tmp 没有 host 等价物，不同步）。
// 会话 cwd 持久化到 /etc/succinix.cwd（随快照），刷新后 host 启动恢复。
// TASK24 双根修复：浏览器 wc.fs 的 `/` == host 进程 cwd，随快照的 /etc/succinix.cwd 落在
// `process.cwd()/etc/` 下；若 CWD_FILE 仍用 node 虚拟系统根 `/etc/succinix.cwd`（只读系统根），
// 写不进去/读不到 → 刷新后 cwd 永久丢失。统一用 process.cwd() 拼接。
const CWD_FILE = `${process.cwd()}/etc/succinix.cwd`;
const WORKSPACE_MOUNT = '/workspace';

function isUnderWorkspace(p: string): boolean {
  return p === WORKSPACE_MOUNT || p.startsWith(WORKSPACE_MOUNT + '/');
}

// VFS 路径 → host 真实路径：/workspace → process.cwd()，/workspace/foo → process.cwd()/foo。
// 非 /workspace 路径（真实路径 / 其他 VFS 私有路径）原样返回。spawn cwd 与会话 cwd 校验共用。
function vfsToReal(p: string): string {
  if (p === WORKSPACE_MOUNT) return process.cwd();
  if (p.startsWith(WORKSPACE_MOUNT + '/')) return process.cwd() + p.slice(WORKSPACE_MOUNT.length);
  return p;
}

// 启动读持久化 cwd；文件缺失 / 目录已不存在（被删）时回落 process.cwd()。
// 校验用 vfsToReal 映射到 host 真实路径再 statSync —— 持久化的值可能是 Lifo VFS 路径
// （/workspace/...），node 虚拟系统根下不存在该路径，直接 existsSync 会误判为失效。
function loadSessionCwd(): string {
  try {
    const saved = fs.readFileSync(CWD_FILE, 'utf8').trim();
    if (saved) {
      const real = vfsToReal(saved);
      if (fs.existsSync(real) && fs.statSync(real).isDirectory()) {
        return saved; // 返回持久化的会话 cwd（显示语义不变，spawn 时再映射）
      }
    }
  } catch {
    /* 文件缺失 / 不可读：回落默认 */
  }
  return process.cwd();
}

let sessionCwd = loadSessionCwd();

// 持久化会话 cwd。写失败不阻断命令 —— cwd 同步是增强，不因持久化失败把命令报错。
function persistSessionCwd(): void {
  try {
    // 全新容器可能没有 /etc（浏览器侧只在首次写配置时 mkdir），host 侧写前确保父目录存在。
    fs.mkdirSync(path.dirname(CWD_FILE), { recursive: true });
    fs.writeFileSync(CWD_FILE, sessionCwd);
  } catch {
    /* 写失败静默（快照仍会收录当前会话内已同步的 cwd） */
  }
}

// TASK24（自检崩溃根因修复）：会话 cwd 在 Lifo 侧是 VFS 路径（/workspace 挂载视图），但
// 真实容器 FS 没有 /workspace（容器根只读，无法创建 —— 浏览器 wc.fs 的 `/` 映射到 host
// process.cwd() 即 /home/<wc-id>，Lifo 的 /workspace 只是那个目录的挂载别名）。
// 直接 spawn(node, { cwd: '/workspace' }) 会因 chdir 失败在 WebContainer 里挂起（spawn
// 不报 ENOENT，子进程永不退出）→ 自检 `timeout: run`。子进程 spawn 前必须把 VFS 路径
// 映射回 host 真实路径：/workspace → process.cwd()，/workspace/foo → process.cwd()/foo。
// 非 /workspace 路径（如持久化的真实路径）原样使用；仅影响 spawn，不改会话 cwd 显示语义。
function spawnCwd(): string {
  return vfsToReal(sessionCwd);
}

// 浏览器视角的绝对路径 → host 真实路径。wc.fs 的 `/` 与 Lifo 的 /workspace 都映射到
// process.cwd()（/home/<wc-id>），所以 `/foo` 和 `/workspace/foo` 的真实位置都是
// process.cwd()/foo。node/python 子进程收到这类绝对路径参数（如 `python /script.py`）时
// 若原样传给真实容器根 `/`（bin/dev/etc...）会找不到文件；映射后脚本可读。
function resolveBrowserPath(p: string): string {
  if (!p.startsWith('/')) return p; // 相对路径：由 spawn cwd（真实路径）解析
  const rel = p === WORKSPACE_MOUNT ? '/' : p.startsWith(WORKSPACE_MOUNT + '/') ? p.slice(WORKSPACE_MOUNT.length) : p;
  return process.cwd() + rel;
}

// python 运行时参数：脚本模式（第一个参数是文件路径，非 -c/--version）的绝对路径映射到 host
// 真实路径，否则 `python /script.py` 在真实容器根找不到浏览器写入的脚本。runPython 与 Lifo
// 转发（管道/链内 python 段）共用，保证两种路径下脚本文件都可读。
function pythonRuntimeArgs(rawArgs: string[]): string[] {
  const first = rawArgs[0];
  if (first !== undefined && first !== '-c' && first !== '--version') {
    return [resolveBrowserPath(first), ...rawArgs.slice(1)];
  }
  return rawArgs;
}

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
          // TASK23：初始 cwd = /workspace 挂载点（默认是 /home/user，Lifo VFS 私有路径），
          // 让 Lifo 起始 cwd 与会话 cwd（process.cwd()）一致 —— pwd / node 子进程口径统一。
          cwd: WORKSPACE_MOUNT,
          mounts: [
            {
              virtualPath: '/workspace',
              hostPath: process.cwd(),
              fsModule: fs as never,
            },
          ],
        })
      )
      .then((sandbox) => {
        // TASK24 坑 1：node 系命令含 shell 元字符时整条回退给 Lifo shell 执行。Lifo 内置
        // node/npm/npx 是进程内 JS 解释器（报自己的版本号），不是真 node —— 这里注册转发
        // 命令，把 Lifo shell 里的 node/npm/npx 段直启真二进制（cwd/环境与会话 cwd 对齐），
        // stdout/stderr 写进 Lifo 命令上下文流（Lifo shell 已把它们接到管道/重定向）。
        // 递归防护：转发命令直接 spawn 真二进制，不再回 host 分派 → 不会二次回退。
        registerRealBinaryCommands(sandbox);
        return sandbox;
      })
      .catch((e) => {
        // 预热/首用失败（如 lifo-core.js 尚未注入完成）：清空缓存，下次调用重试。
        sandboxPromise = null;
        throw e;
      });
  }
  return sandboxPromise;
}

// 在 Lifo 内核里注册 node/npm/npx/python/python3 转发命令（覆盖内置 JS 解释器 shim）。
// 每个命令把 ctx.args 直传给真二进制（python 是 node 加载运行时脚本），输出累积后写入
// ctx.stdout/stderr（管道/链在 shell 层已接好，写 ctx 流即进管道）。stderr 累积以支持 EACCES 提示追加。
// cwd 用 Lifo 命令上下文的 VFS cwd 映射回 host 真实路径（链内 `cd /workspace/sub` 也能跟随，
// 与 runNode 的 spawnCwd() 语义一致）；非 /workspace 的 Lifo 私有路径回落会话 cwd。
function registerRealBinaryCommands(
  sandbox: Awaited<ReturnType<typeof import('./lifo-core.js').Sandbox.create>>
): void {
  const lifoSpawnCwd = (vfsCwd: string): string => {
    if (vfsCwd === WORKSPACE_MOUNT) return process.cwd();
    if (vfsCwd.startsWith(WORKSPACE_MOUNT + '/')) {
      return process.cwd() + vfsCwd.slice(WORKSPACE_MOUNT.length);
    }
    return spawnCwd();
  };
  // 共享转发：spawn 一个真实子进程，stdout/stderr 累积后写入 Lifo 命令上下文流；
  // 超时/中断（Lifo shell 的 signal）时子进程一并杀掉。
  const forward = (
    ctx: { stdout: { write(s: string): void }; stderr: { write(s: string): void }; signal?: AbortSignal | null },
    child: ReturnType<typeof spawn>
  ): Promise<number> => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (stdout.length > MAX_OUTPUT_BYTES * 2) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > MAX_OUTPUT_BYTES * 2) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
    });
    const onAbort = () => child.kill();
    ctx.signal?.addEventListener('abort', onAbort);
    return new Promise<number>((resolve) => {
      child.on('close', (code) => {
        ctx.signal?.removeEventListener('abort', onAbort);
        ctx.stdout.write(stdout);
        ctx.stderr.write(withEaccesHint(stderr));
        resolve(code ?? -1);
      });
      child.on('error', (e: Error) => {
        ctx.signal?.removeEventListener('abort', onAbort);
        ctx.stderr.write(String(e));
        resolve(-1);
      });
    });
  };

  for (const name of ['node', 'npm', 'npx']) {
    sandbox.commands.register(name, async (ctx) => {
      const child = spawn(name, ctx.args, { cwd: lifoSpawnCwd(ctx.cwd), env: mergedEnv() });
      return forward(ctx, child);
    });
  }
  // TASK27：python/pip 命令含 shell 元字符时整条经 Lifo shell 执行（真管道），python 段
  // 转发到常驻 Pyodide daemon（python-daemon-client）。资产未注入时给明确错误，与 runPython 一致。
  const pythonForward = async (
    ctx: { stdout: { write(s: string): void }; stderr: { write(s: string): void }; cwd: string },
    args: string[]
  ): Promise<number> => {
    if (!fs.existsSync(PYTHON_DAEMON_JS)) {
      ctx.stderr.write(
        'python runtime failed to load: assets not injected yet — run any other command first, or refresh the page (the runtime is injected on first use)'
      );
      return -1;
    }
    const r = await pythonDaemon.exec(args, lifoSpawnCwd(ctx.cwd), PYTHON_TIMEOUT_MS);
    ctx.stdout.write(r.stdout);
    ctx.stderr.write(withEaccesHint(r.stderr));
    return r.exitCode;
  };
  for (const name of ['python', 'python3']) {
    sandbox.commands.register(name, async (ctx) => pythonForward(ctx, pythonRuntimeArgs(ctx.args)));
  }
  for (const name of ['pip', 'pip3']) {
    sandbox.commands.register(name, async (ctx) => pythonForward(ctx, ['-m', 'pip', ...ctx.args]));
  }
}

// 延迟预热：host 模块加载完成 + 首批 ping 响应后启动内核加载（见上注释）。
// 预热失败（lifo-core.js 可能还在注入中）时静默，首个 Lifo 命令会重试。
setTimeout(() => {
  void getSandbox().catch(() => {});
}, 150);

// ─── 命令路由 ───

// 以 node / npm / npx 开头（后跟空格或直接结束）的整条命令 → 真 Node 子进程
const NODE_PREFIX_RE = /^(node|npm|npx)(\s|$)/;
// TASK27：python / python3 开头 → 专用 python 运行时（host 常驻 Pyodide daemon）。
// 独立命令而非并入 node 系：python 需要专用启动逻辑（先确保资产注入、daemon 懒启动）。
const PYTHON_PREFIX_RE = /^(python|python3)(\s|$)/;
// TASK27：pip / pip3 命令 → 映射到 Pyodide 的 micropip（daemon 内 `-m pip <args>`）。
// 与 python 共用路由（含 shell 元字符时整条回退 Lifo shell，pip 段转发到 daemon）。
const PIP_PREFIX_RE = /^(pip|pip3)(\s|$)/;
// TASK23：Lifo 的 cd 命令（成功后会同步会话 cwd）。只匹配整条命令以 cd 开头。
const CD_PREFIX_RE = /^cd(\s|$)/;
// python daemon 脚本在容器内的位置（浏览器首用 python/pip 时懒注入 assets 到同一目录）。
// TASK24 双根铁律：浏览器 wc.fs 的 `/` == host 进程 cwd（/home/<wc-id>），python-assets.ts
// 经 wc.fs 把运行时写到 `/usr/lib/succinix/python/...`，即 host 视角的 `process.cwd()/usr/lib/...`；
// 若这里仍用 node 虚拟系统根 `/usr/lib/...`（bin/dev/etc 那个根）会找不到 → 报
// "assets not injected yet"。统一用 process.cwd() 拼接，两侧对齐。
// PYTHON_DAEMON_JS 由 ./python-daemon-client.js 导出（同一 process.cwd() 拼接），本文件不再自建。

// python 命令默认超时（比 node 子进程宽松）：首个命令含 daemon 懒启动 + 可能的重装恢复，
// pip install 走网络拉 wheel —— 120s 内可完成；daemon 内部也有同等超时兜底。
const PYTHON_TIMEOUT_MS = 150000;

// TASK24 坑 3：npm i -g 在 /usr/local 只读时的可操作提示。只在 stderr 含 EACCES + /usr/local
// 时**追加**一行（不替换原错误），权限语义保持（真实 Linux 同样无 sudo 装不了全局）。
const EACCES_HINT =
  'hint: /usr/local is read-only for guest. Install locally: npm i <pkg>  (or set a user prefix: npm config set prefix ~/.npm-global)';

function withEaccesHint(stderr: string): string {
  if (!stderr.includes('EACCES') || !stderr.includes('/usr/local')) return stderr;
  return `${stderr.replace(/\s+$/, '')}\n${EACCES_HINT}\n`;
}

interface CommandRequest {
  /** 协议版本（TASK21：客户端写 protocol: 1；缺失按 v1 处理，向后兼容） */
  protocol?: number;
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

// ─── /etc/succinix.env 合并（TASK10）───
// env 命令把环境变量持久化到 /etc/succinix.env（浏览器侧 wc.fs 写入，随快照保留）。
// host 是常驻进程，启动后无法更新自身 process.env —— 改为 spawn 子进程时
// 解析该文件并合并进 env 选项，使 node/npm/npx 子进程能读到配置的变量。
// TASK24 双根修复：浏览器 wc.fs 写 `/etc/succinix.env` == host 视角 `process.cwd()/etc/succinix.env`；
// 若仍读 node 虚拟系统根 `/etc/succinix.env` 会读不到 → env 合并从未生效。统一 process.cwd() 拼接。
const ENV_FILE = `${process.cwd()}/etc/succinix.env`;

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
      writeResult(req.id, { ok: true, kind: 'cwd', cwd: sessionCwd });
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
// TASK24 坑 1：node 系命令含 shell 元字符（&& / | / > / 2>&1 ...）时，整条命令回退给
// Lifo shell 执行 —— Lifo 的 shell 层解析管道/重定向/链，各 node 段经 registerRealBinaryCommands
// 转回真 node/npm/npx（见 getSandbox）。结果 runtime 仍标 'lifo'（shell 层执行），文档注明。
// 纯 node 命令（无元字符）行为不变（直启子进程）。
async function dispatchRun(req: CommandRequest): Promise<void> {
  const command = String(req.opts?.command ?? '').trim();
  if (!command) {
    writeResult(req.id, { ok: false, exitCode: -1, stdout: '', stderr: 'empty command', runtime: 'lifo' });
    return;
  }
  if (NODE_PREFIX_RE.test(command)) {
    const t = tryTokenize(command);
    if (!t.ok) {
      writeResult(req.id, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' });
      return;
    }
    if (hasShellMetaToken(t.tokens)) {
      await runLifo(command, req.opts, req.id); // 混合链：Lifo shell 层执行
      return;
    }
    runNode(command, req.opts, req.id); // 立即返回；子进程结束时异步写结果
    return;
  }
  if (PYTHON_PREFIX_RE.test(command) || PIP_PREFIX_RE.test(command)) {
    // TASK27：python/pip 命令含 shell 元字符（| / > / && ...）时整条经 Lifo shell 执行
    // —— Lifo 的 shell 层解析管道/重定向/链，python/pip 段经 registerRealBinaryCommands 转回
    // 常驻 daemon（见 getSandbox）。纯 python/pip 命令（无元字符）走 daemon 直启。
    const t = tryTokenize(command);
    if (!t.ok) {
      writeResult(req.id, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' });
      return;
    }
    if (hasShellMetaToken(t.tokens)) {
      await runLifo(command, req.opts, req.id); // 混合链：Lifo shell 层执行
      return;
    }
    await runPython(command, req.opts, req.id); // daemon 响应后写结果
    return;
  }
  await runLifo(command, req.opts, req.id);
}

// 分词兜底：未闭合引号等语法错误给出明确报错，不静默截断、不抛到协议层。
function tryTokenize(command: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  try {
    return { ok: true, tokens: tokenize(command) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 真 Node 子进程：命令串 → 简单分词 → spawn(prog, args, { cwd: spawnCwd() })。
// 结果带 runtime: 'node'。进程登记进进程表，可被 ps / kill 管理。
function runNode(command: string, opts: Record<string, unknown> | undefined, reqId: number): void {
  const t = tryTokenize(command);
  if (!t.ok) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' });
    return;
  }
  const [prog, ...args] = t.tokens;
  spawnChild(prog, args, opts, reqId, 'node');
}

// TASK27：python / python3 / pip / pip3 命令 → 发往常驻 Pyodide daemon（python-daemon-client）。
// 纯 python/pip 命令（无 shell 元字符）走这里；含管道/重定向的混合链由 dispatchRun 转给
// Lifo shell（python/pip 段再经 registerRealBinaryCommands 转发到同一 daemon —— 实例状态共享）。
// 资产未注入时给明确错误，系统不崩（装不坏：python 不依赖用户 npm install）。
async function runPython(command: string, opts: Record<string, unknown> | undefined, reqId: number): Promise<void> {
  if (!fs.existsSync(PYTHON_DAEMON_JS)) {
    writeResult(reqId, {
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr:
        'python runtime failed to load: assets not injected yet — run any other command first, or refresh the page (the runtime is injected on first use)',
      runtime: 'node',
    });
    return;
  }
  const t = tryTokenize(command);
  if (!t.ok) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' });
    return;
  }
  const [, ...rawArgs] = t.tokens; // 丢弃 python/python3/pip/pip3 前缀
  const args = PIP_PREFIX_RE.test(command) ? ['-m', 'pip', ...rawArgs] : pythonRuntimeArgs(rawArgs);
  const timeoutMs = typeof opts?.timeout === 'number' ? opts.timeout : PYTHON_TIMEOUT_MS;
  const r = await pythonDaemon.exec(args, spawnCwd(), timeoutMs);
  writeResult(reqId, {
    ok: r.exitCode === 0,
    exitCode: r.exitCode,
    stdout: capOutput(r.stdout),
    stderr: withEaccesHint(capOutput(r.stderr)),
    runtime: 'node',
  });
}

// 共享子进程捕获逻辑：runNode（node/npm/npx）与 runPython（python 运行时）共用。
// 结果带 runtime: 'node'（python 实际也是 node 子进程 —— 协议路由字段不变）。
// 立即返回；子进程结束时异步写 result-<id>.json。cwd 用会话 cwd（TASK23）。
function spawnChild(
  prog: string,
  args: string[],
  opts: Record<string, unknown> | undefined,
  reqId: number,
  label: string
): void {
  const child = spawn(prog, args, { cwd: spawnCwd(), env: mergedEnv() });
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
    // TASK24 坑 3：EACCES 提示在截断之后追加，保证即使输出超上限提示也在。
    writeResult(reqId, {
      ...payload,
      stdout: capOutput(stdout),
      stderr: withEaccesHint(capOutput(stderr)),
    });
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
      settle({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: `${label} subprocess timed out after ${timeoutMs}ms, killed`,
        runtime: 'node',
      });
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
  const t = tryTokenize(command);
  if (!t.ok) {
    writeResult(req.id, { ok: false, error: t.error, runtime: 'node' });
    return;
  }
  const [prog, ...args] = t.tokens;
  const child = spawn(prog, args, { cwd: spawnCwd(), env: mergedEnv() });
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
// TASK23：cd 成功后把会话 cwd 同步到 Lifo 新 cwd（仅 /workspace 下 —— 映射 host 真实路径），
// 并持久化 /etc/succinix.cwd；cd 到不存在目录 → Lifo 报错（exit≠0），会话 cwd 不变。
async function runLifo(command: string, opts: Record<string, unknown> | undefined, reqId: number): Promise<void> {
  try {
    const timeout = typeof opts?.timeout === 'number' ? opts.timeout : LIFO_TIMEOUT_MS;
    // 首次使用才 await sandbox 初始化（懒加载兜底；延迟预热通常已让内核就绪）。
    const sandbox = await getSandbox();
    const r = await sandbox.commands.run(command, { timeout });
    const payload: Record<string, unknown> = {
      ok: r.exitCode === 0,
      exitCode: r.exitCode,
      // TASK18 输出上限：Lifo 结果同样截断，保证结果文件有界。
      stdout: capOutput(r.stdout),
      stderr: capOutput(r.stderr),
      runtime: 'lifo',
    };
    if (r.exitCode === 0 && CD_PREFIX_RE.test(command)) {
      const lifoCwd = sandbox.cwd;
      if (isUnderWorkspace(lifoCwd)) {
        sessionCwd = lifoCwd;
        persistSessionCwd();
        // 结果带会话 cwd 字段（新增可选协议字段，向后兼容）。
        payload.cwd = sessionCwd;
      }
    }
    writeResult(reqId, payload);
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

// setCwd：显式设置会话 cwd（TASK23 协议新增，向后兼容 —— 客户端可选使用）。
// 校验绝对路径且为已存在目录；cd 命令的自动同步已覆盖交互路径，此命令供生态/自检显式设置。
function dispatchSetCwd(req: CommandRequest): void {
  const raw = String(req.opts?.cwd ?? '');
  if (!raw.startsWith('/')) {
    writeResult(req.id, { ok: false, error: `setCwd: cwd must be an absolute path: ${raw}` });
    return;
  }
  try {
    const real = vfsToReal(raw);
    if (!fs.statSync(real).isDirectory()) {
      writeResult(req.id, { ok: false, error: `setCwd: not a directory: ${raw}` });
      return;
    }
  } catch {
    writeResult(req.id, { ok: false, error: `setCwd: not a directory: ${raw}` });
    return;
  }
  sessionCwd = raw;
  persistSessionCwd();
  writeResult(req.id, { ok: true, kind: 'cwd', cwd: sessionCwd });
}

// kill 协议支持 { cmd: 'kill', opts: { pid } }，也兼容 "kill 1234" 字符串形式。
function parsePid(req: CommandRequest): number {
  const fromOpts = Number(req.opts?.pid);
  if (Number.isInteger(fromOpts) && fromOpts > 0) return fromOpts;
  const m = /^kill\s+(\d+)$/.exec(req.cmd);
  return m ? Number(m[1]) : NaN;
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
