// invariant: soft dispose vs hard shutdown, port subscriptions, instance cleanup.
import type { Context } from 'cordis';
import { WebContainer, type WebContainer as WebContainerType } from '@webcontainer/api';
import type { EngineBootHooks } from '../engine/index.js';
import { pagePorts } from '../engine/ports.js';
import { instancePorts } from '../instance/ports.js';
import { clearActivePorts, clearDbActivePorts } from '../services/index.js';
import { SuccinixCapabilityRegistry } from './capabilities.js';
import { requiresRestart, type ResolvedSuccinixConfig, type SuccinixConfig } from './config.js';
import type { HostManager } from './host-manager.js';
import { loadBootAssets } from './service-runtime.js';
import type { SuccinixPluginState, SuccinixStateReason } from './state.js';
import type {
  BootOptions,
  EnsureInstanceOptions,
  SuccinixInstance,
  SuccinixPortEvent,
  SuccinixWorkspaceEvent,
} from './types.js';

export interface ServiceLifecycleDeps {
  instances: Map<string, SuccinixInstance>;
  state: SuccinixPluginState;
  manager: HostManager;
  capabilities(): SuccinixCapabilityRegistry;
  handlers: Map<string, Set<(payload: unknown) => void>>;
  portUnsubs: Set<() => void>;
  defaultId(): string;
  resolvedConfig(): ResolvedSuccinixConfig;
  emitState(reason: SuccinixStateReason): void;
  publish<K extends 'succinix/server-ready' | 'succinix/server-closed'>(event: K, payload: SuccinixPortEvent): void;
  publishWorkspace(instanceId: string, reason: SuccinixWorkspaceEvent['reason'], savedAt?: number): void;
}

export class ServiceLifecycle {
  private portEventsUnsub: (() => void) | null = null;
  private disposed = false;
  private shutdownDone = false;

  constructor(private readonly deps: ServiceLifecycleDeps) {}

  resetShutdownState(): void {
    this.shutdownDone = false;
  }

  /** Synchronous hard shutdown for restart-required fiber updates. */
  shutdownNow(): void {
    if (this.shutdownDone) return;
    this.shutdownDone = true;
    this.clearServiceSubscriptions();
    this.deps.capabilities().reset();
    this.deps.handlers.clear();
    this.deps.manager.shutdownSync();
    this.deps.state.containerState = 'disposed';
    this.deps.state.host = { pid: null, startedAt: null };
    this.deps.state.lastError = null;
  }

  /** Cordis fiber.update bypasses reconfigure(); guard restart-required configs. */
  bindUpdateGuard(ctx: Context, appliedConfig: () => SuccinixConfig | null): void {
    ctx.on('internal/update', (nextConfig: SuccinixConfig, _noSave: boolean, next: () => void) => {
      const previous = appliedConfig();
      if (previous && requiresRestart(previous, nextConfig)) this.shutdownNow();
      next();
    });
  }

  private resumeReady(): void {
    if (this.deps.state.containerState === 'ready' && this.portEventsUnsub) return;
    const handle = this.deps.manager.handle();
    this.deps.state.host = { pid: handle.hostPid, startedAt: handle.startedAt };
    this.deps.state.containerState = 'ready';
    this.deps.state.lastError = null;
    this.bindPortEvents();
    this.deps.emitState('ready');
  }

  async runManagerBoot(wc: WebContainerType, mode: 'internal' | 'external', hooks: EngineBootHooks = {}): Promise<void> {
    const config = this.deps.resolvedConfig();
    const assets = await loadBootAssets(config, hooks);
    const options = {
      mode,
      bootRetries: config.container.bootRetries,
      bootIntervalMs: config.container.bootIntervalMs,
      hostReadyDeadlineMs: config.container.hostReadyDeadlineMs,
      resultTtlMs: config.resultTtlMs,
      hostJsUrl: config.hostJsUrl,
      lifoCoreUrl: config.lifoCoreUrl,
      hostSrc: assets.hostSrc,
      lifoCoreSrc: assets.lifoCoreSrc,
    };
    if (mode === 'internal') await this.deps.manager.boot(wc, options);
    else await this.deps.manager.attach(wc, options);
    const handle = this.deps.manager.handle();
    this.deps.state.host = { pid: handle.hostPid, startedAt: handle.startedAt };
    this.deps.state.containerState = 'ready';
    this.deps.state.lastError = null;
    this.bindPortEvents();
    this.deps.emitState('ready');
  }

  async boot(opts: BootOptions = {}): Promise<WebContainerType> {
    const config = this.deps.resolvedConfig();
    if (config.container.mode !== 'internal') {
      throw new Error('ERR_MODE_MISMATCH: boot() requires internal container mode');
    }
    const handle = this.deps.manager.handle();
    if (handle.mode === 'external' && (handle.state === 'ready' || handle.state === 'booting')) {
      throw new Error('ERR_MODE_MISMATCH: container is already attached in external mode');
    }
    if (handle.state === 'ready' && handle.mode === 'internal' && handle.wc) {
      this.resumeReady();
      return handle.wc;
    }
    this.resetShutdownState();
    this.deps.state.containerState = 'booting';
    this.deps.state.lastError = null;
    this.deps.emitState('boot');

    let wc: WebContainerType | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < config.container.bootRetries; attempt++) {
      try {
        wc = await WebContainer.boot();
        break;
      } catch (error) {
        lastError = error;
        if (attempt < config.container.bootRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, config.container.bootIntervalMs));
        }
      }
    }
    if (!wc) {
      this.deps.state.containerState = 'unattached';
      this.deps.state.lastError = `WebContainer boot failed: ${String(lastError)}`;
      this.deps.emitState('error');
      throw new Error(this.deps.state.lastError);
    }
    try {
      await this.runManagerBoot(wc, 'internal', opts.executor ?? {});
    } catch (error) {
      this.deps.state.containerState = 'unattached';
      this.deps.state.lastError = `host boot failed: ${String(error)}`;
      this.deps.emitState('error');
      throw error;
    }
    return this.deps.manager.handle().wc ?? wc;
  }

  async attach(wc: WebContainerType, opts: EnsureInstanceOptions = {}): Promise<void> {
    const config = this.deps.resolvedConfig();
    if (config.container.mode !== 'external') {
      throw new Error('ERR_MODE_MISMATCH: attach() requires external container mode');
    }
    const handle = this.deps.manager.handle();
    if (handle.mode === 'internal' && (handle.state === 'ready' || handle.state === 'booting')) {
      throw new Error('ERR_MODE_MISMATCH: container is already booted in internal mode');
    }
    if (handle.state === 'ready' && handle.mode === 'external') {
      this.resumeReady();
      return;
    }
    this.resetShutdownState();
    this.deps.state.containerState = 'booting';
    this.deps.state.lastError = null;
    this.deps.emitState('boot');
    try {
      await this.runManagerBoot(wc, 'external', opts.executor ?? {});
    } catch (error) {
      this.deps.state.containerState = 'unattached';
      this.deps.state.lastError = `host boot failed: ${String(error)}`;
      this.deps.emitState('error');
      throw error;
    }
  }

  bindPortEvents(): void {
    if (this.portEventsUnsub) return;
    this.portEventsUnsub = pagePorts.subscribe('succinix', {
      onServerReady: (port, url) => {
        const instanceId = [...this.deps.instances.keys()].find((id) => instancePorts.expects(id, port));
        this.deps.publish('succinix/server-ready', instanceId ? { port, url, instanceId } : { port, url });
      },
      onServerClosed: (port) => {
        const instanceId = [...this.deps.instances.keys()].find((id) => instancePorts.expects(id, port));
        this.deps.publish('succinix/server-closed', instanceId ? { port, instanceId } : { port });
      },
    });
  }

  clearServiceSubscriptions(): void {
    for (const unsubscribe of this.deps.portUnsubs) {
      try {
        unsubscribe();
      } catch {
        /* already removed */
      }
    }
    this.deps.portUnsubs.clear();
    if (this.portEventsUnsub) {
      try {
        this.portEventsUnsub();
      } catch {
        /* already removed */
      }
      this.portEventsUnsub = null;
    }
    pagePorts.unsubscribe(this.deps.defaultId());
  }

  private async clearInstances(): Promise<void> {
    const pending = [...this.deps.instances.values()];
    for (const instance of pending) await instance.dispose();
    this.deps.instances.clear();
    this.deps.state.instances = [];
    for (const id of pending.map((instance) => instance.instanceId)) {
      instancePorts.releaseAll(id);
      clearActivePorts(id);
      clearDbActivePorts(id);
    }
  }

  /** Best-effort flush of every live instance; pagehide and shutdown use this. */
  async flush(): Promise<void> {
    const wc = this.deps.manager.handle().wc;
    if (!wc) return;
    await Promise.all([...this.deps.instances.values()].map(async (instance) => {
      try {
        await instance.persist.force(wc.fs, 'flush');
        this.deps.publishWorkspace(instance.instanceId, 'flush', Date.now());
      } catch {
        /* page unload cannot block on persistence errors */
      }
    }));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.deps.resolvedConfig().lifecycle.disposeMode === 'hard') {
      await this.flush();
    }
    await this.clearInstances();
    this.clearServiceSubscriptions();
    this.deps.capabilities().reset();
    this.deps.handlers.clear();
    if (this.deps.resolvedConfig().lifecycle.disposeMode === 'hard') {
      await this.deps.manager.shutdown();
      this.deps.state.containerState = 'disposed';
      this.deps.state.host = { pid: null, startedAt: null };
    }
    this.deps.emitState('shutdown');
  }

  async shutdown(): Promise<void> {
    if (this.shutdownDone) return;
    this.shutdownDone = true;
    await this.flush();
    await this.clearInstances();
    this.clearServiceSubscriptions();
    this.deps.capabilities().reset();
    this.deps.handlers.clear();
    pagePorts.reset();
    instancePorts.clear();
    await this.deps.manager.shutdown();
    this.deps.state.containerState = 'disposed';
    this.deps.state.host = { pid: null, startedAt: null };
    this.deps.state.lastError = null;
    this.deps.emitState('shutdown');
  }
}
