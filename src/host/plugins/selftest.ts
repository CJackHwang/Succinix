// app plugin: self-test runner.
import type { Context } from 'cordis';
import { runTests } from '../../tests.js';
import type { AppSelftestService, AppShell } from '../types.js';

export const name = 'succinix-app-selftest';

export function apply(ctx: Context): void {
  const service: AppSelftestService = {
    run(shell: AppShell) {
      return runTests({ wc: shell.wc, client: shell.client, ports: shell.ports, term: shell.term });
    },
  };
  ctx.provide('succinix-app-selftest', service);
}

const plugin = { name, apply };
export default plugin;
