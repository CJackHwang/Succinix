// 系统命令域：reboot/shutdown/free/top/cache/version 与内存单位格式化（O1 拆分）。
import { AMBER, RED, GRAY, RESET } from '../theme.js';
import { sleep } from '../util.js';
import { SUCCINIX_VERSION } from '../version.js';
import { DEFAULT_INSTANCE_ID } from '@succinix/engine';
import type { CommandContext } from './types.js';
// M4：reboot 目标判定 —— 非默认实例 = 实例级重置；缺省/默认实例 = 整页刷新（现状）。
export function rebootMode(instanceId: string | undefined): 'instance' | 'page' {
  return instanceId !== undefined && instanceId !== DEFAULT_INSTANCE_ID ? 'instance' : 'page';
}

export const VERSION = `Succinix ${SUCCINIX_VERSION} (browser-native Linux)`;

const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
/** 每个运行中容器进程的粗略内存占用（POC：进程表无 RSS，纯估算，输出以 ~ 前缀注明） */
const PROC_EST_MB = 50;

// 二进制换算：MB/GB 保留 1 位小数，整数尾数 .0 去掉（与 Linux free 观感一致）。
export function fmtUnit(bytes: number, unit: 'MB' | 'GB'): string {
  const v = bytes / (unit === 'GB' ? GIB : MIB);
  const s = v.toFixed(1);
  return `${s.endsWith('.0') ? s.slice(0, -2) : s} ${unit}`;
}

// 本地时间 YYYY-MM-DD HH:MM:SS（top 头部时间戳）。
function fmtDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// free：内存概览（类似 Linux free）。浏览器沙箱拿不到系统级 used/available ——
// used 用 JS heap 真实值 + 容器进程估算，available 为 total - used 估算；
// 估算值一律 ~ 前缀，并脚注诚实标注。
export async function freeCmd(ctx: CommandContext): Promise<void> {
  const { term } = ctx;
  const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  const devMem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;

  // 容器进程估算：进程表各进程无 RSS，按运行中进程数 × 固定基数额估算。
  let procEstBytes = 0;
  try {
    const ps = await ctx.client.terminal('ps');
    const procs = Array.isArray(ps.processes) ? ps.processes : [];
    procEstBytes = procs.filter((p) => p.status === 'running').length * PROC_EST_MB * MIB;
  } catch {
    /* 进程表不可达时估算为 0，输出仍标注 estimated */
  }

  const hasPerf = perfMem !== undefined;
  const hasSys = devMem !== undefined && hasPerf;
  const sysUsedBytes = (perfMem?.usedJSHeapSize ?? 0) + procEstBytes;
  const devMemGB = typeof devMem === 'number' ? devMem : 0;

  const sysTotal = devMem !== undefined ? `${devMem} GB` : '--';
  const sysUsed = hasSys ? `~${fmtUnit(sysUsedBytes, 'GB')}` : '--';
  const sysAvail = hasSys ? `~${fmtUnit(Math.max(0, devMemGB * GIB - sysUsedBytes), 'GB')}` : '--';

  const heapTotal = perfMem ? fmtUnit(perfMem.totalJSHeapSize, 'MB') : '--';
  const heapUsed = perfMem ? fmtUnit(perfMem.usedJSHeapSize, 'MB') : '--';
  const heapAvail = perfMem ? fmtUnit(Math.max(0, perfMem.totalJSHeapSize - perfMem.usedJSHeapSize), 'MB') : '--';

  const col = (s: string) => s.padEnd(13);
  term.writeln('              total        used         available');
  term.writeln('Memory'.padEnd(14) + col(sysTotal) + col(sysUsed) + col(sysAvail));
  term.writeln('JS heap'.padEnd(14) + col(heapTotal) + col(heapUsed) + col(heapAvail));
  if (hasSys) {
    term.writeln(`${GRAY}(estimated — browser sandbox has no OS-level memory stats)${RESET}`);
  }
  if (devMem === undefined) {
    term.writeln(`${GRAY}(navigator.deviceMemory unavailable — system total shown as --)${RESET}`);
  }
  if (!hasPerf) {
    term.writeln(`${GRAY}(performance.memory unavailable — JS heap values shown as --)${RESET}`);
  }
}

// top：进程表实时视图（复用 ps）。POC 不做交互式常驻 —— 2s 间隔快照 3 次后自动结束。
export async function topCmd(ctx: CommandContext): Promise<void> {
  const { term } = ctx;
  for (let round = 0; round < 3; round++) {
    if (round > 0) await sleep(2000);
    let procs: Array<Record<string, unknown>> = [];
    try {
      const ps = await ctx.client.terminal('ps');
      procs = Array.isArray(ps.processes) ? ps.processes : [];
    } catch (e) {
      term.writeln(`${RED}failed to query process table: ${String(e)}${RESET}`);
      return;
    }
    const plural = procs.length === 1 ? '' : 'es';
    term.writeln(`top — ${fmtDateTime(new Date())}  (${procs.length} process${plural})`);
    term.writeln(`${'PID'.padStart(6)}  ${'STATE'.padEnd(9)}COMMAND`);
    for (const p of procs) {
      const st = String(p.status ?? '');
      const state = st === 'running' ? `${AMBER}${st}${RESET}` : `${GRAY}${st}${RESET}`;
      term.writeln(`${String(p.pid).padStart(6)}  ${state}${' '.repeat(Math.max(0, 9 - st.length))}${String(p.cmd ?? '')}`);
    }
    if (round < 2) term.writeln('');
  }
}

// reboot：重启系统 = 重建容器释放内存。最简单可靠的方式是 location.reload()——
// 浏览器释放旧容器全部内存，重新 boot；持久化在 IndexedDB（浏览器侧），reload 保留。
export function rebootCmd(ctx: CommandContext): void {
  const { term } = ctx;
  // M4：多实例模式 reboot = 实例级重置（清该实例状态 + 重 boot，不刷新宿主页面）。
  // 同页宿主注入 onInstanceReset（M5 的 SuccinixInstance.restart）；demo 单页单实例路径
  // 缺省回落整页刷新（该 Tab 即该实例，刷新 = 实例级重置）。
  if (rebootMode(ctx.instanceId) === 'instance') {
    term.writeln(`Rebooting instance '${ctx.instanceId}'...`);
    void (ctx.onInstanceReset ? ctx.onInstanceReset() : location.reload());
    return;
  }
  term.writeln('Rebooting Succinix...');
  setTimeout(() => location.reload(), 300);
}

// shutdown：POC 不真关 tab，输出提示即可。多实例模式 = 停当前实例（不动其他实例）。
export function shutdownCmd(ctx: CommandContext): void {
  const { term } = ctx;
  if (rebootMode(ctx.instanceId) === 'instance') {
    term.writeln(`Stopping instance '${ctx.instanceId}' (other instances keep running). You can close this tab.`);
    void ctx.onInstanceStop?.();
    return;
  }
  term.writeln('Powering off. You can close this tab.');
}

// cache：查看缓存占用（npm cache / 容器 /tmp，走 Lifo du）；cache clear 清理可重建缓存
// （npm 缓存可重建，~/.npm 其余目录保留）。绝不清理 /workspace —— 用户数据不碰。
export async function cacheCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === '') {
    term.writeln('Cache usage (container-side, via Lifo du):');
    try {
      const r = await ctx.client.terminal('du -sh /tmp ~/.npm 2>/dev/null', undefined, 20000);
      const out = String(r.stdout ?? '').trim();
      if (out) term.writeln(out);
      else term.writeln(`${GRAY}cache usage unavailable (--)${RESET}`);
    } catch (e) {
      term.writeln(`${GRAY}cache usage unavailable (--) — ${String(e).slice(0, 120)}${RESET}`);
    }
    return;
  }
  if (sub === 'clear') {
    term.writeln('Clearing rebuildable caches (npm cache, container /tmp)...');
    try {
      const r = await ctx.client.terminal('rm -rf /tmp/* ~/.npm/_cacache 2>/dev/null', undefined, 30000);
      if (r.ok) term.writeln('Cache cleared (npm cache and /tmp are rebuildable).');
      else term.writeln(`${RED}cache clear failed: ${String(r.stderr || r.stdout || r.error || 'rm exited non-zero').slice(0, 200)}${RESET}`);
      term.writeln(`${GRAY}(/workspace untouched — user data is never cleared)${RESET}`);
    } catch (e) {
      term.writeln(`${RED}cache clear failed: ${String(e)}${RESET}`);
    }
    return;
  }
  term.writeln('usage: cache | cache clear');
}
