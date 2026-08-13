// app plugin: host watchdog.
import type { Context } from '@deepseek-ai/cordis';
import { startHostWatchdog } from '../../app/watchdog.js';
import type { AppShell, AppWatchdogService } from '../types.js';

export const name = 'succinix-app-watchdog';

export function apply(ctx: Context): void {
  const service: AppWatchdogService = {
    attach(shell: AppShell) {
      startHostWatchdog(shell.executor, shell.wc);
    },
  };
  ctx.provide('succinix-app-watchdog', service);
}

const plugin = { name, apply };
export default plugin;
