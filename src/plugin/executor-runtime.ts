// invariant: python-aware executor wrapper for succinix instances.
import type { WebContainer as WebContainerType } from '@webcontainer/api';
import {
  ensurePythonRuntime,
  type TerminalExecutor,
} from '../engine/index.js';
import { ensureRubyRuntime } from '../engine/ruby-assets.js';
import { tokenize } from '../engine/tokenize.js';
import type { SuccinixCommandEvent, SuccinixCommandStartEvent } from './types.js';
import { wrapExecutorWithTelemetry } from './service-runtime.js';

const PYTHON_TOKENS = new Set(['python', 'python3', 'pip', 'pip3']);
const RUBY_TOKENS = new Set(['ruby']);

export function isPythonCommand(command: string): boolean {
  try {
    return tokenize(command).some((token) => PYTHON_TOKENS.has(token));
  } catch {
    /* host reports unterminated quote/parse errors */
    return false;
  }
}

export function isRubyCommand(command: string): boolean {
  try {
    return tokenize(command).some((token) => RUBY_TOKENS.has(token));
  } catch {
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

export async function ensureRuntimeForCommand(
  wc: WebContainerType,
  assets: { python: string; ruby: string },
  command: string,
): Promise<void> {
  await Promise.all([
    isPythonCommand(command) ? ensurePythonRuntime(wc, assets.python) : Promise.resolve(),
    isRubyCommand(command) ? ensureRubyRuntime(wc, assets.ruby) : Promise.resolve(),
  ]);
}

export interface PythonExecutorWrapperOptions {
  instanceId: string;
  executor: TerminalExecutor;
  nextId(): string;
  publish(payload: SuccinixCommandEvent): void;
  publishStart?(payload: SuccinixCommandStartEvent): void;
  requireWc(): WebContainerType;
  pythonAssetsUrl: string;
  rubyAssetsUrl: string;
}

export function wrapExecutorWithPython(options: PythonExecutorWrapperOptions): TerminalExecutor {
  const { instanceId, executor, nextId, publish, publishStart, requireWc, pythonAssetsUrl, rubyAssetsUrl } = options;
  const pythonAware: TerminalExecutor = {
    boot: (wc, hooks) => executor.boot(wc, hooks),
    exec: async (command, opts) => {
      await ensureRuntimeForCommand(requireWc(), { python: pythonAssetsUrl, ruby: rubyAssetsUrl }, command);
      return executor.exec(command, opts);
    },
    spawn: (command, opts) => executor.spawn(command, opts),
    listProcesses: (options) => executor.listProcesses(options),
    kill: (pid, options) => executor.kill(pid, options),
    ping: () => executor.ping(),
    pingDirect: (timeoutMs) => executor.pingDirect(timeoutMs),
    interruptDirect: (timeoutMs) => executor.interruptDirect(timeoutMs),
    respawn: () => executor.respawn(),
    getHostProc: () => executor.getHostProc(),
    dispose: () => executor.dispose(),
    shutdown: () => executor.shutdown(),
    runtimeStatus: () => executor.runtimeStatus(),
    persistenceStatus: () => executor.persistenceStatus(),
    degradations: () => executor.degradations(),
    capabilities: () => executor.capabilities(),
    ...(executor.interactive ? { interactive: executor.interactive } : {}),
  };
  return wrapExecutorWithTelemetry({
    instanceId,
    nextId,
    publish,
    publishStart,
    executor: pythonAware,
  });
}
