// host 看门狗：每 30s ping，连续 2 次失败 → executor.respawn 重启 host（O2 拆分）。
import type { TerminalExecutor } from '@succinix/engine';
import type { WebContainer } from '@webcontainer/api';
import { log } from '../log.js';
import { AMBER, RED, RESET } from '../theme.js';
import { getTerm } from './xterm.js';

export interface WatchdogController {
  stop(): void;
  restartNow(): Promise<void>;
  running(): boolean;
}

const WATCHDOG_INTERVAL_MS = 30000;
const WATCHDOG_MAX_BACKOFF_MS = 30000;

// ─── host 看门狗（每 30s ping，连续 2 次失败 → executor.respawn 重启 host）───
export function startHostWatchdog(executor: TerminalExecutor, wc: WebContainer, onRespawn?: () => Promise<void> | void): WatchdogController {
  let consecutiveFailures = 0;
  let probing = false;
  let stopped = false;
  let restarting: Promise<void> | undefined;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffMs = 1000;
  const isActive = (token: number) => !stopped && token === generation;
  const scheduleRetry = (token: number) => {
    if (!isActive(token)) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, WATCHDOG_MAX_BACKOFF_MS);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (isActive(token)) void restartNow();
    }, delay);
  };
  const restartNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (restarting) return restarting;
    const token = generation;
    const task = (async () => {
      const restarted = await restartHost(executor, wc, onRespawn, () => isActive(token));
      if (!isActive(token)) return;
      if (restarted) {
        backoffMs = 1000;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = undefined;
      } else {
        scheduleRetry(token);
      }
    })();
    restarting = task;
    void task.finally(() => {
      if (restarting === task) restarting = undefined;
    });
    return task;
  };
  const timer = setInterval(async () => {
    if (stopped) return;
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
          void restartNow();
        }
        return;
      }
      // p === null：通道忙，中性不计。
    } finally {
      probing = false;
    }
  }, WATCHDOG_INTERVAL_MS);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      generation++;
      clearInterval(timer);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
    restartNow,
    running: () => !stopped,
  };
}

// 重新注入 host.js（容器内缺失时从构建产物拉取）并 respawn，等待就绪。
export async function restartHost(
  executor: TerminalExecutor,
  wc: WebContainer,
  onRespawn?: () => Promise<void> | void,
  isActive: () => boolean = () => true,
): Promise<boolean> {
  try {
    if (!isActive()) return false;
    getTerm().writeln(`${AMBER}[ WARN ] host unresponsive — re-injecting host.js and respawning${RESET}`);
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
    if (!isActive()) return false;
    await executor.respawn();
    if (!isActive()) return false;
    // Rotate the session nonce only after the replacement daemon is ready.
    // Frames written for the dead host then fail closed, while the browser
    // device reconnects through the same mailbox/session identity.
    await onRespawn?.();
    if (!isActive()) return false;
    getTerm().writeln(`${AMBER}[  OK  ] host respawned — process table is clean${RESET}`);
    void log('WARN', 'host respawned; process table is fresh');
    return true;
  } catch (e) {
    getTerm().writeln(`${RED}[ FAIL ] host restart failed: ${String(e)}${RESET}`);
    void log('ERROR', `host restart failed: ${String(e)}`);
    return false;
  }
}
