// invariant: ctx.succinix service surface (services, lifecycle, events).
import type { Context } from 'cordis';
import { ValidationError } from 'cordis';
import type { WebContainer as WebContainerType } from '@webcontainer/api';
import {
  pagePorts,
  TerminalClient,
  type ProcInfo,
  type TerminalExecutor,
} from '../engine/index.js';
import { createSuccinixInstance as createEngineInstance } from '../instance/index.js';
import { instancePorts } from '../instance/ports.js';
import { instanceStateRoot } from '../instance/paths.js';
import type { SaveResult } from '../persist.js';
import {
  clearActivePorts,
  clearDbActivePorts,
  type ServiceActionResult,
  type ServiceState,
} from '../services/index.js';
import type {
  SuccinixTerminalSession,
  TerminalOutput,
  TerminalSessionOptions,
} from '../terminal/index.js';
import { SuccinixCapabilityRegistry } from './capabilities.js';
import {
  resolveConfig,
  requiresRestart,
  SuccinixConfigSchema,
  type ResolvedSuccinixConfig,
  type SuccinixConfig,
} from './config.js';
import { defaultInstanceId, defaultInstanceUnavailable } from './default-instance.js';
import { getHostManager, type HostManager } from './host-manager.js';
import { invariantString } from './invariant.js';
import { createPortsService, type SuccinixPortsService } from './ports.js';
import { checkSync } from './schema.js';
import { ServiceLifecycle } from './service-lifecycle.js';
import {
  createTerminalSession,
  createWorkspaceBackend,
  noOpOutput,
  stateChanged,
  wrapExecutorWithTelemetry,
} from './service-runtime.js';
import {
  cloneState,
  createInitialState,
  type SuccinixStateReason,
} from './state.js';
import type {
  BootOptions,
  EnsureInstanceOptions,
  SuccinixCommandEvent,
  SuccinixEventMap,
  SuccinixInstance,
  SuccinixPortEvent,
  SuccinixProcessEvent,
  SuccinixService,
  SuccinixWorkspaceEvent,
} from './types.js';
import { createWorkspaceService, type SuccinixWorkspaceService } from './workspace.js';

export function createSuccinixService(ctx: Context, config: ResolvedSuccinixConfig, rawConfig: SuccinixConfig = {}): SuccinixService {
  const state = createInitialState();
  state.version = '0.5.0';
  state.containerMode = config.container.mode;
  let resolvedConfig = config;
  let raw = rawConfig;
  let capabilities = new SuccinixCapabilityRegistry(config.capabilities);
  state.capabilities = capabilities.list();

  let defaultId = defaultInstanceId(config);
  const manager: HostManager = getHostManager();
  const instances = new Map<string, SuccinixInstance>();
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const portUnsubs = new Set<() => void>();
  let lastState = cloneState(state);

  const publish = <K extends keyof SuccinixEventMap>(event: K, payload: SuccinixEventMap[K]): void => {
    for (const handler of handlers.get(event) ?? []) {
      (handler as (value: SuccinixEventMap[K]) => void)(payload);
    }
    try {
      (ctx as { emit(name: string, payload: unknown): void }).emit(event as string, payload);
    } catch {
      /* context may already be inactive during dispose */
    }
  };

  const emitState = (reason: SuccinixStateReason): void => {
    const next = cloneState(state);
    const changed = stateChanged(lastState, next);
    lastState = next;
    publish('succinix/state', { state: next, reason, changed });
  };

  const lifecycle = new ServiceLifecycle({
    instances,
    state,
    manager,
    capabilities: () => capabilities,
    handlers,
    portUnsubs,
    defaultId: () => defaultId,
    resolvedConfig: () => resolvedConfig,
    emitState,
    publish: (event, payload) => publish(event, payload),
  });

  const setError = (message: string): never => {
    state.lastError = message;
    emitState('error');
    throw new Error(message);
  };

  const requireWc = (): WebContainerType => {
    const handle = manager.handle();
    if (handle.state !== 'ready' || !handle.wc) {
      return setError('container is not ready; call boot() or attach() first');
    }
    return handle.wc;
  };

  const requireDefault = (): SuccinixInstance => {
    const instance = instances.get(defaultId);
    if (!instance) {
      state.lastError = `default instance '${defaultId}' is not available; call ensureInstance('${defaultId}') first`;
      emitState('error');
      throw defaultInstanceUnavailable(state);
    }
    return instance;
  };

  const containerHandle = () => {
    const handle = manager.handle();
    return {
      mode: handle.mode ?? resolvedConfig.container.mode,
      state: handle.state,
      wc: handle.wc,
      hostPid: handle.hostPid,
      startedAt: handle.startedAt,
    };
  };

  let commandCounter = 0;
  const nextCommandId = (instanceId: string): string => `${instanceId}:${++commandCounter}`;

  const publishCommand = (payload: SuccinixCommandEvent): void => {
    publish('succinix/command', payload);
  };

  const wrapExecutor = (instanceId: string, executor: TerminalExecutor): TerminalExecutor =>
    wrapExecutorWithTelemetry({
      instanceId,
      nextId: () => nextCommandId(instanceId),
      publish: (payload) => publishCommand(payload),
      executor,
    });

  const publishWorkspace = (instanceId: string, reason: SuccinixWorkspaceEvent['reason'], savedAt?: number): void => {
    publish('succinix/workspace', { instanceId, reason, ...(savedAt !== undefined ? { savedAt } : {}) });
  };

  const makeWorkspaceBackend = (instanceId: string) =>
    createWorkspaceBackend(instanceId, {
      getInstance: (id) => instances.get(id),
      setError,
      requireWc,
      publishWorkspace,
    });

  const rebuildDefaultViews = (): void => {
    currentWorkspace = createWorkspaceService({
      stateRoot: instanceStateRoot(defaultId, resolvedConfig.defaultInstance.statePrefix),
      home: resolvedConfig.defaultInstance.home ?? '/workspace',
      backend: makeWorkspaceBackend(defaultId),
    });
    currentPorts = createPortsService(defaultId);
  };

  let currentWorkspace: SuccinixWorkspaceService = createWorkspaceService({
    stateRoot: instanceStateRoot(defaultId, resolvedConfig.defaultInstance.statePrefix),
    home: resolvedConfig.defaultInstance.home ?? '/workspace',
    backend: makeWorkspaceBackend(defaultId),
  });
  let currentPorts: SuccinixPortsService = createPortsService(defaultId);

  const createSession = (output: TerminalOutput, opts: TerminalSessionOptions = {}): SuccinixTerminalSession => {
    const instance = requireDefault();
    const wc = requireWc();
    return createTerminalSession(instance, wc, resolvedConfig.terminal, output, opts);
  };

  const boot = (opts: BootOptions = {}): Promise<WebContainerType> => lifecycle.boot(opts);
  const attach = (wc: WebContainerType, opts: EnsureInstanceOptions = {}): Promise<void> => lifecycle.attach(wc, opts);

  const ensureInstance = async (containerId: string, opts: EnsureInstanceOptions = {}): Promise<SuccinixInstance> => {
    invariantString(containerId, 'containerId');
    const wc = requireWc();
    const existing = instances.get(containerId);
    if (existing) return existing;

    const statePrefix = opts.statePrefix ?? resolvedConfig.defaultInstance.statePrefix;
    const home = opts.home ?? resolvedConfig.defaultInstance.home;
    const rpcClient = new TerminalClient(wc, { instanceId: containerId });
    const instance = await createEngineInstance({
      wc,
      instanceId: containerId,
      statePrefix,
      home,
      persistence: opts.persistence ?? resolvedConfig.defaultInstance.persistence,
      output: opts.output ?? noOpOutput,
      terminal: { ...resolvedConfig.terminal, ...opts.terminal },
      executor: {
        ...opts.executor,
        instanceId: containerId,
        resultTtlMs: resolvedConfig.resultTtlMs,
        hostJsUrl: resolvedConfig.hostJsUrl,
        lifoCoreUrl: resolvedConfig.lifoCoreUrl,
        onCommand: opts.executor?.onCommand,
        onServerReady: (port, url) => opts.executor?.onServerReady?.(port, url),
        onServerClosed: (port) => opts.executor?.onServerClosed?.(port),
      },
      rpc: rpcClient,
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
      snapshot: instance.snapshot,
      services: {
        list: () => instance.services.list() as Promise<ServiceState[]>,
        start: (name) => instance.services.start(name) as Promise<ServiceActionResult>,
        stop: (name) => instance.services.stop(name) as Promise<ServiceActionResult>,
      },
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
  };

  const releaseInstance = async (containerId: string): Promise<void> => {
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
  };

  const listProcesses = async (containerId?: string): Promise<ProcInfo[]> => {
    const id = containerId ?? defaultId;
    const instance = instances.get(id);
    if (!instance) setError(`instance '${id}' is not available`);
    const processes = await instance!.executor.listProcesses();
    const payload: SuccinixProcessEvent = {
      instanceId: id,
      processes: processes.map((proc) => ({ pid: proc.pid, status: proc.status, command: proc.cmd })),
    };
    publish('succinix/process', payload);
    return processes;
  };

  const service: SuccinixService = {
    get state() {
      return state;
    },
    get container() {
      return containerHandle();
    },
    get executor() {
      return requireDefault().executor;
    },
    terminal: {
      create: (output, opts) => createSession(output, opts),
    },
    get snapshot() {
      const instance = requireDefault();
      return {
        save: async (force?: boolean): Promise<SaveResult> => {
          const result = await instance.persist.save(requireWc().fs, force);
          publishWorkspace(instance.instanceId, result.reason === 'cleared' ? 'clear' : 'save', result.meta.savedAt || Date.now());
          return result;
        },
        restore: async () => {
          await instance.persist.load(requireWc().fs);
          publishWorkspace(instance.instanceId, 'restore', Date.now());
        },
        meta: () => instance.persist.meta(),
        clear: async () => {
          await instance.persist.clear();
          publishWorkspace(instance.instanceId, 'clear', Date.now());
        },
      };
    },
    get persist() {
      return requireDefault().persist;
    },
    get workspace() {
      return currentWorkspace;
    },
    get ports() {
      return currentPorts;
    },
    get services() {
      const instance = requireDefault();
      return {
        list: () => instance.services.list() as Promise<ServiceState[]>,
        start: (name: string) => instance.services.start(name) as Promise<ServiceActionResult>,
        stop: (name: string) => instance.services.stop(name) as Promise<ServiceActionResult>,
      };
    },
    capabilities,
    get instance() {
      return instances.get(defaultId) ?? null;
    },
    attach,
    boot,
    ensureInstance,
    getInstance: (containerId) => instances.get(containerId),
    releaseInstance,
    listProcesses,
    on: (event, handler) => {
      const key = event as string;
      let set = handlers.get(key);
      if (!set) {
        set = new Set();
        handlers.set(key, set);
      }
      const wrapped = handler as (payload: unknown) => void;
      set.add(wrapped);
      return () => {
        set?.delete(wrapped);
      };
    },
    onServerReady: (handler) => {
      const unsubscribe = currentPorts.onServerReady(handler);
      portUnsubs.add(unsubscribe);
      return () => {
        unsubscribe();
        portUnsubs.delete(unsubscribe);
      };
    },
    onServerClosed: (handler) => {
      const unsubscribe = currentPorts.onServerClosed(handler);
      portUnsubs.add(unsubscribe);
      return () => {
        unsubscribe();
        portUnsubs.delete(unsubscribe);
      };
    },
    dispose: () => lifecycle.dispose(),
    shutdown: () => lifecycle.shutdown(),
    reconfigure: async (next: SuccinixConfig) => {
      const result = checkSync(SuccinixConfigSchema, next);
      if ('issues' in result && result.issues && result.issues.length > 0) {
        state.lastError = result.issues.map((issue) => issue.message).join('; ');
        emitState('error');
        throw new ValidationError(result.issues);
      }
      const nextResolved = resolveConfig(next);
      const restart = requiresRestart(raw, next);
      if (restart) {
        await lifecycle.shutdown();
        lifecycle.resetShutdownState();
      }
      raw = next;
      resolvedConfig = nextResolved;
      defaultId = defaultInstanceId(nextResolved);
      capabilities = new SuccinixCapabilityRegistry(nextResolved.capabilities);
      state.capabilities = capabilities.list();
      state.containerMode = nextResolved.container.mode;
      state.configRevision++;
      state.lastError = null;
      rebuildDefaultViews();
      if (restart) state.containerState = 'disposed';
      emitState('config');
    },
  };

  return service;
}

export type { SuccinixPortEvent };
