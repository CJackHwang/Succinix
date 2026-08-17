// app plugin: local command context built from the engine instance handle.
import type { Context } from '@deepseek-ai/cordis';
import type { CommandContext, SuccinixPluginSummary } from '../../commands/index.js';
import {
  DEFAULT_INSTANCE_ID,
  type SuccinixHostService,
} from '@succinix/engine';
import type { AppCommandsService, AppShell } from '../types.js';

export function pluginSummaries(ctx: Context): SuccinixPluginSummary[] {
  const labels = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const;
  return [...ctx.registry.values()].map((runtime) => ({
    name: runtime.name ?? 'anonymous',
    fibers: [...runtime.fibers].map((fiber) => ({
      state: labels[fiber.state] ?? String(fiber.state),
    })),
  }));
}

function buildCommandContext(shell: AppShell, host: SuccinixHostService | undefined, plugins: SuccinixPluginSummary[]): CommandContext {
  return {
    wc: shell.wc,
    client: shell.client,
    ports: shell.ports,
    term: shell.term,
    fit: shell.fit,
    hostProc: shell.executor.getHostProc() ?? undefined,
    instanceId: shell.instanceId === DEFAULT_INSTANCE_ID ? undefined : shell.instanceId,
    statePrefix: shell.instance.statePrefix,
    persist: shell.instance.persist,
    userId: shell.userId,
    onInstanceReset: shell.onInstanceReset,
    onInstanceStop: shell.onInstanceStop,
    engineState: host?.state,
    pluginSummaries: plugins,
  };
}

export const name = 'succinix-app-commands';

export function apply(ctx: Context): void {
  const service: AppCommandsService = {
    attach(next: AppShell) {
      const host = ctx.get('succinix', undefined) as SuccinixHostService | undefined;
      return buildCommandContext(next, host, pluginSummaries(ctx));
    },
  };
  ctx.provide('succinix-app-commands', service);
}

const plugin = { name, apply };
export default plugin;
