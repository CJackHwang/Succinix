// app plugin: local command context built from the engine instance handle.
import type { Context } from 'cordis';
import type { CommandContext } from '../../commands.js';
import { DEFAULT_INSTANCE_ID, type LocalCommandHandler } from '@succinix/engine';
import { makeLocalHandlers } from '../../app/local-commands.js';
import type { AppCommandsService, AppShell } from '../types.js';

function buildCommandContext(shell: AppShell): CommandContext {
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
  };
}

export const name = 'succinix-app-commands';

export function apply(ctx: Context): void {
  let shell: AppShell | null = null;
  const context = () => {
    if (!shell) throw new Error('succinix-app-commands: shell is not attached');
    return buildCommandContext(shell);
  };
  const service: AppCommandsService = {
    attach(next: AppShell) {
      shell = next;
      return buildCommandContext(next);
    },
    makeHandlers(): Record<string, LocalCommandHandler> {
      return makeLocalHandlers(context);
    },
  };
  ctx.provide('succinix-app-commands', service);
}

const plugin = { name, apply };
export default plugin;
