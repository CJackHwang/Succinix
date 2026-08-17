// app plugin: bench/scenario/test window handles.
import type { Context } from '@deepseek-ai/cordis';
import type { SuccinixHostService } from '@succinix/engine';
import { benchMode, scenarioMode, installDevHooks, scenarioRun } from '../../app/dev-hooks.js';
import type { AppDevhooksService, AppShell } from '../types.js';

export const name = 'succinix-app-devhooks';

export function apply(ctx: Context): void {
  const service: AppDevhooksService = {
    attach(shell: AppShell) {
      const host = ctx.get('succinix', false) as SuccinixHostService | undefined;
      if (!host) throw new Error('succinix service is unavailable');
      installDevHooks({
        benchMode,
        scenarioMode,
        host,
        client: shell.client,
        wc: shell.wc,
        ports: shell.ports,
        term: shell.term,
        interactive: shell.interactive,
        saveSnapshot: shell.saveSnapshot,
        restoreSnapshot: () => shell.instance.snapshot.restore(),
        run: (cmd, timeoutMs) => scenarioRun(shell.executor, shell, cmd, timeoutMs),
        respawn: async () => {
          await shell.executor.respawn();
          await shell.interactive.renewBootNonce();
        },
      });
    },
  };
  ctx.provide('succinix-app-devhooks', service);
}

const plugin = { name, apply };
export default plugin;
