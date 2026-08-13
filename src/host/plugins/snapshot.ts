// app plugin: auto snapshot loop.
import type { Context } from '@deepseek-ai/cordis';
import { startAutoSnapshot } from '../../app/auto-snapshot.js';
import type { AppShell, AppSnapshotService } from '../types.js';

export const name = 'succinix-app-snapshot';

export function apply(ctx: Context): void {
  const service: AppSnapshotService = {
    attach(shell: AppShell) {
      startAutoSnapshot(shell.wc.fs, shell.instance.persist);
    },
  };
  ctx.provide('succinix-app-snapshot', service);
}

const plugin = { name, apply };
export default plugin;
