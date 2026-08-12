// invariant: ctx.succinix service surface (C1 shape; C2 wires real behavior).
import type { Context } from 'cordis';
import type { ResolvedSuccinixConfig } from './config.js';
import { SuccinixCapabilityRegistry } from './capabilities.js';
import { instanceStateRoot } from '../instance/paths.js';
import { createPortsService } from './ports.js';
import { createInitialState } from './state.js';
import type {
  SuccinixEventMap,
  SuccinixEventHandler,
  SuccinixService,
} from './types.js';
import { createWorkspaceService } from './workspace.js';

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`${name} is implemented in engine 0.5.0 C2`);
  };
}

export function createSuccinixService(_ctx: Context, config: ResolvedSuccinixConfig): SuccinixService {
  const state = createInitialState();
  state.version = '0.5.0';
  state.containerMode = config.container.mode;
  const capabilities = new SuccinixCapabilityRegistry(config.capabilities);
  state.capabilities = capabilities.list();

  const instanceId = config.defaultInstance.instanceId;
  const ports = createPortsService(instanceId);
  const workspace = createWorkspaceService({
    stateRoot: instanceStateRoot(instanceId, config.defaultInstance.statePrefix),
    home: config.defaultInstance.home ?? '/workspace',
  });

  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const subscribe = <K extends keyof SuccinixEventMap>(event: K, handler: SuccinixEventHandler<K>): (() => void) => {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    const wrapped = handler as (payload: unknown) => void;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  };

  const unavailable = (name: string): never => {
    state.lastError = `${name} is unavailable before default instance creation`;
    throw new Error(state.lastError);
  };

  const service: SuccinixService = {
    state,
    container: {
      mode: config.container.mode,
      state: 'unattached',
      wc: null,
      hostPid: null,
      startedAt: null,
    },
    get executor() {
      return unavailable('executor');
    },
    terminal: {
      create: notImplemented('terminal.create'),
    },
    snapshot: {
      save: notImplemented('snapshot.save'),
      restore: notImplemented('snapshot.restore'),
      meta: notImplemented('snapshot.meta'),
      clear: notImplemented('snapshot.clear'),
    },
    persist: {
      save: notImplemented('persist.save'),
      load: notImplemented('persist.load'),
      clear: notImplemented('persist.clear'),
      meta: notImplemented('persist.meta'),
      force: notImplemented('persist.force'),
    },
    workspace,
    ports,
    services: {
      list: notImplemented('services.list'),
      start: notImplemented('services.start'),
      stop: notImplemented('services.stop'),
    },
    capabilities,
    instance: null,
    attach: async () => notImplemented('attach')(),
    boot: async () => notImplemented('boot')(),
    ensureInstance: async () => notImplemented('ensureInstance')(),
    getInstance: () => undefined,
    releaseInstance: async () => notImplemented('releaseInstance')(),
    listProcesses: async () => notImplemented('listProcesses')(),
    on: (event, handler) => subscribe(event, handler),
    onServerReady: (handler) => ports.onServerReady(handler),
    onServerClosed: (handler) => ports.onServerClosed(handler),
    dispose: async () => {
      state.containerState = 'disposed';
    },
    shutdown: async () => {
      state.containerState = 'disposed';
    },
    reconfigure: async () => notImplemented('reconfigure')(),
  };

  return service;
}
