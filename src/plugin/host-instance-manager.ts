// invariant: per-instance stack creation, release, and process listing for
// the internal succinix-host lifecycle seam.
import type { WebContainer as WebContainerType } from '@webcontainer/api';
import {
  pagePorts,
  TerminalClient,
  type ProcInfo,
  type TerminalExecutor,
} from '../engine/index.js';
import { createSuccinixInstance as createEngineInstance } from '../instance/index.js';
import { instanceStateRoot } from '../instance/paths.js';
import { instancePorts } from '../instance/ports.js';
import { clearActivePorts, clearDbActivePorts } from '../services/index.js';
import type { TerminalSessionOptions } from '../terminal/index.js';
import type { ResolvedSuccinixConfig } from './config.js';
import type { HostManager } from './host-manager.js';
import { invariantString } from './invariant.js';
import {
  noOpOutput,
} from './service-runtime.js';
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
  pythonBeforeRpc(
    beforeRpc?: TerminalSessionOptions['beforeRpc']
  ): (command: string) => Promise<void>;
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
      pythonBeforeRpc,
      makeWorkspaceBackend,
      publish,
      emitState,
    } = this.deps;
    invariantString(containerId, 'containerId');
    const wc = requireWc();
    const existing = instances.get(containerId);
    if (existing) return existing;

    const config = resolvedConfig();
    const statePrefix = opts.statePrefix ?? config.defaultInstance.statePrefix;
    const home = opts.home ?? config.defaultInstance.home;
    const rpcClient = new TerminalClient(wc, { instanceId: containerId, onCommand: opts.executor?.onCommand });
    const instance = await createEngineInstance({
      wc,
      instanceId: containerId,
      statePrefix,
      home,
      persistence: opts.persistence ?? config.defaultInstance.persistence,
      output: opts.output ?? noOpOutput,
      // 会话层也注入 Python 资产：宿主直取 instance.terminal 时不经过 wrapped executor。
      // 保留消费方自带的 beforeRpc，链式执行。
      terminal: {
        ...config.terminal,
        ...opts.terminal,
        beforeRpc: pythonBeforeRpc(opts.terminal?.beforeRpc),
      },
      executor: {
        ...opts.executor,
        instanceId: containerId,
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
      get terminal() {
        return instance.terminal;
      },
      executor: wrapExecutor(containerId, instance.executor),
      persist: instance.persist,
      ports: instance.ports,
      statePrefix,
      snapshot: instance.snapshot,
      services: makeServicesService(instance, wc),
      workspace: createWorkspaceService({
        stateRoot: instanceStateRoot(containerId, statePrefix),
        home: home ?? '/workspace',
        backend: makeWorkspaceBackend(containerId),
      }),
      restart: () => instance.restart(),
      dispose: () => instance.dispose(),
    };

    instances.set(containerId, view);
    state.instances.push({ instanceId: containerId, state: 'active' });
    publish('succinix/instance', { containerId, state: 'created' });
    emitState('instance');
    return view;
  }

  async releaseInstance(containerId: string): Promise<void> {
    const { instances, state, publish, emitState } = this.deps;
    invariantString(containerId, 'containerId');
    const instance = instances.get(containerId);
    if (!instance) return;
    await instance.dispose();
    pagePorts.unsubscribe(containerId);
    instancePorts.releaseAll(containerId);
    clearActivePorts(containerId);
    clearDbActivePorts(containerId);
    instances.delete(containerId);
    state.instances = state.instances.filter((item) => item.instanceId !== containerId);
    publish('succinix/instance', { containerId, state: 'released' });
    emitState('instance');
  }

  async listProcesses(containerId?: string): Promise<ProcInfo[]> {
    const { instances, defaultId, setError, publish } = this.deps;
    const id = containerId ?? defaultId();
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
