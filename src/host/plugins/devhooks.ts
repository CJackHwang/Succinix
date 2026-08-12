// app plugin: bench/scenario/test window handles.
import type { Context } from 'cordis';
import { benchMode, scenarioMode, installDevHooks, scenarioRun } from '../../app/dev-hooks.js';
import type { AppDevhooksService, AppShell } from '../types.js';

export const name = 'succinix-app-devhooks';

export function apply(ctx: Context): void {
  const service: AppDevhooksService = {
    attach(shell: AppShell) {
      installDevHooks({
        benchMode,
        scenarioMode,
        client: shell.client,
        wc: shell.wc,
        ports: shell.ports,
        term: shell.term,
        saveSnapshot: shell.saveSnapshot,
        run: (cmd, timeoutMs) => scenarioRun(shell.instance.terminal, shell, cmd, timeoutMs),
      });
    },
  };
  ctx.provide('succinix-app-devhooks', service);
}

const plugin = { name, apply };
export default plugin;
