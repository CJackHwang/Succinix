// invariant: per-instance stack creation, release, and process listing for
// the internal succinix lifecycle seam.
import type { WebContainer as WebContainerType } from '@webcontainer/api';
import {
  pagePorts,
  TerminalClient,
  type ProcInfo,
  type TerminalExecutor,
} from '../engine/index.js';
import { createSuccinixInstance as createEngineInstance } from '../instance/index.js';
import { instanceStateRoot } from '../instance/paths.js';
import { normalizeInstanceId } from '../engine/host-route.js';
import { instancePorts } from '../instance/ports.js';
import type { ResolvedSuccinixConfig } from './config.js';
import type { HostManager } from './host-manager.js';
import { makeServicesService } from './services-service.js';
import type { SuccinixPluginState, SuccinixStateReason } from './state.js';
import type {
  EnsureInstanceOptions,
  SuccinixEventMap,
  SuccinixInstance,
  SuccinixProcessEvent,
} from './types.js';
import {
  createWorkspaceService,
  type WorkspaceBackend,
} from './workspace.js';

export interface HostInstanceManagerDeps {
  instances: Map<string, SuccinixInstance>;
  state: SuccinixPluginState;
  manager: HostManager;
  resolvedConfig(): ResolvedSuccinixConfig;
  defaultId(): string;
  requireWc(): WebContainerType;
  setError(message: string): never;
  wrapExecutor(instanceId: string, executor: TerminalExecutor): TerminalExecutor;
  makeWorkspaceBackend(instanceId: string): WorkspaceBackend;
  publish<K extends keyof SuccinixEventMap>(event: K, payload: SuccinixEventMap[K]): void;
  emitState(reason: SuccinixStateReason): void;
}

export class SuccinixHostInstanceManager {
  constructor(private readonly deps: HostInstanceManagerDeps) {}

  async ensureInstance(containerId: string, opts: EnsureInstanceOptions = {}): Promise<SuccinixInstance> {
    const {
      instances,
      state,
      manager,
      resolvedConfig,
      requireWc,
      wrapExecutor,
      makeWorkspaceBackend,
      publish,
      emitState,
    } = this.deps;
    const instanceId = normalizeInstanceId(containerId);
    const wc = requireWc();
    const existing = instances.get(instanceId);
    if (existing) return existing;

    const config = resolvedConfig();
    const statePrefix = opts.statePrefix ?? config.defaultInstance.statePrefix;
    const home = opts.home ?? config.defaultInstance.home;
    const rpcClient = new TerminalClient(wc, { instanceId, onCommand: opts.executor?.onCommand });
    const instance = await createEngineInstance({
      wc,
      instanceId,
      statePrefix,
      home,
      persistence: opts.persistence ?? config.defaultInstance.persistence,
      executor: {
        ...opts.executor,
        instanceId,
        resultTtlMs: config.resultTtlMs,
        hostJsUrl: config.hostJsUrl,
        lifoCoreUrl: config.lifoCoreUrl,
        onCommand: opts.executor?.onCommand,
        onServerReady: (port, url) => opts.executor?.onServerReady?.(port, url),
        onServerClosed: (port) => opts.executor?.onServerClosed?.(port),
      },
      rpc: rpcClient,
      hostProc: manager.getHostProc() ?? undefined,
      bootSteps: opts.bootSteps,
      bootUI: opts.bootUI,
      onRestart: opts.onRestart,
    });

    const view: SuccinixInstance = {
      instanceId: instance.instanceId,
      client: instance.client,
      executor: wrapExecutor(instanceId, instance.executor),
      persist: instance.persist,
      ports: instance.ports,
      statePrefix,
      snapshot: instance.snapshot,
      services: makeServicesService(instance, wc),
      workspace: createWorkspaceService({
        stateRoot: instanceStateRoot(instanceId, statePrefix),
        home: home ?? '/workspace',
        backend: makeWorkspaceBackend(instanceId),
      }),
      restart: () => instance.restart(),
      dispose: () => instance.dispose(),
    };

    instances.set(instanceId, view);
    state.instances.push({ instanceId, state: 'active' });
    publish('succinix/instance', { containerId: instanceId, state: 'created' });
    emitState('instance');
    return view;
  }

  async releaseInstance(containerId: string): Promise<void> {
    const { instances, state, publish, emitState } = this.deps;
    const instanceId = normalizeInstanceId(containerId);
    const instance = instances.get(instanceId);
    if (!instance) return;
    try {
      await instance.client.resetInstance();
    } catch {
      // The browser-owned resources still need release when the host is gone.
    }
    await instance.dispose();
    pagePorts.unsubscribe(instanceId);
    instancePorts.releaseAll(instanceId);
    instances.delete(instanceId);
    state.instances = state.instances.filter((item) => item.instanceId !== instanceId);
    publish('succinix/instance', { containerId: instanceId, state: 'released' });
    emitState('instance');
  }

  async listProcesses(containerId?: string): Promise<ProcInfo[]> {
    const { instances, defaultId, setError, publish } = this.deps;
    const id = normalizeInstanceId(containerId ?? defaultId());
    const instance = instances.get(id);
    if (!instance) setError(`instance '${id}' is not available`);
    const processes = await instance!.executor.listProcesses();
    const payload: SuccinixProcessEvent = {
      instanceId: id,
      processes: processes.map((proc) => ({ pid: proc.pid, status: proc.status, command: proc.cmd })),
    };
    publish('succinix/process', payload);
    return processes;
  }
}
