// invariant: shared runtime helpers for the internal succinix surface.
import type { WebContainer as WebContainerType } from '@webcontainer/api';
import type {
  EngineBootHooks,
  TerminalExecutor,
} from '../engine/index.js';
import type { SnapshotMeta } from '../persist/index.js';
import { assetManifestUrl, fetchAssetText, loadAssetManifest, type AssetManifest } from './assets.js';
import type { ResolvedSuccinixConfig } from './config.js';
import { redactCommand } from '../redact.js';
import type { SuccinixPluginState } from './state.js';
import type {
  SuccinixCommandEvent,
  SuccinixCommandStartEvent,
  SuccinixInstance,
  SuccinixWorkspaceEvent,
} from './types.js';
import type { WorkspaceBackend } from './workspace.js';

export function commandRuntime(runtime?: string): SuccinixCommandEvent['runtime'] {
  if (runtime === 'node' || runtime === 'lifo') return runtime;
  return 'browser';
}

export function stateChanged(previous: SuccinixPluginState, next: SuccinixPluginState): string[] {
  const changed: string[] = [];
  if (previous.version !== next.version) changed.push('version');
  if (previous.containerMode !== next.containerMode) changed.push('containerMode');
  if (previous.containerState !== next.containerState) changed.push('containerState');
  if (previous.host.pid !== next.host.pid || previous.host.startedAt !== next.host.startedAt) changed.push('host');
  if (JSON.stringify(previous.instances) !== JSON.stringify(next.instances)) changed.push('instances');
  if (previous.capabilities.join(',') !== next.capabilities.join(',')) changed.push('capabilities');
  if (previous.configRevision !== next.configRevision) changed.push('configRevision');
  if (previous.lastError !== next.lastError) changed.push('lastError');
  return changed;
}

export interface TelemetryExecutorOptions {
  instanceId: string;
  nextId(): string;
  publish(payload: SuccinixCommandEvent): void;
  publishStart?(payload: SuccinixCommandStartEvent): void;
  executor: TerminalExecutor;
}

export function wrapExecutorWithTelemetry(options: TelemetryExecutorOptions): TerminalExecutor {
  const { instanceId, nextId, publish, publishStart, executor } = options;
  const safeCommand = (command: string): string => redactCommand(command);
  return {
    boot: (wc, hooks) => executor.boot(wc, hooks),
    exec: async (command, opts = {}) => {
      const startedAt = Date.now();
      const id = nextId();
      publishStart?.({ id, instanceId, command: safeCommand(command), startedAt });
      try {
        const result = await executor.exec(command, opts);
        publish({
          id,
          instanceId,
          command: safeCommand(command),
          runtime: commandRuntime(result.runtime),
          exitCode: result.exitCode ?? (result.ok ? 0 : 1),
          startedAt,
          durationMs: Date.now() - startedAt,
          pid: result.pid,
          timedOut: result.timedOut,
          ...(result.error ? { error: result.error } : {}),
        });
        return result;
      } catch (error) {
        publish({
          id,
          instanceId,
          command: safeCommand(command),
          runtime: 'browser',
          exitCode: null,
          startedAt,
          durationMs: Date.now() - startedAt,
          error: String(error),
        });
        throw error;
      }
    },
    spawn: async (command, opts = {}) => {
      const startedAt = Date.now();
      const id = nextId();
      publishStart?.({ id, instanceId, command: safeCommand(command), startedAt });
      try {
        const result = await executor.spawn(command, opts);
        publish({
          id,
          instanceId,
          command: safeCommand(command),
          runtime: commandRuntime(result.runtime),
          exitCode: result.exitCode ?? (result.ok ? 0 : 1),
          startedAt,
          durationMs: Date.now() - startedAt,
          pid: result.pid,
          ...(result.error ? { error: result.error } : {}),
        });
        return result;
      } catch (error) {
        publish({
          id,
          instanceId,
          command: safeCommand(command),
          runtime: 'browser',
          exitCode: null,
          startedAt,
          durationMs: Date.now() - startedAt,
          error: String(error),
        });
        throw error;
      }
    },
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
}

export interface WorkspaceBackendDeps {
  getInstance(instanceId: string): SuccinixInstance | undefined;
  setError(message: string): never;
  requireWc(): WebContainerType;
  publishWorkspace(instanceId: string, reason: SuccinixWorkspaceEvent['reason'], savedAt?: number): void;
}

export function createWorkspaceBackend(instanceId: string, deps: WorkspaceBackendDeps): WorkspaceBackend {
  return {
    restore: async () => {
      const instance = deps.getInstance(instanceId);
      if (!instance) deps.setError(`instance '${instanceId}' is not available`);
      await instance!.snapshot.restore();
      deps.publishWorkspace(instanceId, 'restore', Date.now());
    },
    flush: async (tag?: string) => {
      const instance = deps.getInstance(instanceId);
      if (!instance) deps.setError(`instance '${instanceId}' is not available`);
      await instance!.persist.force(deps.requireWc().fs, tag);
      deps.publishWorkspace(instanceId, 'flush', Date.now());
    },
    list: async () => {
      const instance = deps.getInstance(instanceId);
      if (!instance) deps.setError(`instance '${instanceId}' is not available`);
      const meta: SnapshotMeta | null = await instance!.persist.meta();
      return [{ instanceId, meta }];
    },
  };
}

export async function loadBootAssets(
  config: ResolvedSuccinixConfig,
  hooks: EngineBootHooks = {}
): Promise<{ hostSrc?: string; lifoCoreSrc?: string }> {
  if (hooks.hostSrc !== undefined && hooks.lifoCoreSrc !== undefined) {
    return { hostSrc: hooks.hostSrc ?? undefined, lifoCoreSrc: hooks.lifoCoreSrc ?? undefined };
  }
  let manifest: AssetManifest | undefined;
  if (config.assets.integrity) {
    manifest = await loadAssetManifest(assetManifestUrl(config.hostJsUrl));
  }
  const [hostSrc, lifoCoreSrc] = await Promise.all([
    hooks.hostSrc ?? fetchAssetText(config.hostJsUrl, manifest?.['host.js'], config.assets.integrity),
    hooks.lifoCoreSrc ?? fetchAssetText(config.lifoCoreUrl, manifest?.['lifo-core.js'], config.assets.integrity),
  ]);
  return { hostSrc, lifoCoreSrc };
}
