// host 看门狗：每 30s ping，连续 2 次失败 → executor.respawn 重启 host（O2 拆分）。
import type { TerminalExecutor } from '@succinix/engine';
import type { WebContainer } from '@webcontainer/api';
import { log } from '../log.js';
import { AMBER, RED, RESET } from '../theme.js';
import { term } from './xterm.js';

// ─── host 看门狗（每 30s ping，连续 2 次失败 → executor.respawn 重启 host）───
export function startHostWatchdog(executor: TerminalExecutor, wc: WebContainer): void {
  let consecutiveFailures = 0;
  let probing = false;
  setInterval(async () => {
    if (probing) return;
    probing = true;
    try {
      const p = await executor.pingDirect(30000);
      if (p === true) {
        consecutiveFailures = 0;
        return;
      }
      if (p === false) {
        consecutiveFailures++;
        if (consecutiveFailures >= 2) {
          consecutiveFailures = 0;
          void restartHost(executor, wc);
        }
        return;
      }
      // p === null：通道忙，中性不计。
    } finally {
      probing = false;
    }
  }, 30000);
}

// 重新注入 host.js（容器内缺失时从构建产物拉取）并 respawn，等待就绪。
export async function restartHost(executor: TerminalExecutor, wc: WebContainer): Promise<void> {
  try {
    term.writeln(`${AMBER}[ WARN ] host unresponsive — re-injecting host.js and respawning${RESET}`);
    void log('WARN', 'host unresponsive — re-injecting host.js and respawning');
    try {
      // 确保 host.js / lifo-core.js 存在（缺失时从构建产物拉取；lifo-core 异步写不阻塞重启就绪）。
      try {
        await wc.fs.readFile('/host.js');
      } catch {
        const src = await (await fetch('/host.js')).text();
        await wc.fs.writeFile('/host.js', src);
      }
      try {
        await wc.fs.readFile('/lifo-core.js');
      } catch {
        const src = await (await fetch('/lifo-core.js')).text();
        void wc.fs.writeFile('/lifo-core.js', src).catch(() => {});
      }
    } catch {
      /* 资产注入失败：respawn 内部仍会尝试 */
    }
    await executor.respawn();
    term.writeln(`${AMBER}[  OK  ] host respawned — process table is clean${RESET}`);
    void log('WARN', 'host respawned; process table is fresh');
  } catch (e) {
    term.writeln(`${RED}[ FAIL ] host restart failed: ${String(e)}${RESET}`);
    void log('ERROR', `host restart failed: ${String(e)}`);
  }
}
