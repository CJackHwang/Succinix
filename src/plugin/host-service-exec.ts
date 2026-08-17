// invariant: command event publishing and executor wrapping helpers for the
// succinix service (split from host-service.ts for the 450-line gate).
import type { WebContainer as WebContainerType } from '@webcontainer/api';
import type { TerminalExecutor } from '../engine/index.js';
import { wrapExecutorWithPython } from './executor-runtime.js';
import type { SuccinixCommandEvent, SuccinixEventMap } from './types.js';

export interface CommandEventHelpers {
  wrapExecutor(instanceId: string, executor: TerminalExecutor): TerminalExecutor;
}

export function createCommandEventHelpers(options: {
  publish: <K extends keyof SuccinixEventMap>(event: K, payload: SuccinixEventMap[K]) => void;
  requireWc(): WebContainerType;
  pythonAssetsUrl: string;
  rubyAssetsUrl: string;
}): CommandEventHelpers {
  let commandCounter = 0;
  const nextCommandId = (instanceId: string): string => `${instanceId}:${++commandCounter}`;

  const publishCommand = (payload: SuccinixCommandEvent): void => {
    options.publish('succinix/command', payload);
    options.publish('succinix/command-finish', payload);
  };

  const wrapExecutor = (instanceId: string, executor: TerminalExecutor): TerminalExecutor =>
    wrapExecutorWithPython({
      instanceId,
      executor,
      nextId: () => nextCommandId(instanceId),
      publish: (payload) => publishCommand(payload),
      publishStart: (payload) => options.publish('succinix/command-start', payload),
      requireWc: options.requireWc,
      pythonAssetsUrl: options.pythonAssetsUrl,
      rubyAssetsUrl: options.rubyAssetsUrl,
    });

  return { wrapExecutor };
}
