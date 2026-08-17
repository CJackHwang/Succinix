// 服务生命周期（O8 拆分自 services.ts）：状态判定 / 启动（含 npx 缺包安装与端口就绪等待）/
// 停止（kill + 有界退出等待）。
import { log } from '../log.js';
import { sleep } from '../util.js';
import { DEFAULT_INSTANCE_ID } from '../instance/paths.js';
import { instancePorts } from '../instance/ports.js';
import { readServices } from './io.js';
import { activePortsFor } from './registry.js';
import { portsView, renderCommand, resolvePreviewPort } from './ports.js';
import type { ServiceContext, ServiceDef, ServiceState, ServiceActionResult } from './types.js';

const PORT_WAIT_MS = 30000;
// 停止服务：SIGTERM 后等待进程退出；host 侧 forceAfterMs 同时会在宽限期后升级 SIGKILL。
const EXIT_WAIT_MS = 10000;
const EXIT_WAIT_BUFFER_MS = 5000;

// TASK19：npx 服务缺包安装 —— node_modules 不随快照持久，刷新/重开容器后 npx <pkg> 的包必然缺失。
// 若服务命令以 npx 开头且 /workspace/node_modules/<pkg> 不存在，先真实 npm install（与 dbStart 的安装路径一致），
// 再 spawn —— 否则 autostart 里 npx 的即时下载会跟 30s 端口等待竞态，时好时坏。
// N1（TASK20）：探测必须用绝对路径 —— `test -d node_modules/<pkg>` 相对路径被 Lifo 按 VFS 根解析，
// 而 npm install 装进 process.cwd()（即 /workspace）下的 node_modules，恒判缺失 → 每次冗余 npm install + 虚假 WARN。
async function ensureNpxPackage(ctx: ServiceContext, command: string): Promise<void> {
  const m = /^npx\s+(\S+)/.exec(command.trim());
  if (!m) return;
  const pkg = m[1];
  const rel = `/workspace/node_modules/${pkg}`;
  try {
    const probe = await ctx.client.terminal(`test -d '${rel}'`, undefined, 15000);
    if (probe.ok) return; // 已安装
  } catch {
    /* 探测失败：按缺失处理，尝试安装 */
  }
  void log('WARN', `service install: ${pkg} missing, running npm install before spawn`);
  const inst = await ctx.client.terminal(`npm install ${pkg} --no-audit --no-fund`, { timeout: 120000 }, 150000);
  if (!inst.ok) {
    void log('WARN', `service install failed: ${pkg} (${String(inst.stderr || inst.error || 'npm install failed').slice(0, 160)})`);
  }
}

// ─── 状态与生命周期 ───

// 命令签名：去掉引号、折叠空白 —— host 分词建 cmd 时剥离包裹引号，两边归一后才能可靠 includes 匹配。
function commandSignature(s: string): string {
  return s.replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

// 匹配用命令渲染：会话内启动记录值优先（M1 残余修复，TASK18 / M4 按实例）。
// 运行中改 preview-port 后，正在运行的服务实际命令行仍是启动时的端口（如 --port 3001）；
// 若用当前 preview-port 渲染 needle（--port 3002），findServiceProcess 会匹配不到进程，
// status 误判 stopped。有记录时用记录值渲染 needle；无记录回落动态渲染。
async function renderCommandForMatch(ctx: ServiceContext, def: ServiceDef): Promise<string> {
  const recorded = activePortsFor(ctx.instanceId ?? DEFAULT_INSTANCE_ID).get(def.name);
  if (recorded !== undefined && def.command.includes('${PORT}')) {
    return def.command.replace(/\$\{PORT\}/g, String(recorded));
  }
  return renderCommand(ctx.wc.fs, def, ctx.instanceId, ctx.statePrefix);
}

// M4：服务进程归属判定（导出供单测）。默认实例 = 排除其他实例状态根（.succinix-*）下的
// 进程（组织性隔离），其余照旧（unknown/system 均参与匹配，现状行为）；非默认实例 =
// 只匹配自己状态根（.succinix-<id>）/ CISOL 同 id / system 进程。
export function processBelongsToInstance(
  proc: { scope?: unknown; containerId?: unknown },
  instanceId: string
): boolean {
  const scope = String(proc.scope ?? '');
  const containerId = proc.containerId !== undefined ? String(proc.containerId) : undefined;
  if (instanceId === DEFAULT_INSTANCE_ID) {
    return !(containerId !== undefined && containerId.startsWith('.succinix-'));
  }
  return scope === 'system' || containerId === `.succinix-${instanceId}` || containerId === instanceId;
}

// 进程表里匹配该服务（渲染后命令）且 running、且归属本实例的进程。
async function findServiceProcess(ctx: ServiceContext, def: ServiceDef): Promise<{ pid: number; cmd: string } | undefined> {
  const needle = commandSignature(await renderCommandForMatch(ctx, def));
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  let procs: Array<Record<string, unknown>> = [];
  try {
    const ps = await ctx.client.terminal('ps');
    procs = Array.isArray(ps.processes) ? ps.processes : [];
  } catch {
    return undefined; // 进程表不可达：按无匹配处理
  }
  const found = procs.find(
    (p) => p.status === 'running' && processBelongsToInstance(p, instanceId) && commandSignature(String(p.cmd ?? '')).includes(needle)
  );
  return found ? { pid: Number(found.pid), cmd: String(found.cmd) } : undefined;
}

// 有效端口解析：会话内启动记录值优先（M1：preview-port 改动后服务仍监听启动时端口）；
// 未启动过（或启动时显式 preferRecorded=false）的服务回落动态解析——命令含 ${PORT}
// 占位符时按当前 preview-port，否则 def.port。startService 走 preferRecorded=false：
// 新实例监听的是"当前" preview-port，忽略可能残留的旧记录（服务崩溃后 record 未清场景）。
async function resolveEffectivePort(ctx: ServiceContext, def: ServiceDef, preferRecorded = true): Promise<number | null> {
  if (preferRecorded) {
    const recorded = activePortsFor(ctx.instanceId ?? DEFAULT_INSTANCE_ID).get(def.name);
    if (recorded !== undefined) return recorded;
  }
  return def.command.includes('${PORT}') ? await resolvePreviewPort(ctx.wc.fs, ctx.instanceId, ctx.statePrefix) : def.port;
}

// 状态判定：running 需进程表 running 且（有端口时）端口注册表就绪。
// 端口取"有效端口"（resolveEffectivePort）——preview-port 改动后服务实际监听新端口，
// 若用静态 def.port 判定会失真（新端口就绪却报 stopped / 旧端口展示与 URL 矛盾）。
export async function getServiceState(ctx: ServiceContext, def: ServiceDef): Promise<ServiceState> {
  const effectivePort = await resolveEffectivePort(ctx, def);
  const proc = await findServiceProcess(ctx, def);
  const view = portsView(ctx);
  if (proc) {
    const portOk = effectivePort === null || view.has(effectivePort);
    if (portOk) {
      return {
        def,
        state: 'running',
        pid: proc.pid,
        effectivePort,
        url: effectivePort !== null ? view.get(effectivePort) : undefined,
      };
    }
  }
  return { def, state: 'stopped', effectivePort };
}

export async function listServiceStates(ctx: ServiceContext): Promise<ServiceState[]> {
  const defs = await readServices(ctx.wc.fs, ctx.instanceId, ctx.statePrefix);
  return Promise.all(defs.map((def) => getServiceState(ctx, def)));
}

// 启动服务：同名只允许一个实例（进程表已有 running 进程 → 幂等报告已运行）；
// 有端口则等待端口就绪，进程提前退出 / 超时即失败。
export async function startService(ctx: ServiceContext, name: string): Promise<ServiceActionResult> {
  const defs = await readServices(ctx.wc.fs, ctx.instanceId, ctx.statePrefix);
  const def = defs.find((d) => d.name === name);
  if (!def) {
    void log('WARN', `service start failed: ${name} (unknown service)`);
    return { ok: false, message: `unknown service: ${name}` };
  }

  const existing = await findServiceProcess(ctx, def);
  if (existing) {
    void log('INFO', `service start: ${name} already running (pid=${existing.pid})`);
    return { ok: true, message: `service '${name}' is already running (pid=${existing.pid})`, pid: existing.pid };
  }

  const command = await renderCommand(ctx.wc.fs, def, ctx.instanceId, ctx.statePrefix);
  // TASK19：npx 服务缺包先安装（autostart/start 共用），避免 npx 即时下载与端口等待竞态。
  await ensureNpxPackage(ctx, command);
  // 新实例按当前 preview-port 解析（忽略旧记录），spawn 成功后记录实际端口。
  const effectivePort = await resolveEffectivePort(ctx, def, false);
  // M4：登记实例期望端口必须在 spawn 之前 —— server-ready 事件到达时按期望归属实例视图；
  // 快速绑定的服务（node -e 直启等）若先 spawn 后 expect，事件会落在期望登记之前，
  // 该端口永远不会进入实例视图（service start 误报端口超时）。spawn 失败时释放期望。
  if (effectivePort !== null) instancePorts.expect(ctx.instanceId ?? DEFAULT_INSTANCE_ID, effectivePort);
  let pid: number;
  try {
    const r = await ctx.client.spawn(command, undefined, 8000);
    if (!r.ok || !r.pid) {
      const why = r.error || r.stderr || 'spawn returned failure';
      if (effectivePort !== null) instancePorts.release(ctx.instanceId ?? DEFAULT_INSTANCE_ID, effectivePort);
      void log('WARN', `service start failed: ${name} (${why})`);
      return { ok: false, message: `failed to start '${name}': ${why}` };
    }
    pid = Number(r.pid);
  } catch (e) {
    if (effectivePort !== null) instancePorts.release(ctx.instanceId ?? DEFAULT_INSTANCE_ID, effectivePort);
    void log('WARN', `service start failed: ${name} (${String(e)})`);
    return { ok: false, message: `failed to start '${name}': ${String(e)}` };
  }

  if (effectivePort === null) {
    void log('INFO', `service start: ${name} pid=${pid}`);
    return { ok: true, message: `service '${name}' started (pid=${pid})`, pid };
  }

  // 记录实际端口（M1 / M4 按实例）：preview-port 改动后服务监听的是启动时端口，就绪等待
  // 与后续 status/列表/URL 都用记录值，避免静态 def.port 误报。
  activePortsFor(ctx.instanceId ?? DEFAULT_INSTANCE_ID).set(name, effectivePort);

  // 等端口就绪：进程还在且端口未就绪 → 继续等；进程提前退出 → 立即失败。
  const deadline = Date.now() + PORT_WAIT_MS;
  while (Date.now() < deadline) {
    // 每次循环重新取实例端口视图：非默认实例的 portsFor 返回新 Map 快照，
    // 只在循环前取一次会永远看不到稍后就绪的端口（service start 误报 30s 超时）。
    if (portsView(ctx).has(effectivePort)) {
      void log('INFO', `service start: ${name} pid=${pid} port=${effectivePort}`);
      return { ok: true, message: `service '${name}' started (pid=${pid}, port ${effectivePort})`, pid };
    }
    const alive = await findServiceProcess(ctx, def);
    if (!alive) {
      void log('WARN', `service start failed: ${name} exited before port ${effectivePort} became ready`);
      return { ok: false, message: `service '${name}' exited before port ${effectivePort} became ready`, pid };
    }
    await sleep(500);
  }
  void log('WARN', `service start: ${name} pid=${pid} port ${effectivePort} not ready within ${PORT_WAIT_MS / 1000}s`);
  return {
    ok: false,
    message: `service '${name}' process started (pid=${pid}) but port ${effectivePort} not ready within ${PORT_WAIT_MS / 1000}s`,
    pid,
  };
}

// 停止服务：查进程表 → kill；端口注册表条目由 host 的 port close 事件自动移除（现有逻辑）。
// kill 是异步的：返回前有界等待进程退出，消除 stop 后立即 status 仍看到 running 的竞态。
// 若 SIGTERM 后仍存活，host 会按 forceAfterMs 升级 SIGKILL，stop 只在确认退出后报告成功。
export async function waitForProcessExit(
  client: ServiceContext['client'],
  pid: number,
  timeoutMs = EXIT_WAIT_MS + EXIT_WAIT_BUFFER_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ps = await client.terminal('ps');
      const procs = Array.isArray(ps.processes) ? ps.processes : [];
      if (!procs.some((p) => Number(p.pid) === pid && p.status === 'running')) return true;
    } catch {
      /* 进程表瞬时不可达：继续轮询，不误报 */
    }
    await sleep(100);
  }
  return false;
}

export async function stopService(ctx: ServiceContext, name: string): Promise<ServiceActionResult> {
  const defs = await readServices(ctx.wc.fs, ctx.instanceId, ctx.statePrefix);
  const def = defs.find((d) => d.name === name);
  if (!def) {
    void log('WARN', `service stop failed: ${name} (unknown service)`);
    return { ok: false, message: `unknown service: ${name}` };
  }

  const proc = await findServiceProcess(ctx, def);
  if (!proc) {
    void log('WARN', `service stop: ${name} not running`);
    return { ok: false, message: `service '${name}' is not running` };
  }

  try {
    const k = await ctx.client.terminal(`kill ${proc.pid}`, { forceAfterMs: EXIT_WAIT_MS });
    if (!k.ok || !k.killed) {
      const why = k.message ?? 'unknown reason';
      void log('WARN', `service stop failed: ${name} (${why})`);
      return { ok: false, message: `failed to stop '${name}': ${why}` };
    }
    // 有界等待：SIGTERM（必要时 SIGKILL）已发，确认进程不再 running 才清理注册表。
    if (!(await waitForProcessExit(ctx.client, proc.pid))) {
      void log('WARN', `service stop failed: ${name} (pid ${proc.pid} still running)`);
      return { ok: false, message: `failed to stop '${name}': process ${proc.pid} still running` };
    }
    void log('INFO', `service stop: ${name} pid=${proc.pid}`);
    const inst = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
    const recorded = activePortsFor(inst).get(name);
    if (recorded !== undefined) instancePorts.release(inst, recorded); // M4：释放实例期望端口
    activePortsFor(inst).delete(name); // M1：stop 后清除记录端口，状态回落动态解析
    return { ok: true, message: `service '${name}' stopped (pid=${proc.pid})`, pid: proc.pid };
  } catch (e) {
    void log('WARN', `service stop failed: ${name} (${String(e)})`);
    return { ok: false, message: `failed to stop '${name}': ${String(e)}` };
  }
}

export async function restartService(ctx: ServiceContext, name: string): Promise<ServiceActionResult> {
  const state = await listServiceStates(ctx);
  const existing = state.find((entry) => entry.def.name === name);
  if (!existing) return { ok: false, message: `unknown service: ${name}` };
  if (existing.state === 'running') {
    const stopped = await stopService(ctx, name);
    if (!stopped.ok) return stopped;
  }
  return startService(ctx, name);
}
