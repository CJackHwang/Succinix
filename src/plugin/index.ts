// invariant: @succinix/engine plugin entry ({ name, apply, Config }).
import type { Context } from 'cordis';
import {
  resolveConfig,
  SuccinixConfigSchema,
  type SuccinixConfig,
} from './config.js';
import { registerHostCapabilities } from './capabilities.js';
import { getHostManager } from './host-manager.js';
import { createLifecycle } from './lifecycle.js';
import { createSuccinixService } from './services.js';

export const name = 'succinix';
export const Config = SuccinixConfigSchema;

export function apply(ctx: Context, config: SuccinixConfig): void {
  const resolved = resolveConfig(config);
  const service = createSuccinixService(ctx, resolved, config);
  ctx.provide('succinix', service);
  const capabilityDisposers = registerHostCapabilities(ctx, service.capabilities);
  const pageListeners: Array<[EventTarget, string, EventListener]> = [];
  if (typeof window !== 'undefined') {
    const onPageHide = () => {
      if (resolved.lifecycle.flushOnPageHide) void service.shutdown();
    };
    const onBeforeUnload = () => {
      void service.shutdown();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    pageListeners.push([window, 'pagehide', onPageHide], [window, 'beforeunload', onBeforeUnload]);
  }
  const lifecycle = createLifecycle(getHostManager(), resolved.lifecycle);
  ctx.effect(() => () => {
    for (const dispose of capabilityDisposers) dispose();
    for (const [target, type, listener] of pageListeners) target.removeEventListener(type, listener);
    void lifecycle.dispose();
    void service.dispose();
  });
}

const plugin = { name, apply, Config };
export default plugin;

export {
  resolveConfig,
  requiresRestart,
  SuccinixConfigSchema,
  CAPABILITY_PATTERNS,
} from './config.js';
export { ensurePythonRuntime } from '../engine/index.js';
export { tokenize } from '../engine/tokenize.js';
export {
  checkEnvironment,
  detectSystemInfo,
  initWorkspace,
  bootPhase,
  withRetry,
  bootWebContainerWithRetry,
  MAX_BOOT_ATTEMPTS,
  MAX_HOST_READY_ATTEMPTS,
  BOOT_BASE_STEPS,
  DEFAULT_BOOT_STEPS,
  type RetryHooks,
  type TerminalBoot,
  type TerminalBootOptions,
  type TerminalBootResult,
  type TerminalBootAppContext,
} from '../terminal/boot.js';
export {
  DEFAULT_INSTANCE_ID,
  INSTANCE_STATE_ROOT_PREFIX,
  instanceStateRoot,
  statePath,
  tinbaseDataDir,
  userHomePath,
} from '../instance/paths.js';
export { instancePorts } from '../instance/ports.js';
export {
  saveSnapshot,
  loadSnapshot,
  clearSnapshot,
  getSnapshotMeta,
  forcePersist,
  type PersistContext,
  type SnapshotMeta,
} from '../persist.js';
export {
  clearActivePorts,
  clearDbActivePorts,
  dbActivePortFor,
  setDbActivePort,
  ensureServicesFiles,
  enableAutostart,
  disableAutostart,
  getServiceState,
  listServiceStates,
  readAutostart,
  readServices,
  removeServiceDef,
  addServiceDef,
  startService,
  stopService,
  type ServiceContext,
} from '../services/index.js';
export { DEFAULT_INSTANCE_BOOT_STEPS } from '../instance/index.js';
export type {
  LocalCommandCtx,
  LocalCommandHandler,
  TerminalOutput,
  TerminalRpc,
  TerminalSessionOptions,
  SuccinixTerminalSession,
} from '../terminal/index.js';
export type { BootUI, LogKind } from '../terminal/ui.js';
export type {
  ResolvedSuccinixConfig,
  SuccinixCapabilityPattern,
} from './config.js';
export * from './types.js';
