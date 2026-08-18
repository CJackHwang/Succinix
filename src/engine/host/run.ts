// host run 域（O3 拆分）：统一路由（node|npm|npx → 真 Node；python → daemon；其余 → Lifo）。
import fs from 'node:fs';
import { hasShellMetaToken, hasUnsupportedHereDocument, tryTokenize } from '../tokenize.js';
import { WORKSPACE_MOUNT, browserPathToLifoCwd, canonicalizeVirtualPath, classifyPrefix, classifyRoute, lifoCwdToSessionCwd, capOutput, instanceStateRootFor, instanceStateFile } from '../host-route.js';
import { getSessionCwd, setSessionCwd, persistedEnv } from './config.js';
import { writeResult, instanceOf, type CommandRequest } from './rpc.js';
import type { RpcRequestId } from '../rpc-v2.js';
import type { ITerminal } from '@lifo-sh/core';
import { TerminalHub } from '../terminal-hub.js';
import { registerRealBinaryCommands } from './real-binaries.js';
import { runPython } from './run-python.js';
import { applyUserlandRegistryToSandbox, createSandboxUserlandRegistry } from './userland.js';
import { USERLAND_REGISTRY_PATH, parseUserlandRegistrySnapshot } from '../../userland/index.js';
import { restoreServiceEnablement } from './service-world.js';
import { LifoProcessProjection } from './process-world.js';
import type { ProcInfo, KillResult } from '../host-procs.js';
import { killProjectedLifoProcess, listProjectedLifoProcesses } from './process-commands.js';
import { attachTerminalContext, detachTerminalContext } from './terminal-context.js';
import { clearTerminalDimensions } from './terminal-dimensions.js';
import { mountPersistentLifoState, persistentLifoMounts, type PersistentLifoMounts } from './state-mounts.js';
import { installPackageManifestTracking, reconcileRegisteredUserlandPackages } from './package-world.js';
import { requestBrowserControl } from './control.js';
import { runNode } from './node-runner.js';
// Lifo 命令默认超时（与 node 子进程的 NODE_TIMEOUT_MS 分开：纯 Lifo 命令一般秒级完成）。
const LIFO_TIMEOUT_MS = 25000;

// Lifo 内核懒加载：静态载入约 1MB 会让首个 ping 额外约 640ms。
// host 保持轻量，首次 Lifo 请求动态 import；150ms 后只预热 default。
// 协议不变，只把内核成本推迟到需要时。
type LifoSandbox = Awaited<ReturnType<typeof import('../lifo-core.js').Sandbox.create>>;

/** All mutable Lifo state lives in this map, never in a page-global sandbox.
 * A Sandbox owns its command registry, cwd, shell history/jobs, package and
 * service registries; isolating it is therefore the per-instance boundary. */
export interface SandboxContext {
  instanceId: string;
  sandbox: LifoSandbox;
  terminal: TerminalHub;
  createdAt: number;
  releaseUserland?: () => void;
  userlandSignature?: string;
  terminalSessionId?: string;
}

const sandboxContexts = new Map<string, Promise<SandboxContext>>();
const lifoRunControllers = new Map<string, AbortController>();
const sandboxRunLocks = new Map<string, Promise<void>>();
const contextStateSignatures = new Map<string, string>();
const lifoProcesses = new LifoProcessProjection();

function instanceInitialCwd(instanceId: string): string {
  const saved = getSessionCwd(instanceId);
  if (saved.startsWith(WORKSPACE_MOUNT)) return saved;
  return instanceId === 'default' ? WORKSPACE_MOUNT : browserPathToLifoCwd(`/workspace/.succinix-${instanceId}`);
}

function rewriteDirectShellScript(command: string, sandbox: LifoSandbox): string {
  const parsed = tryTokenize(command);
  if (!parsed.ok || hasShellMetaToken(parsed.tokens)) return command;
  const [requested] = parsed.tokens;
  if (!requested || (!requested.startsWith('./') && !requested.startsWith('../') && !requested.startsWith('/'))) return command;
  let file: string;
  try { file = canonicalizeVirtualPath(requested.startsWith('/') ? requested : `${sandbox.cwd}/${requested}`); } catch { return command; }
  if (!sandbox.kernel.vfs.exists(file)) return command;
  try {
    if (!requested.endsWith('.sh') && !sandbox.kernel.vfs.readFileString(file).startsWith('#!')) return command;
  } catch {
    return command;
  }
  const quoted = parsed.tokens.map((token) => `'${token.replaceAll("'", "'\\''")}'`).join(' ');
  return `sh ${quoted}`;
}

function prepareInstanceMounts(instanceId: string): { workspace: string; tmp: string; home: string; persistent: PersistentLifoMounts } {
  const workspace = process.cwd();
  const stateRoot = instanceStateRootFor(instanceId, workspace);
  const tmp = `${stateRoot}/tmp`;
  const home = `${stateRoot}/home/guest`;
  // These directories are execution-world state.  Creating them before the
  // native mounts makes the first Sandbox boot deterministic for a fresh
  // instance and keeps /tmp and /home/guest from being shared accidentally.
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(`${workspace}/workspace`, { recursive: true });
  return { workspace, tmp, home, persistent: persistentLifoMounts(instanceId, workspace) };
}

async function syncContextState(instanceId: string, context: SandboxContext): Promise<void> {
  const cwd = lifoCwdToSessionCwd(context.sandbox.cwd);
  if (cwd !== null && cwd !== getSessionCwd(instanceId)) setSessionCwd(instanceId, cwd);
  const env = context.sandbox.env;
  const entries = Object.entries(env)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/(?:TOKEN|PASSWORD|SECRET|AUTH|PRIVATE_KEY)/i.test(key) && typeof value === 'string')
    .sort(([a], [b]) => a.localeCompare(b));
  const signature = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  const previousSignature = contextStateSignatures.get(instanceId);
  if (previousSignature === signature) return;
  contextStateSignatures.set(instanceId, signature);
  try {
    const file = instanceStateFile(instanceId, process.cwd(), 'etc/succinix.env');
    fs.mkdirSync(`${file.slice(0, file.lastIndexOf('/'))}`, { recursive: true });
    fs.writeFileSync(file, `${signature}${signature ? '\n' : ''}`);
  } catch {
    // Environment persistence is best effort; the live Sandbox remains the
    // source of truth for the current shell.
  }
  // The browser owns binary snapshot export. Mirror only a changed, existing
  // context into its WebContainer fs before callers can request a snapshot.
  // The fixed control action accepts no path and cannot execute shell input.
  if (previousSignature !== undefined) {
    try {
      await requestBrowserControl('environment', instanceId, { timeoutMs: 2_000, args: { content: `${signature}${signature ? '\n' : ''}` } });
    } catch {
      // During early host prewarm the browser bridge is not attached yet; the
      // native mount remains the live execution-world source of truth.
    }
  }
}

function cleanupSandbox(context: SandboxContext): void {
  const { sandbox, terminal, releaseUserland } = context;
  try {
    for (const job of sandbox.shell.getJobTable().list()) job.abortController.abort();
  } catch { /* older Lifo builds may not expose job internals */ }
  try {
    for (const process of sandbox.kernel.processRegistry.getRunning()) {
      sandbox.kernel.processRegistry.kill(process.pid, 'SIGKILL');
    }
  } catch { /* best effort during host teardown */ }
  try {
    for (const unit of sandbox.kernel.serviceManager?.listUnits() ?? []) {
      if (unit.active === 'active' || unit.active === 'activating') void sandbox.kernel.serviceManager?.stop(unit.name);
    }
  } catch { /* service cleanup is best effort */ }
  try {
    releaseUserland?.();
  } catch { /* userland registry teardown is best effort */ }
  terminal.dispose();
  // Lifo 0.10.10 只公开 destroy()；前述显式清理补足其未覆盖的运行项。
  sandbox.destroy();
}

/** 从运行时邮箱装载浏览器插件声明；损坏的声明不会替换已工作的注册表。 */
function currentSandboxUserland(): { registry: ReturnType<typeof createSandboxUserlandRegistry>; signature: string } {
  const file = `${process.cwd()}${USERLAND_REGISTRY_PATH}`;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.length > 1024 * 1024) throw new Error('userland registry exceeds 1 MiB');
    const snapshot = parseUserlandRegistrySnapshot(JSON.parse(raw));
    if (!snapshot) throw new Error('invalid userland registry snapshot');
    return { registry: createSandboxUserlandRegistry(snapshot), signature: raw };
  } catch (error) {
    if (error instanceof Error && /ENOENT/i.test(error.message)) {
      return { registry: createSandboxUserlandRegistry(), signature: 'builtin' };
    }
    throw error;
  }
}

/** 复用同一 Lifo 命令、VFS 与 ServiceManager 热更新结构化 Userland 声明。 */
async function syncSandboxUserland(context: SandboxContext): Promise<void> {
  const next = currentSandboxUserland();
  if (context.userlandSignature === next.signature) return;
  const previousRelease = context.releaseUserland;
  await reconcileRegisteredUserlandPackages(context.sandbox, next.registry.listPackages());
  try {
    previousRelease?.();
  } catch {
    // 老 Sandbox 在销毁边界可能已没有 shell registry；继续安装完整新快照。
  }
  const release = applyUserlandRegistryToSandbox(context.sandbox, next.registry, {
    workingDirectory: context.sandbox.cwd,
  });
  context.releaseUserland = release;
  context.userlandSignature = next.signature;
}

/** Interrupt the foreground Lifo command for one instance.  This is kept
 * separate from the browser terminal transport so batch AbortSignal and
 * Ctrl+C use the same execution-world cancellation primitive. */
export function interruptLifoRun(instanceId: string): boolean {
  const controller = lifoRunControllers.get(instanceId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function sandboxContextCount(): number {
  return sandboxContexts.size;
}

export async function resetSandboxContext(instanceId: string): Promise<void> {
  clearTerminalDimensions(instanceId);
  const context = sandboxContexts.get(instanceId);
  sandboxContexts.delete(instanceId);
  sandboxRunLocks.delete(instanceId);
  contextStateSignatures.delete(instanceId);
  lifoRunControllers.get(instanceId)?.abort();
  lifoRunControllers.delete(instanceId);
  lifoProcesses.forgetInstance(instanceId);
  if (!context) return;
  try {
    const resolved = await context;
    cleanupSandbox(resolved);
  } catch {
    /* A failed/old sandbox must not prevent a fresh instance context. */
  }
}

function getSandboxContext(instanceId: string): Promise<SandboxContext> {
  let context = sandboxContexts.get(instanceId);
  if (!context) {
    // The hub is the stable terminal supplied to Sandbox.create(). Browser
    // devices attach only after the shell has registered its one onData
    // callback; attaching here as well would register it twice.
    const terminal = new TerminalHub();
    const mounts = prepareInstanceMounts(instanceId);
    const cwd = instanceInitialCwd(instanceId);
    context = import('../lifo-core.js')
      .then(async ({ Sandbox, rehydrateGlobalPackages, runGitCommand }) => {
        const sandbox = await Sandbox.create({
          cwd,
          terminal,
          env: { HOME: '/home/guest', USER: 'guest', HOSTNAME: 'succinix', SHELL: '/bin/succinix', PWD: cwd, SUCCINIX_INSTANCE_ID: instanceId, ...persistedEnv(instanceId) },
          mounts: [
            { virtualPath: '/workspace', hostPath: mounts.workspace, fsModule: fs as never },
            { virtualPath: '/tmp', hostPath: mounts.tmp, fsModule: fs as never },
            { virtualPath: '/home/guest', hostPath: mounts.home, fsModule: fs as never },
          ],
        });
        return { sandbox, rehydrateGlobalPackages, runGitCommand };
      })
      .then(async ({ sandbox, rehydrateGlobalPackages, runGitCommand }) => {
        // Sandbox.create applies cwd before native mounts are installed. Set it
        // again after mountNative so instance roots are valid on first boot.
        try { sandbox.cwd = cwd; } catch { /* invalid persisted cwd falls back to mount root */ }
        mountPersistentLifoState(sandbox, mounts.persistent);
        const lifoPackageCommand = await sandbox.shell.getRegistry().resolve('lifo');
        // TASK24 坑 1：node 系命令含 shell 元字符时整条回退给 Lifo shell 执行。Lifo 内置
        // node/npm/npx 是进程内 JS 解释器（报自己的版本号），不是真 node —— 这里注册转发
        // 命令，把 Lifo shell 里的 node/npm/npx 段直启真二进制（cwd/环境与会话 cwd 对齐），
        // stdout/stderr 写进 Lifo 命令上下文流（Lifo shell 已把它们接到管道/重定向）。
        // 递归防护：转发命令直接 spawn 真二进制，不再回 host 分派 → 不会二次回退。
        registerRealBinaryCommands(sandbox, instanceId, {
          runGitCommand,
          projectLifoPid(localPid, name) {
            return lifoProcesses.projectServicePid(instanceId, name ?? `service-${localPid}`, localPid);
          },
        });
        rehydrateGlobalPackages(sandbox.kernel.vfs, sandbox.shell.getRegistry());
        if (!lifoPackageCommand) throw new Error('Lifo package command is unavailable');
        installPackageManifestTracking(sandbox, lifoPackageCommand);
        const resolved: SandboxContext = { instanceId, sandbox, terminal, createdAt: Date.now() };
        await syncSandboxUserland(resolved);
        restoreServiceEnablement(sandbox.kernel.vfs, sandbox.kernel.serviceManager);
        await sandbox.kernel.serviceManager?.bootEnabledServices();
        await syncContextState(instanceId, resolved);
        return resolved;
      })
      .catch((e) => {
        sandboxContexts.delete(instanceId);
        throw e;
      });
    sandboxContexts.set(instanceId, context);
  }
  return context;
}

// Keep the execution-world cwd/env mirror current for interactive shell input
// as well as batch `commands.run()`.  This is intentionally a single host-side
// timer; it never creates browser command state and disappears when the host
// process exits.
setInterval(() => {
  for (const [instanceId, pending] of sandboxContexts) {
    void pending.then(async (context) => {
      await syncSandboxUserland(context);
      await syncContextState(instanceId, context);
    }).catch(() => {});
  }
}, 250);

/** Attach a browser/device terminal to the already-created instance shell.
 * The returned promise is intentionally fire-and-forget for the host mailbox
 * scanner; input frames are queued by the transport until the shell exists. */
export function attachRpcTerminal(instanceId: string, terminal: ITerminal): void {
  void getSandboxContext(instanceId)
    .then(() => attachTerminalContext(sandboxContexts, instanceId, terminal))
    .catch((error) => {
      // 终端设备连接失败不能终止 RPC daemon；批处理命令仍可返回结构化 Lifo 错误。
      console.error('[succinix host] terminal attach failed:', error);
    });
}

export const detachRpcTerminal = (instanceId: string, terminal?: ITerminal): Promise<void> =>
  detachTerminalContext(sandboxContexts, instanceId, terminal);

/** Return the Lifo process view for one instance, or all live instances for
 * the legacy default `ps` view. Failed/tearing-down contexts are skipped. */
export const listLifoProcesses = (instanceId: string, includeAll = instanceId === 'default'): Promise<ProcInfo[]> =>
  listProjectedLifoProcesses(sandboxContexts, lifoProcesses, instanceId, includeAll);

/** Kill a projected Lifo PID. Returns null when the PID belongs to a real
 * host child process, allowing the caller to fall through to host-procs. */
export const killLifoProcess = (
  publicPid: number,
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
): Promise<KillResult | null> => killProjectedLifoProcess(sandboxContexts, lifoProcesses, publicPid, signal);

// 延迟预热：host 模块加载完成 + 首批 ping 响应后启动内核加载（见上注释）。
// 预热失败（lifo-core.js 可能还在注入中）时静默，首个 Lifo 命令会重试。
setTimeout(() => {
  // Only warm the default instance. Other instances are created lazily so a
  // page embedding many instances does not allocate unused shell state.
  void getSandboxContext('default').catch(() => {});
}, 150);

// 统一路由：node|npm|npx → spawn 真 Node；其余 → lifo sandbox。
// TASK24 坑 1：node 系命令含 shell 元字符（&& / | / > / 2>&1 ...）时，整条命令回退给
// Lifo shell 执行 —— Lifo 的 shell 层解析管道/重定向/链，各 node 段经 registerRealBinaryCommands
// 转回真 node/npm/npx（见 getSandbox）。结果 runtime 仍标 'lifo'（shell 层执行），文档注明。
// 纯 node 命令（无元字符）行为不变（直启子进程）。路由判定抽到 host-route.ts（P1-4）。
export async function dispatchRun(req: CommandRequest): Promise<void> {
  const command = String(req.opts?.command ?? '').trim();
  if (!command) {
    writeResult(req.id, { ok: false, exitCode: -1, stdout: '', stderr: 'empty command', runtime: 'lifo' });
    return;
  }
  const inst = instanceOf(req);
  if (hasUnsupportedHereDocument(command)) {
    writeResult(req.id, {
      ok: false,
      exitCode: 2,
      stdout: '',
      stderr: 'succinix: here-document: unsupported\n',
      runtime: 'lifo',
    }, inst);
    return;
  }
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
      await runNode(command, req.opts, req.id, inst);
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

// Lifo sandbox：Unix 工具（grep / cat / wc / echo / curl ...）。结果带 runtime: 'lifo'。
// TASK23：cd 成功后把会话 cwd 同步到 Lifo 新 cwd（仅 /workspace 下 —— 映射 host 真实路径），
// 并持久化 /etc/succinix.cwd；cd 到不存在目录 → Lifo 报错（exit≠0），会话 cwd 不变。
async function runLifo(command: string, opts: Record<string, unknown> | undefined, reqId: RpcRequestId, instanceId: string): Promise<void> {
  // 显式 cwd 只用于单次 dsh/SDK 请求；常规交互/批处理不传 cwd。
  // Lifo 对含 cwd 的执行会在 finally 恢复原目录；每次传入会使跨命令 cd 失效。
  // 因此用 sandbox 当前 cwd 保持会话语义。
  const explicitCwd = opts?.cwd;
  if (explicitCwd !== undefined && (typeof explicitCwd !== 'string' || !explicitCwd.startsWith('/'))) {
    writeResult(reqId, { ok: false, exitCode: 1, stdout: '', stderr: 'cwd must be an absolute path', runtime: 'lifo' }, instanceId);
    return;
  }
  let controller: AbortController | undefined;
  try {
    const timeout = typeof opts?.timeout === 'number' ? opts.timeout : LIFO_TIMEOUT_MS;
    // 首次使用才 await sandbox 初始化（懒加载兜底；延迟预热通常已让内核就绪）。
    const context = await getSandboxContext(instanceId);
    await syncSandboxUserland(context);
    const sandbox = context.sandbox;
    const envOverride: Record<string, string> = {};
    if (opts?.env && typeof opts.env === 'object' && !Array.isArray(opts.env)) {
      for (const [key, value] of Object.entries(opts.env as Record<string, unknown>)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined && value !== null) envOverride[key] = String(value);
      }
    }
    const previous = sandboxRunLocks.get(instanceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lock = previous.then(() => gate);
    sandboxRunLocks.set(instanceId, lock);
    await previous;
    let r: { exitCode: number; stdout: string; stderr: string };
    try {
      r = await context.terminal.runBatch(async () => {
        controller = new AbortController();
        lifoRunControllers.set(instanceId, controller);
        return sandbox.commands.run(rewriteDirectShellScript(command, sandbox), {
          ...(explicitCwd !== undefined ? { cwd: explicitCwd } : {}),
          ...(Object.keys(envOverride).length ? { env: envOverride } : {}),
          timeout,
          signal: controller.signal,
        });
      }, timeout);
    } finally {
      release();
      if (sandboxRunLocks.get(instanceId) === lock) sandboxRunLocks.delete(instanceId);
    }
    const payload: Record<string, unknown> = {
      ok: r.exitCode === 0,
      exitCode: r.exitCode,
      // TASK18 输出上限：Lifo 结果同样截断，保证结果文件有界。
      stdout: capOutput(r.stdout),
      stderr: capOutput(r.stderr),
      runtime: 'lifo',
    };
    if (r.exitCode === 0) {
      const effectiveLifoCwd = sandbox.cwd;
      // cd 后 Lifo cwd → 会话 cwd（TASK23 同步；`cd /` 映射到工作区根 /workspace —— 否则
      // isUnderWorkspace('/') 为 false、会话 cwd 不更新，"回到根目录"不可达。决策见 host-route.ts）。
      const effectiveCwd = lifoCwdToSessionCwd(effectiveLifoCwd);
      if (effectiveCwd !== null) {
        setSessionCwd(instanceId, effectiveCwd);
        // 结果带会话 cwd 字段（新增可选协议字段，向后兼容）。
        payload.cwd = effectiveCwd;
      }
      await syncContextState(instanceId, context);
    }
    writeResult(reqId, payload, instanceId);
  } catch (e) {
    const aborted = controller?.signal.aborted ?? false;
    writeResult(reqId, { ok: false, exitCode: aborted ? 130 : -1, stdout: '', stderr: aborted ? 'command aborted' : String(e).slice(0, 200), runtime: 'lifo' }, instanceId);
  } finally {
    if (controller && lifoRunControllers.get(instanceId) === controller) lifoRunControllers.delete(instanceId);
  }
}
