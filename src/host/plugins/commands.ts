// app plugin: local command context built from the engine instance handle.
import type { Context } from '@deepseek-ai/cordis';
import type { CommandContext, SuccinixPluginSummary } from '../../commands/index.js';
import {
  DEFAULT_INSTANCE_ID,
  type LocalCommandHandler,
  type SuccinixHostService,
} from '@succinix/engine';
import { makeLocalHandlers } from '../../app/local-commands.js';
import type { AppCommandsService, AppShell } from '../types.js';

function pluginSummaries(ctx: Context): SuccinixPluginSummary[] {
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
  let shell: AppShell | null = null;
  const context = () => {
    if (!shell) throw new Error('succinix-app-commands: shell is not attached');
    const host = ctx.get('succinix-host', undefined) as SuccinixHostService | undefined;
    return buildCommandContext(shell, host, pluginSummaries(ctx));
  };
  const service: AppCommandsService = {
    attach(next: AppShell) {
      shell = next;
      const host = ctx.get('succinix-host', undefined) as SuccinixHostService | undefined;
      return buildCommandContext(next, host, pluginSummaries(ctx));
    },
    makeHandlers(): Record<string, LocalCommandHandler> {
      return makeLocalHandlers(context);
    },
  };
  ctx.provide('succinix-app-commands', service);
}

const plugin = { name, apply };
export default plugin;
