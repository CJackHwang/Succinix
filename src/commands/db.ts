// db 命令域：tinbase 安装 / 启动 / 状态 / 停止（O1 拆分）。
import type { FileSystemAPI } from '@webcontainer/api';
import { getSetting } from '../config.js';
import { DEFAULT_INSTANCE_ID, instanceStateRoot, tinbaseDataDir } from '../instance/paths.js';
import { instancePorts } from '../instance/ports.js';
import { dbActivePortFor, setDbActivePort, clearDbActivePorts } from '../services.js';
import { AMBER, RED, RESET } from '../theme.js';
import { sleep } from '../util.js';
import type { CommandContext } from './types.js';
const DB_PORT_DEFAULT = 3001;
const DB_PKG = 'tinbase';

// M4：进程归属过滤（db 的进程匹配与 service 一致）。
function procBelongsToCtxInstance(proc: Record<string, unknown>, instanceId?: string): boolean {
  const scope = String(proc.scope ?? '');
  const containerId = proc.containerId !== undefined ? String(proc.containerId) : undefined;
  if (instanceId === undefined || instanceId === DEFAULT_INSTANCE_ID) {
    return !(containerId !== undefined && containerId.startsWith('.succinix-'));
  }
  return scope === 'system' || containerId === `.succinix-${instanceId}` || containerId === instanceId;
}

async function findRunningProcForInstance(ctx: CommandContext, needle: string): Promise<Record<string, unknown> | undefined> {
  const ps = await ctx.client.terminal('ps');
  const procs = Array.isArray(ps.processes) ? ps.processes : [];
  return procs.find(
    (p) => String(p.cmd ?? '').includes(needle) && p.status === 'running' && procBelongsToCtxInstance(p, ctx.instanceId)
  );
}

// db 端口：读 settings preview-port（M4 按实例 settings），缺省 3001；值被手改非法时回落默认。
async function resolveDbPort(fs: FileSystemAPI, instanceId = DEFAULT_INSTANCE_ID, statePrefix?: string): Promise<number> {
  const raw = await getSetting(fs, 'preview-port', instanceId, statePrefix);
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DB_PORT_DEFAULT;
}

// db start：容器内按需安装 tinbase，然后 spawn 后台启动，等待端口就绪。
export async function dbStart(ctx: CommandContext): Promise<void> {
  const { client, term, wc } = ctx;
  const inst = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  const port = await resolveDbPort(wc.fs, inst, ctx.statePrefix);
  setDbActivePort(inst, port); // 记录本次启动端口（M1：status/stop 用记录值；D3 按实例清理）
  const view = instancePorts.portsFor(inst, ctx.ports);
  term.writeln('Checking whether tinbase is installed in the container...');

  // P2-9：dbStart 四路失败输出收敛 —— "failed to start (engine wasm): <why>" 骨架只留一处。
  // 各失败路径差异只在 why 文案；输出与旧实现逐字节一致。
  const fail = (why: string): void => term.writeln(`${RED}tinbase: failed to start (engine wasm): ${why}${RESET}`);

  // 1. 检查 /workspace/node_modules/tinbase 是否存在（test -d：不存在时 exit≠0，比 ls+stdout 包含判断可靠，
  //    避免 Lifo 把 "No such file or directory" 打到 stdout 造成误判重复 npm install）
  //    N1（TASK20）：绝对路径 —— npm install 装进 process.cwd()（/workspace）下的 node_modules，
  //    相对路径 `test -d node_modules/tinbase` 被 Lifo 按 VFS 根解析恒判缺失，每次误报重复安装。
  let installed = false;
  try {
    const r = await client.terminal('test -d /workspace/node_modules/tinbase', undefined, 15000);
    installed = r.ok === true;
  } catch {
    installed = false;
  }

  if (!installed) {
    term.writeln('not installed -> npm install tinbase --no-audit --no-fund (real node route, may take 30-90s)...');
    try {
      const r = await client.terminal('npm install tinbase --no-audit --no-fund', { timeout: 120000 }, 150000);
      if (!r.ok) {
        const why = r.stderr || r.stdout || r.error || 'npm install exited non-zero';
        term.writeln(`${RED}tinbase: install failed: ${String(why).slice(0, 300)}${RESET}`);
        fail('install failed, check container network.');
        return;
      }
    } catch (e) {
      term.writeln(`${RED}tinbase: install failed: ${String(e)}${RESET}`);
      fail('install failed, check container network.');
      return;
    }
    term.writeln('tinbase installed');
  }

  // 2. 已在运行则直接报告：端口就绪 + 进程表有 tinbase running 进程，交叉验证防占端口误报
  //    （端口被其他进程占用时不再误报 "tinbase is already running"）。
  if (view.has(port)) {
    let running: Record<string, unknown> | undefined;
    try {
      running = await findRunningProcForInstance(ctx, DB_PKG);
    } catch {
      running = undefined; // 进程表不可达：按无 tinbase 进程处理
    }
    if (running) {
      term.writeln(`tinbase is already running: ${view.get(port)}`);
      return;
    }
    term.writeln(`${AMBER}Port ${port} is in the ready list but no tinbase process is running; another process may own it.${RESET}`);
    term.writeln('Attempting to start tinbase anyway (it will fail fast if the port is truly taken)...');
  }

  // 2b. 同页端口冲突拒绝（M4）：端口已被其他实例期望 → 明确拒绝并提示，不抢占。
  const conflict = instancePorts.hasConflict(inst, port);
  if (conflict !== null) {
    term.writeln(`${RED}tinbase: failed to start (engine wasm): port ${port} is already used by instance '${conflict}'${RESET}`);
    return;
  }

  // 3. spawn 后台启动（端口取 settings preview-port，缺省 3001）
  //    --engine wasm: WebContainer 无原生二进制，必须 PGlite/WASM 引擎；
  //    去 --memory：data-dir 落容器 FS，随快照持久化（TASK5）。
  //    M4：非默认实例显式 --data-dir <stateRoot>/tinbase，实例间数据隔离
  //    （缺省实例不传 flag = 现状 /workspace/.tinbase，行为全等）。
  // D6：data-dir 与状态文件同口径 —— 自定义 statePrefix 下数据库目录落在
  // <prefix><id>/tinbase（缺省前缀 = 现状 /workspace/.succinix-<id>/tinbase 全等）。
  const stateRoot = instanceStateRoot(inst, ctx.statePrefix);
  const dataDir = stateRoot ? tinbaseDataDir(inst, ctx.statePrefix) : null;
  // M5：data-dir 是浏览器视角绝对路径（wc.fs /workspace/.succinix-<id>/tinbase），
  // host 侧按浏览器视角映射到 process.cwd() 下（mapDataDirArgs）；spawn 前先由浏览器
  // 建好目录，避免状态根刚被 reboot 清空后父目录缺失（tinbase 只建叶子目录）。
  if (dataDir) {
    try {
      await wc.fs.mkdir(dataDir, { recursive: true });
    } catch (e) {
      term.writeln(`${RED}tinbase: data dir prepare failed: ${String(e).slice(0, 160)}${RESET}`);
    }
  }
  const startCmd = `npx tinbase start --port ${port} --engine wasm${dataDir ? ` --data-dir ${dataDir}` : ''}`;
  term.writeln(`Starting ${startCmd} (background process)...`);
  let pid: number | undefined;
  try {
    const r = await client.spawn(startCmd, undefined, 8000);
    if (!r.ok || !r.pid) {
      fail(r.error || r.stderr || 'spawn returned failure');
      fail('check container compatibility.');
      return;
    }
    pid = r.pid;
    instancePorts.expect(inst, port); // M4：登记实例期望端口（server-ready 归到该实例视图）
    term.writeln(`started in background (pid=${pid}); waiting for port ${port} to be ready...`);
  } catch (e) {
    fail(String(e));
    fail('check container network/compatibility.');
    return;
  }

  // 4. 等待 server-ready 事件（boot.ts 的处理器会打印暗橙 [preview] 行）。
  //    顺带检查进程表：pid 已 exited 则提前报失败（配合 host 的 spawn error 改写，
  //    立即看到原因而非等满 30s 端口超时）。
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const url = instancePorts.portsFor(inst, ctx.ports).get(port);
    if (url) {
      term.writeln(`${AMBER}Database ready: ${url}${RESET}`);
      term.writeln(`Open ${url} in the browser, or curl ${url} through Lifo.`);
      term.writeln('Database data persists across db restart in the workspace (.tinbase).');
      term.writeln('Browser refresh recreates the wasm store (binary db files are not snapshotted).');
      return;
    }
    if (pid) {
      try {
        const ps = await client.terminal('ps');
        const procs = Array.isArray(ps.processes) ? ps.processes : [];
        const proc = procs.find((p) => Number(p.pid) === pid);
        if (proc && proc.status === 'exited') {
          fail(`process exited (pid=${pid}) before port ${port} became ready.`);
          term.writeln(`${RED}Run 'db status' to inspect the process output tail, then 'db stop' and retry.${RESET}`);
          return;
        }
      } catch {
        /* 进程表查询失败不阻断等待，继续轮询 */
      }
    }
    await sleep(500);
  }
  fail(`port ${port} not ready within 30s.`);
  fail('WebContainer may not run WASM servers. Run db stop and retry, or use an external service.');
}

export async function dbStatus(ctx: CommandContext): Promise<void> {
  const { client, term, wc } = ctx;
  const inst = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  const port = dbActivePortFor(inst) ?? (await resolveDbPort(wc.fs, inst, ctx.statePrefix));
  const view = instancePorts.portsFor(inst, ctx.ports);
  const url = view.get(port);
  term.writeln(url ? `Port ${port}: in ready list -> ${url}` : `Port ${port}: not in ready list (not running)`);

  let procs: Array<Record<string, unknown>> = [];
  try {
    const ps = await client.terminal('ps');
    procs = Array.isArray(ps.processes) ? ps.processes : [];
  } catch (e) {
    term.writeln(`${RED}failed to query process table: ${String(e)}${RESET}`);
    return;
  }
  const tinbase = procs.filter((p) => String(p.cmd ?? '').includes(DB_PKG) && procBelongsToCtxInstance(p, ctx.instanceId));
  if (tinbase.length === 0) {
    term.writeln('process table: no tinbase process');
  } else {
    for (const p of tinbase) {
      term.writeln(`process table: pid=${p.pid} "${p.cmd}" [${p.status}]`);
    }
  }
}

export async function dbStop(ctx: CommandContext): Promise<void> {
  const { term, wc } = ctx;
  const inst = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  let proc: Record<string, unknown> | undefined;
  try {
    proc = await findRunningProcForInstance(ctx, DB_PKG);
  } catch (e) {
    term.writeln(`${RED}failed to query process table: ${String(e)}${RESET}`);
    return;
  }
  if (!proc) {
    term.writeln('no running tinbase process');
    return;
  }
  const pid = Number(proc.pid);
  const k = await ctx.client.terminal(`kill ${pid}`);
  if (k.ok && k.killed) {
    term.writeln(`tinbase stopped (pid=${pid}); database data persisted in workspace (.tinbase)`);
    // 用记录端口清理注册表（运行中改 settings 不影响 stop 的正确端口）
    const port = dbActivePortFor(inst) ?? (await resolveDbPort(wc.fs, inst, ctx.statePrefix));
    instancePorts.release(inst, port); // M4：释放实例期望端口
    if (inst === DEFAULT_INSTANCE_ID) ctx.ports.delete(port); // 默认实例清理页面级注册表（现状）
    clearDbActivePorts(inst);
  } else {
    term.writeln(`${RED}failed to stop: ${k.message ?? 'unknown reason'}${RESET}`);
  }
}
