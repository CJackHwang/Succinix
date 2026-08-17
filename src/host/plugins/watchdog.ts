// app plugin: host watchdog.
import type { Context } from '@deepseek-ai/cordis';
import { startHostWatchdog, type WatchdogController } from '../../app/watchdog.js';
import type { AppShell, AppWatchdogService } from '../types.js';

export const name = 'succinix-app-watchdog';

export function apply(ctx: Context): void {
  let activeController: WatchdogController | undefined;
  const service: AppWatchdogService = {
    attach(shell: AppShell) {
      activeController?.stop();
      activeController = startHostWatchdog(shell.executor, shell.wc, () => shell.interactive.renewBootNonce());
    },
    stop() {
      activeController?.stop();
      activeController = undefined;
    },
  };
  ctx.provide('succinix-app-watchdog', service);
  ctx.effect(() => () => service.stop());
}

const plugin = { name, apply };
export default plugin;
