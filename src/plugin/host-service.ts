// invariant: internal succinix-host lifecycle seam, instance registry, and app
// observability facades. The public service keys are ctx.fs / ctx.sandbox /
// ctx.terminals / ctx.sessionPersistence; this object is not provided as
// the legacy single-key service.
import type { Context } from '@deepseek-ai/cordis';
import { ValidationError } from '@deepseek-ai/cordis';
import type { WebContainer as WebContainerType } from '@webcontainer/api';
import {
  type TerminalExecutor,
} from '../engine/index.js';
import { instanceStateRoot } from '../instance/paths.js';
import type { PersistContext, SaveResult } from '../persist/index.js';
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
import { ensurePythonForCommand, wrapExecutorWithPython } from './executor-runtime.js';
import { SuccinixHostInstanceManager } from './host-instance-manager.js';
import { getHostManager, type HostManager } from './host-manager.js';
import { createPortsService, type SuccinixPortsService } from './ports.js';
import { checkSync } from './schema.js';
import { ServiceLifecycle } from './service-lifecycle.js';
import {
  createTerminalSession,
  createWorkspaceBackend,
  stateChanged,
} from './service-runtime.js';
import { makeServicesService } from './services-service.js';
import { SuccinixFileSystem } from './fs-service.js';
import { SuccinixSandboxService } from './sandbox-service.js';
import { SuccinixTerminalService } from './terminal-service.js';
import { SuccinixTerminalBackend } from './terminal-backend.js';
import { SuccinixSessionPersistence } from './persistence-service.js';
import type {
  Agent,
  FileSystem,
  SandboxProvider,
  SessionPersistence,
} from './dsh-types.js';
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
  SuccinixHostService,
  SuccinixPortEvent,
  SuccinixWorkspaceEvent,
} from './types.js';
import { createWorkspaceService, type SuccinixWorkspaceService } from './workspace.js';

export function createSuccinixHostService(ctx: Context, config: ResolvedSuccinixConfig, rawConfig: SuccinixConfig = {}): SuccinixHostService {
  const state = createInitialState();
  state.version = '0.6.0';
  state.containerMode = config.container.mode;
  let resolvedConfig = config;
  let raw = rawConfig;
  const capabilities = new SuccinixCapabilityRegistry(config.capabilities);
  state.capabilities = capabilities.list();

  let defaultId = defaultInstanceId(config);
  const manager: HostManager = getHostManager();
  state.configRevision = manager.beginService(rawConfig);
  const instances = new Map<string, SuccinixInstance>();
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const portUnsubs = new Set<() => void>();
  let lastState = cloneState(state);
  const liveOwners = new Set<Agent>();
  const ownerDisposeHandlers = new Map<Agent, Set<() => void | Promise<void>>>();

  const terminals = new SuccinixTerminalService({
    isOwnerLive: (owner) => liveOwners.has(owner),
    onOwnerDispose: (owner, handler) => {
      let set = ownerDisposeHandlers.get(owner);
      if (!set) {
        set = new Set();
        ownerDisposeHandlers.set(owner, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
        if (set?.size === 0) ownerDisposeHandlers.delete(owner);
      };
    },
  });
  const terminalBackend = new SuccinixTerminalBackend({
    createSession: (options) =>
      createTerminalSession(requireDefault(), requireWc(), resolvedConfig.terminal, options.output, options),
  });
  const unregisterTerminalBackend = terminals.registerBackend(terminalBackend);
  const fileSystem: FileSystem = new SuccinixFileSystem({
    getFs: () => manager.handle().wc?.fs,
    getClient: () => instances.get(defaultId)?.client,
    workspaceRoot: '/workspace',
    hostRoot: '/workspace',
  });
  const sandbox: SandboxProvider = new SuccinixSandboxService({
    available: () => manager.handle().state === 'ready' && manager.handle().wc !== null,
    workspaceRoot: '/workspace',
  });
  const sessionPersistence: SessionPersistence = new SuccinixSessionPersistence({
    getFs: () => manager.handle().wc?.fs,
    getClient: () => instances.get(defaultId)?.client,
    stateRoot: '/workspace/.succinix/sessions',
    onFlush: async () => {
      const wc = manager.handle().wc;
      const instance = instances.get(defaultId);
      if (wc && instance) await instance.persist.force(wc.fs, 'session-persistence');
    },
  });

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

  const publishWorkspace = (instanceId: string, reason: SuccinixWorkspaceEvent['reason'], savedAt?: number): void => {
    publish('succinix/workspace', { instanceId, reason, ...(savedAt !== undefined ? { savedAt } : {}) });
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
    publishWorkspace,
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
    wrapExecutorWithPython({
      instanceId,
      executor,
      nextId: () => nextCommandId(instanceId),
      publish: (payload) => publishCommand(payload),
      requireWc,
      pythonAssetsUrl: resolvedConfig.pythonAssetsUrl,
    });

  const pythonBeforeRpc = (beforeRpc: TerminalSessionOptions['beforeRpc'] = undefined) =>
    async (command: string): Promise<void> => {
      await beforeRpc?.(command);
      await ensurePythonForCommand(requireWc(), resolvedConfig.pythonAssetsUrl, command);
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

  const instanceManager = new SuccinixHostInstanceManager({
    instances,
    state,
    manager,
    resolvedConfig: () => resolvedConfig,
    defaultId: () => defaultId,
    requireWc,
    setError,
    wrapExecutor,
    pythonBeforeRpc,
    makeWorkspaceBackend,
    publish,
    emitState,
  });
  const ensureInstance = instanceManager.ensureInstance.bind(instanceManager);
  const releaseInstance = instanceManager.releaseInstance.bind(instanceManager);
  const listProcesses = instanceManager.listProcesses.bind(instanceManager);

  const service: SuccinixHostService = {
    get fs() {
      return fileSystem;
    },
    get sandbox() {
      return sandbox;
    },
    get terminals() {
      return terminals;
    },
    get sessionPersistence() {
      return sessionPersistence;
    },
    registerAgent(owner: Agent): void {
      if (liveOwners.has(owner)) throw new Error(`agent "${owner.id}" is already registered`);
      liveOwners.add(owner);
    },
    unregisterAgent(owner: Agent): void {
      if (!liveOwners.delete(owner)) return;
      for (const handler of ownerDisposeHandlers.get(owner) ?? []) {
        void handler();
      }
      ownerDisposeHandlers.delete(owner);
    },
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
      const instance = requireDefault();
      const persist = instance.persist;
      const view: PersistContext = {
        save: async (fs, force) => {
          const result = await persist.save(fs, force);
          publishWorkspace(instance.instanceId, result.reason === 'cleared' ? 'clear' : 'save', result.meta.savedAt || Date.now());
          return result;
        },
        load: async (fs) => {
          const meta = await persist.load(fs);
          publishWorkspace(instance.instanceId, 'restore', Date.now());
          return meta;
        },
        clear: async () => {
          await persist.clear();
          publishWorkspace(instance.instanceId, 'clear', Date.now());
        },
        meta: () => persist.meta(),
        force: async (fs, tag) => {
          await persist.force(fs, tag);
          publishWorkspace(instance.instanceId, 'flush', Date.now());
        },
      };
      return view;
    },
    get workspace() {
      requireDefault();
      return currentWorkspace;
    },
    get ports() {
      return currentPorts;
    },
    get services() {
      return makeServicesService(requireDefault(), requireWc());
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
    dispose: async () => {
      await lifecycle.dispose();
      unregisterTerminalBackend();
      await terminals.dispose();
    },
    shutdown: async () => {
      await lifecycle.shutdown();
      unregisterTerminalBackend();
      await terminals.dispose();
    },
    flush: () => lifecycle.flush(),
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
      capabilities.configure(nextResolved.capabilities);
      state.capabilities = capabilities.list();
      state.containerMode = nextResolved.container.mode;
      state.configRevision++;
      manager.markConfigRevision(state.configRevision, next);
      state.lastError = null;
      rebuildDefaultViews();
      if (restart) state.containerState = 'disposed';
      emitState('config');
    },
  };
  lifecycle.bindUpdateGuard(ctx, () => manager.appliedConfig());

  return service;
}

export type { SuccinixPortEvent };
