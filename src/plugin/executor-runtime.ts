// invariant: python-aware executor wrapper for succinix-host instances.
import type { WebContainer as WebContainerType } from '@webcontainer/api';
import {
  ensurePythonRuntime,
  type TerminalExecutor,
} from '../engine/index.js';
import { tokenize } from '../engine/tokenize.js';
import type { SuccinixCommandEvent } from './types.js';
import { wrapExecutorWithTelemetry } from './service-runtime.js';

const PYTHON_TOKENS = new Set(['python', 'python3', 'pip', 'pip3']);

export function isPythonCommand(command: string): boolean {
  try {
    return tokenize(command).some((token) => PYTHON_TOKENS.has(token));
  } catch {
    /* host reports unterminated quote/parse errors */
    return false;
  }
}

export async function ensurePythonForCommand(
  wc: WebContainerType,
  pythonAssetsUrl: string,
  command: string
): Promise<void> {
  if (isPythonCommand(command)) {
    await ensurePythonRuntime(wc, pythonAssetsUrl);
  }
}

export interface PythonExecutorWrapperOptions {
  instanceId: string;
  executor: TerminalExecutor;
  nextId(): string;
  publish(payload: SuccinixCommandEvent): void;
  requireWc(): WebContainerType;
  pythonAssetsUrl: string;
}

export function wrapExecutorWithPython(options: PythonExecutorWrapperOptions): TerminalExecutor {
  const { instanceId, executor, nextId, publish, requireWc, pythonAssetsUrl } = options;
  const pythonAware: TerminalExecutor = {
    boot: (wc, hooks) => executor.boot(wc, hooks),
    exec: async (command, opts) => {
      await ensurePythonForCommand(requireWc(), pythonAssetsUrl, command);
      return executor.exec(command, opts);
    },
    spawn: (command, opts) => executor.spawn(command, opts),
    listProcesses: () => executor.listProcesses(),
    kill: (pid) => executor.kill(pid),
    ping: () => executor.ping(),
    pingDirect: (timeoutMs) => executor.pingDirect(timeoutMs),
    interruptDirect: (timeoutMs) => executor.interruptDirect(timeoutMs),
    respawn: () => executor.respawn(),
    getHostProc: () => executor.getHostProc(),
    dispose: () => executor.dispose(),
  };
  return wrapExecutorWithTelemetry({
    instanceId,
    nextId,
    publish,
    executor: pythonAware,
  });
}
