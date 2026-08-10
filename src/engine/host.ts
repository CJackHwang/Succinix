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
// P1-4：纯逻辑（路由判定 / 路径映射 / 截断 / EACCES 提示）抽到 host-route.ts，可单测。
import {
  WORKSPACE_MOUNT,
  NODE_PREFIX_RE,
  PIP_PREFIX_RE,
  classifyPrefix,
  classifyRoute,
  vfsToReal,
  spawnCwdFor,
  pythonRuntimeArgs,
  mapDataDirArgs,
  lifoSpawndCwd,
  lifoCwdToSessionCwd,
  capOutput,
  MAX_OUTPUT_BYTES,
  withEaccesHint,
  parseKillPid,
  shouldRemoveCmdFile,
  CD_PREFIX_RE,
  DEFAULT_INSTANCE_ID,
  normalizeInstanceId,
  instanceStateRootFor,
  instanceStateFile,
  filterProcessesForInstance,
  canKillProcess,
  CurrentRunRegistry,
} from './host-route.js';

const CMD_FILE = 'cmd.json';
const RESULT_PREFIX = 'result-'; // result-<id>.json
// 陈旧结果文件（浏览器已放弃的请求）存活上限。可被 /etc/succinix.engine.json 的
// { resultTtlMs } 覆盖（TASK21：引擎选项经容器内小配置文件传给 host，浏览器侧 boot 时写入）。
let RESULT_TTL_MS = 120000;
const LIFO_TIMEOUT_MS = 25000; // Lifo 命令默认超时
const NODE_TIMEOUT_MS = 30000; // node 子进程默认超时兜底
// TASK19：spawn 确认窗口（ms）。后台进程（node/npm/npx）在此窗口内以非零退出视为"启动失败"，
// 立即向浏览器报 ok:false（如 npx 包不存在、node 脚本语法错误、端口被占直接退出）。
// 后台服务（tinbase / http server）都会存活超过该窗口，仅多等一拍，对调用方无感知。
const SPAWN_CONFIRM_MS = 2000;

// 引擎配置文件：浏览器侧 boot 时写入（仅当显式传了 resultTtlMs），host 启动读取。
// TASK24 双根修复：浏览器 wc.fs 的 `/` == host 进程 cwd，写 `wc.fs /etc/succinix.engine.json`
// 即 host 视角的 `process.cwd()/etc/succinix.engine.json`；若仍读 node 虚拟系统根 `/etc/...`
// （bin/dev/etc 那个根）会读不到 → resultTtlMs 覆盖从未生效。统一用 process.cwd() 拼接。
// 失败静默回落默认值 —— 配置文件是可选优化，不影响协议。
function loadEngineConfig(stateRoot: string): { resultTtlMs?: number } {
  try {
    const cfgPath = `${stateRoot}/etc/succinix.engine.json`;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { resultTtlMs?: unknown };
    if (typeof cfg.resultTtlMs === 'number' && Number.isFinite(cfg.resultTtlMs) && cfg.resultTtlMs > 0) {
      return { resultTtlMs: cfg.resultTtlMs };
    }
  } catch {
    /* 文件缺失 / 非法：回落默认 */
  }
  return {};
}

// 引擎配置按实例读取（M2）：浏览器侧 boot 时把配置写到该实例的
// <stateRoot>/etc/succinix.engine.json；host 按请求携带的 instanceId 解析自身配置路径
// （全局单份 /etc 配置在多实例下会串扰，禁止）。配置缓存按实例存 —— host 常驻，
// 每个实例的配置在其首请求时读一次。resultTtlMs 是全局结果文件清理参数，最后一次
// 加载生效（清理动作是 host 全局的，不按实例区分）。
const engineCfgByInstance = new Map<string, { resultTtlMs?: number }>();

function getEngineConfig(instanceId: string): { resultTtlMs?: number } {
  let cfg = engineCfgByInstance.get(instanceId);
  if (cfg === undefined) {
    cfg = loadEngineConfig(instanceStateRootFor(instanceId, process.cwd()));
    if (cfg.resultTtlMs !== undefined) RESULT_TTL_MS = cfg.resultTtlMs;
    engineCfgByInstance.set(instanceId, cfg);
  }
  return cfg;
}

// 启动即读默认实例配置（host 常驻，之后不再变化；默认实例 = 现状单例语义）。
getEngineConfig(DEFAULT_INSTANCE_ID);

// ─── 会话 cwd（TASK23，融合基石）───
// node/npm/npx/python 子进程统一用会话 cwd（初始 = process.cwd()），不再固定 host cwd。
// Lifo 的 cd 成功后 host 同步会话 cwd（仅当新 cwd 在 /workspace 挂载下 —— 那是映射到 host
// 真实文件系统的路径，Lifo VFS 私有路径如 /tmp 没有 host 等价物，不同步）。
// 会话 cwd 持久化到 /etc/succinix.cwd（随快照），刷新后 host 启动恢复。
// TASK24 双根修复：浏览器 wc.fs 的 `/` == host 进程 cwd，随快照的 /etc/succinix.cwd 落在
// `process.cwd()/etc/` 下；若 CWD_FILE 仍用 node 虚拟系统根 `/etc/succinix.cwd`（只读系统根），
// 写不进去/读不到 → 刷新后 cwd 永久丢失。统一用 process.cwd() 拼接。
// WORKSPACE_MOUNT / vfsToReal / spawnCwdFor / resolveBrowserPath /
// pythonRuntimeArgs / lifoSpawndCwd / lifoCwdToSessionCwd / capOutput /
// MAX_OUTPUT_BYTES 均在 host-route.ts（P1-4）。

// 会话 cwd 按实例分键（M2）：同页共享 host 时各实例独立 cwd（缺省 default 键 = 现状单值
// 全等）。启动读各自持久化 cwd；文件缺失 / 目录已不存在（被删）时回落 process.cwd()。
// 校验用 vfsToReal 映射到 host 真实路径再 statSync —— 持久化的值可能是 Lifo VFS 路径
// （/workspace/...），node 虚拟系统根下不存在该路径，直接 existsSync 会误判为失效。
function loadSessionCwd(instanceId: string): string {
  try {
    const saved = fs.readFileSync(instanceStateFile(instanceId, process.cwd(), 'etc/succinix.cwd'), 'utf8').trim();
    if (saved) {
      const real = vfsToReal(saved, process.cwd());
      if (fs.existsSync(real) && fs.statSync(real).isDirectory()) {
        return saved; // 返回持久化的会话 cwd（显示语义不变，spawn 时再映射）
      }
    }
  } catch {
    /* 文件缺失 / 不可读：回落默认 */
  }
  return process.cwd();
}

const sessionCwdByInstance = new Map<string, string>();

function getSessionCwd(instanceId: string): string {
  let cwd = sessionCwdByInstance.get(instanceId);
  if (cwd === undefined) {
    cwd = loadSessionCwd(instanceId);
    sessionCwdByInstance.set(instanceId, cwd);
  }
  return cwd;
}

// 持久化会话 cwd。写失败不阻断命令 —— cwd 同步是增强，不因持久化失败把命令报错。
function persistSessionCwd(instanceId: string, cwd: string): void {
  try {
    // 全新容器可能没有 /etc（浏览器侧只在首次写配置时 mkdir），host 侧写前确保父目录存在。
    const file = instanceStateFile(instanceId, process.cwd(), 'etc/succinix.cwd');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cwd);
  } catch {
    /* 写失败静默（快照仍会收录当前会话内已同步的 cwd） */
  }
}

function setSessionCwd(instanceId: string, cwd: string): void {
  sessionCwdByInstance.set(instanceId, cwd);
  persistSessionCwd(instanceId, cwd);
}

// TASK24（自检崩溃根因修复）：子进程 spawn 前必须把 VFS 路径映射回 host 真实路径
// （/workspace → process.cwd()，/workspace/foo → process.cwd()/foo）；直接 spawn
// { cwd: '/workspace' } 会因 chdir 失败在 WebContainer 里挂起（spawn 不报 ENOENT）。
function spawnCwd(instanceId: string): string {
  return spawnCwdFor(getSessionCwd(instanceId), process.cwd());
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
// 与 runNode 的 spawnCwd(instanceId) 语义一致）；非 /workspace 的 Lifo 私有路径回落会话 cwd。
function registerRealBinaryCommands(
  sandbox: Awaited<ReturnType<typeof import('./lifo-core.js').Sandbox.create>>
): void {
  // M2：Lifo 混合链的 node/python 转发在「当前在途请求」的实例上下文里执行（单 host 串行
  // 处理请求，currentInstanceId 即请求所属实例）；cwd/环境按该实例解析。
  const lifoSpawnCwd = (vfsCwd: string): string => lifoSpawndCwd(vfsCwd, getSessionCwd(currentInstanceId), process.cwd());
  // 共享转发：spawn 一个真实子进程，stdout/stderr 累积后写入 Lifo 命令上下文流；
  // 超时/中断（Lifo shell 的 signal）时子进程一并杀掉。
  // V1 H1-2：把 Lifo 混合链拉起的 node/npm/npx 真实子进程登记进 host 进程表（host-procs.ts），
  // 使前台 `cd <root> && npm test` 这类混合链命令的活跃子进程在 ps() 可见、kill 可终止——
  // 此前它们只在 Lifo shell 内部运行，UI 进程表完全不可见。
  // TASK-CISOL（R1）：登记时带上 spawn 的启动 cwd（realCwd），host-procs 据此判定容器归属
  // （cd /workspace/c-<id> 前缀 → 子进程 cwd 落在容器根 → scope=container + containerId）。
  const forward = (
    ctx: { stdout: { write(s: string): void }; stderr: { write(s: string): void }; signal?: AbortSignal | null },
    child: ReturnType<typeof spawn>,
    cmd: string,
    realCwd: string
  ): Promise<number> => {
    // M5：Lifo 混合链转发进程同样按请求实例显式归属（cwd 可能是容器 home，无状态根段）。
    const pid = registerProcess(cmd, child, realCwd, currentInstanceId);
    // both：既累积（写 ctx 流）也追加进程表（ps/kill 可见）。
    const out = attachOutputCollector(child, pid, 'both');
    const onAbort = () => child.kill();
    ctx.signal?.addEventListener('abort', onAbort);
    return new Promise<number>((resolve) => {
      child.on('close', (code) => {
        ctx.signal?.removeEventListener('abort', onAbort);
        ctx.stdout.write(out.stdout());
        ctx.stderr.write(withEaccesHint(out.stderr()));
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
      const realCwd = lifoSpawnCwd(ctx.cwd);
      const child = spawn(name, ctx.args, { cwd: realCwd, env: mergedEnv(currentInstanceId) });
      return forward(ctx, child, [name, ...ctx.args].join(' '), realCwd);
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
    sandbox.commands.register(name, async (ctx) => pythonForward(ctx, pythonRuntimeArgs(ctx.args, process.cwd())));
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
// NODE_PREFIX_RE / PYTHON_PREFIX_RE / PIP_PREFIX_RE / CD_PREFIX_RE 与 EACCES 提示
// 均在 host-route.ts（P1-4，可单测）；分类逻辑用 classifyRoute / classifyPrefix。

// python 命令默认超时（比 node 子进程宽松）：首个命令含 daemon 懒启动 + 可能的重装恢复，
// pip install 走网络拉 wheel —— 120s 内可完成；daemon 内部也有同等超时兜底。
const PYTHON_TIMEOUT_MS = 150000;

interface CommandRequest {
  /** 协议版本（TASK21：客户端写 protocol: 1；缺失按 v1 处理，向后兼容） */
  protocol?: number;
  id: number;
  cmd: string;
  opts?: Record<string, unknown>;
  /** 实例上下文（M2/M3，additive）：可选，缺失 = 默认实例 'default'（旧行为不变）。 */
  instanceId?: string;
}

// M3：结果回带请求的 instanceId（additive，旧客户端忽略未知字段）。instanceId 必须是
// 请求时刻捕获的归一化值 —— node 子进程 settle 是异步的，不能用当时已变的 currentInstanceId。
function writeResult(id: number, payload: Record<string, unknown>, instanceId = DEFAULT_INSTANCE_ID): void {
  fs.writeFileSync(RESULT_PREFIX + id + '.json', JSON.stringify({ id, instanceId, ...payload }));
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
function loadEnvFile(instanceId: string): Record<string, string> {
  try {
    const text = fs.readFileSync(instanceStateFile(instanceId, process.cwd(), 'etc/succinix.env'), 'utf8');
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

// 子进程环境 = host 自身环境 + 该实例 env 文件覆盖（文件是配置的权威来源；M2 按实例分键）。
function mergedEnv(instanceId: string): NodeJS.ProcessEnv {
  return { ...process.env, ...loadEnvFile(instanceId) };
}

// 当前在途请求的实例（M2）：单 host 串行处理 /cmd.json，handleCommand 期间恒为请求所属
// 实例；Lifo 混合链转发 / spawn / cd 同步据此解析 cwd 与环境。处理完毕下一请求覆盖。
let currentInstanceId = DEFAULT_INSTANCE_ID;

// 请求的实例归一化：缺失 / 空串 = 默认实例（additive，旧客户端零改动）。
function instanceOf(req: CommandRequest): string {
  return normalizeInstanceId(req.instanceId);
}

// 统一命令入口：各分支自行写 result-<id>.json。
// node 子进程的 run 会立即返回（结果异步写回），保证 ps/kill 在长命令期间仍可用。
async function handleCommand(req: CommandRequest): Promise<void> {
  currentInstanceId = instanceOf(req);
  const inst = instanceOf(req);
  switch (req.cmd) {
    case 'ping':
      writeResult(req.id, { ok: true, kind: 'pong' }, inst);
      return;
    case 'cwd':
      writeResult(req.id, { ok: true, kind: 'cwd', cwd: getSessionCwd(inst) }, inst);
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

// 统一路由：node|npm|npx → spawn 真 Node；其余 → lifo sandbox。
// TASK24 坑 1：node 系命令含 shell 元字符（&& / | / > / 2>&1 ...）时，整条命令回退给
// Lifo shell 执行 —— Lifo 的 shell 层解析管道/重定向/链，各 node 段经 registerRealBinaryCommands
// 转回真 node/npm/npx（见 getSandbox）。结果 runtime 仍标 'lifo'（shell 层执行），文档注明。
// 纯 node 命令（无元字符）行为不变（直启子进程）。路由判定抽到 host-route.ts（P1-4）。
async function dispatchRun(req: CommandRequest): Promise<void> {
  const command = String(req.opts?.command ?? '').trim();
  if (!command) {
    writeResult(req.id, { ok: false, exitCode: -1, stdout: '', stderr: 'empty command', runtime: 'lifo' });
    return;
  }
  const inst = instanceOf(req);
  const prefix = classifyPrefix(command);
  if (prefix !== 'lifo') {
    // node/python/pip 系才分词做 shell 元字符检查（与旧行为一致：纯 Lifo 命令不经过
    // 分词，未闭合引号交给 Lifo shell 自己处理）。
    const t = tryTokenize(command);
    if (!t.ok) {
      writeResult(req.id, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' }, inst);
      return;
    }
    const route = classifyRoute(command, hasShellMetaToken(t.tokens));
    if (route === 'node') {
      runNode(command, req.opts, req.id, inst); // 立即返回；子进程结束时异步写结果
      return;
    }
    if (route === 'python') {
      await runPython(command, req.opts, req.id, inst); // daemon 响应后写结果
      return;
    }
    await runLifo(command, req.opts, req.id, inst); // 混合链：Lifo shell 层执行
    return;
  }
  await runLifo(command, req.opts, req.id, inst);
}

// 分词兜底：未闭合引号等语法错误给出明确报错，不静默截断、不抛到协议层。
function tryTokenize(command: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  try {
    return { ok: true, tokens: tokenize(command) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 真 Node 子进程：命令串 → 简单分词 → spawn(prog, args, { cwd: spawnCwd(currentInstanceId) })。
// 结果带 runtime: 'node'。进程登记进进程表，可被 ps / kill 管理。
function runNode(command: string, opts: Record<string, unknown> | undefined, reqId: number, instanceId: string): void {
  const t = tryTokenize(command);
  if (!t.ok) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' }, instanceId);
    return;
  }
  // M5：绝对路径数据目录参数（tinbase --data-dir）按浏览器视角映射到 host 真实根
  // （实测：node 进程的容器根没有 /workspace，浏览器 wc.fs `/` == process.cwd()，
  // 浏览器 `/workspace/x` 的真实位置是 process.cwd()/workspace/x），见 host-route.mapDataDirArgs。
  const [prog, ...args] = mapDataDirArgs(t.tokens, process.cwd());
  spawnChild(prog, args, opts, reqId, 'node', instanceId);
}

// TASK27：python / python3 / pip / pip3 命令 → 发往常驻 Pyodide daemon（python-daemon-client）。
// 纯 python/pip 命令（无 shell 元字符）走这里；含管道/重定向的混合链由 dispatchRun 转给
// Lifo shell（python/pip 段再经 registerRealBinaryCommands 转发到同一 daemon —— 实例状态共享）。
// 资产未注入时给明确错误，系统不崩（装不坏：python 不依赖用户 npm install）。
async function runPython(command: string, opts: Record<string, unknown> | undefined, reqId: number, instanceId: string): Promise<void> {
  if (!fs.existsSync(PYTHON_DAEMON_JS)) {
    writeResult(reqId, {
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr:
        'python runtime failed to load: assets not injected yet — run any other command first, or refresh the page (the runtime is injected on first use)',
      runtime: 'node',
    }, instanceId);
    return;
  }
  const t = tryTokenize(command);
  if (!t.ok) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' }, instanceId);
    return;
  }
  const [, ...rawArgs] = t.tokens; // 丢弃 python/python3/pip/pip3 前缀
  const args = PIP_PREFIX_RE.test(command) ? ['-m', 'pip', ...rawArgs] : pythonRuntimeArgs(rawArgs, process.cwd());
  const timeoutMs = typeof opts?.timeout === 'number' ? opts.timeout : PYTHON_TIMEOUT_MS;
  const r = await pythonDaemon.exec(args, spawnCwd(currentInstanceId), timeoutMs);
  writeResult(reqId, {
    ok: r.exitCode === 0,
    exitCode: r.exitCode,
    stdout: capOutput(r.stdout),
    stderr: withEaccesHint(capOutput(r.stderr)),
    runtime: 'node',
  }, instanceId);
}

// ─── 共享子进程工具（P2-8）───
// 三处 spawn（Lifo 混合链 forward / run 的 spawnChild / 后台 dispatchSpawn）都做同一件事的变体：
// spawn(prog, args, {cwd, env}) → registerProcess → stdout/stderr 接线。差异只在输出去向：
//   accumulate —— 累积字符串（增量 2 倍上限截断），settle 时写结果文件
//   append     —— 追加进进程表 outputTail（ps 尾部展示，不截断）
//   both       —— 两者都要（Lifo 混合链：既写 ctx 流也登记进程表）
type OutputMode = 'accumulate' | 'append' | 'both';

// 接线 stdout/stderr 数据处理器。返回累积取读函数（accumulate/both 模式）。
function attachOutputCollector(
  child: ReturnType<typeof spawn>,
  pid: number,
  mode: OutputMode
): { stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  const collect = (which: 'stdout' | 'stderr') => (d: Buffer) => {
    const s = d.toString();
    if (mode !== 'append') {
      // 增量截断：累积超过 2 倍上限时先裁到 1 倍，防止内存随输出无限增长（OOM 防护）。
      if (which === 'stdout') {
        stdout += s;
        if (stdout.length > MAX_OUTPUT_BYTES * 2) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
      } else {
        stderr += s;
        if (stderr.length > MAX_OUTPUT_BYTES * 2) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
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
  opts: { cwd: string; mode: OutputMode }
): { pid: number; child: ReturnType<typeof spawn>; out: ReturnType<typeof attachOutputCollector> } {
  const child = spawn(prog, args, { cwd: opts.cwd, env: mergedEnv(currentInstanceId) });
  // M5：登记时带请求实例 id —— 实例会话 cwd 是容器 home（无状态根段），显式归属保证
  // 实例 ps 视图 / service 状态能看到自己的进程（默认实例不标，行为全等）。
  const pid = registerProcess(prog + (args.length ? ' ' + args.join(' ') : ''), child, opts.cwd, currentInstanceId);
  const out = attachOutputCollector(child, pid, opts.mode);
  return { pid, child, out };
}

// 共享子进程捕获逻辑：runNode（node/npm/npx）与 runPython（python 运行时）共用。
// 结果带 runtime: 'node'（python 实际也是 node 子进程 —— 协议路由字段不变）。
// 立即返回；子进程结束时异步写 result-<id>.json。cwd 用会话 cwd（TASK23）。
function spawnChild(
  prog: string,
  args: string[],
  opts: Record<string, unknown> | undefined,
  reqId: number,
  label: string,
  instanceId: string
): void {
  const realCwd = spawnCwd(currentInstanceId);
  const { pid, child, out } = spawnTracked(prog, args, { cwd: realCwd, mode: 'accumulate' });
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
      child.kill();
      settle({
        ok: false,
        exitCode: -1,
        stderr: `${label} subprocess timed out after ${timeoutMs}ms, killed`,
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
function dispatchSpawn(req: CommandRequest): void {
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
  const realCwd = spawnCwd(currentInstanceId);
  // 后台进程输出只追加进程表 outputTail（不截断累积）；TASK-CISOL 登记 cwd 供归属判定。
  const { pid, child } = spawnTracked(prog, args, { cwd: realCwd, mode: 'append' });
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

// Lifo sandbox：Unix 工具（grep / cat / wc / echo / curl ...）。结果带 runtime: 'lifo'。
// TASK23：cd 成功后把会话 cwd 同步到 Lifo 新 cwd（仅 /workspace 下 —— 映射 host 真实路径），
// 并持久化 /etc/succinix.cwd；cd 到不存在目录 → Lifo 报错（exit≠0），会话 cwd 不变。
async function runLifo(command: string, opts: Record<string, unknown> | undefined, reqId: number, instanceId: string): Promise<void> {
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
      // cd 后 Lifo cwd → 会话 cwd（TASK23 同步；`cd /` 映射到工作区根 /workspace —— 否则
      // isUnderWorkspace('/') 为 false、会话 cwd 不更新，"回到根目录"不可达。决策见 host-route.ts）。
      const effectiveCwd = lifoCwdToSessionCwd(lifoCwd);
      if (effectiveCwd !== null) {
        setSessionCwd(currentInstanceId, effectiveCwd);
        // 结果带会话 cwd 字段（新增可选协议字段，向后兼容）。
        payload.cwd = effectiveCwd;
      }
    }
    writeResult(reqId, payload, instanceId);
  } catch (e) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: String(e).slice(0, 200), runtime: 'lifo' }, instanceId);
  }
}

// ps：进程表快照。请求带 instanceId 时按实例过滤（该实例 + system）；缺省不过滤（现状全等）。
// 归属判定以 host-procs 启发式为准（M2 状态根 .succinix-<id> + CISOL c-<id> 命名空间），
// 非安全边界（UI 展示 / 查询过滤用）。
function dispatchPs(req: CommandRequest): void {
  const inst = instanceOf(req);
  const processes = filterProcessesForInstance(listProcesses(), inst);
  writeResult(req.id, { ok: true, kind: 'ps', processes }, inst);
}

// kill：真实子进程交给进程表模块；Lifo 侧进程不在表内，明确返回"仅支持列表"。
function dispatchKill(req: CommandRequest): void {
  const inst = instanceOf(req);
  const pid = parsePid(req);
  if (!Number.isInteger(pid) || pid <= 0) {
    writeResult(req.id, { ok: false, killed: false, message: `invalid pid: ${req.opts?.pid ?? req.cmd}` }, inst);
    return;
  }
  // U1：kill 越权拒绝（host 侧收口）—— 非默认实例只能 kill 自己归属的进程（M5 显式
  // instanceId 登记 + `.succinix-<id>` / `c-<id>` cwd 启发式）；system 进程与归属不明
  // 的进程拒绝。默认实例 = 现状全等（可 kill 全表）。组织性隔离，非安全边界。
  const target = listProcesses().find((p) => p.pid === pid);
  if (!canKillProcess(target, inst)) {
    writeResult(req.id, {
      ok: false,
      killed: false,
      message: `permission denied: process ${pid} is not owned by instance '${inst}'`,
    }, inst);
    return;
  }
  const r = killProcess(pid);
  writeResult(req.id, { ok: r.killed, killed: r.killed, message: r.message }, inst);
}

// interrupt（P5-15）：浏览器 Ctrl+C —— 终止当前前台 run 的 node 子进程。
// 只杀 currentRunPid（spawnChild 登记的当前 run），不动后台 spawn 服务。
// 进程被杀后 close 事件触发 spawnChild settle → 写 run 结果文件、清 currentRunPid，
// 浏览器侧在途 exec 随即读到结果，busy 结束回到提示符。
// 无当前 run（纯 Lifo 命令 / 空闲）→ 返回 pid:null，浏览器如实提示。
function dispatchInterrupt(req: CommandRequest): void {
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
  writeResult(req.id, { ok: true, kind: 'interrupted', pid: null }, inst);
}

// setCwd：显式设置会话 cwd（TASK23 协议新增，向后兼容 —— 客户端可选使用）。
// 校验绝对路径且为已存在目录；cd 命令的自动同步已覆盖交互路径，此命令供生态/自检显式设置。
function dispatchSetCwd(req: CommandRequest): void {
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
  setSessionCwd(currentInstanceId, raw);
  writeResult(req.id, { ok: true, kind: 'cwd', cwd: raw }, inst);
}

// kill 协议支持 { cmd: 'kill', opts: { pid } }，也兼容 "kill 1234" 字符串形式。
// 解析逻辑在 host-route.ts（P1-4）。
function parsePid(req: CommandRequest): number {
  return parseKillPid(req.cmd, req.opts?.pid);
}

// ─── 轮询循环：文件 RPC 通道 ───
// 保持原有的 cmd.json → result-<id>.json 轮询协议，仅把处理逻辑结构化。
let processedId = -1;
let busy = false;
// P5-15 / M3：当前前台 run 的 node 子进程 pid 按实例登记（interrupt 协议用；缺省 default 键
// = 现状单值全等）。spawnChild 启动时 register、settle 时 clearIf（只清自己启动的）。
// 后台 spawn / Lifo 混合链 / 纯 Lifo 命令不在此列——后台服务不应被 Ctrl+C 误杀，
// Lifo 沙箱无 abort API（host 侧 busy 期间 interrupt 也进不来）。
const currentRunByInstance = new CurrentRunRegistry();

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
