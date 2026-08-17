// app plugin: auto snapshot loop.
import type { Context } from '@deepseek-ai/cordis';
import { startAutoSnapshot } from '../../app/auto-snapshot.js';
import type { AppShell, AppSnapshotService } from '../types.js';
import type { SnapshotController } from '../../persist/types.js';

export const name = 'succinix-app-snapshot';

export function apply(ctx: Context): void {
  let activeController: SnapshotController | undefined;
  const service: AppSnapshotService = {
    attach(shell: AppShell) {
      activeController?.stop();
      activeController = startAutoSnapshot(shell.wc.fs, shell.instance.persist);
    },
    stop() {
      activeController?.stop();
      activeController = undefined;
    },
  };
  ctx.provide('succinix-app-snapshot', service);
  ctx.effect(() => () => service.stop());
}

const plugin = { name, apply };
export default plugin;
