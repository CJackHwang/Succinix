// invariant: @succinix/engine plugin entry ({ name, apply, Config }).
import type { Context } from '@deepseek-ai/cordis';
import {
  resolveConfig,
  SuccinixConfigSchema,
  type SuccinixConfig,
} from './config.js';
import { registerHostCapabilities } from './capabilities.js';
import { createSuccinixHostService } from './host-service.js';

export const name = 'succinix';
export const Config = SuccinixConfigSchema;

export function apply(ctx: Context, config: SuccinixConfig): void {
  const resolved = resolveConfig(config);
  const service = createSuccinixHostService(ctx, resolved, config);
  ctx.provide('succinix', service);
  ctx.provide('fs', service.fs);
  ctx.provide('sandbox', service.sandbox);
  ctx.provide('terminals', service.terminals);
  ctx.provide('sessionPersistence', service.sessionPersistence);
  const capabilityDisposers = registerHostCapabilities(ctx, service.capabilities);
  const pageListeners: Array<[EventTarget, string, EventListener]> = [];
  if (typeof window !== 'undefined') {
    const onPageHide = (event: Event) => {
      // bfcache 会保留页面和 host；其余 pagehide 必须在 WebContainer 销毁父页面前
      // 停止执行世界，否则真实 Node 服务可能在 host 退出后成为孤儿进程。
      if ('persisted' in event && event.persisted === true) {
        if (resolved.lifecycle.flushOnPageHide) void service.flush();
        return;
      }
      void service.shutdown();
    };
    const onBeforeUnload = () => {
      void service.shutdown();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    pageListeners.push([window, 'pagehide', onPageHide], [window, 'beforeunload', onBeforeUnload]);
  }
  ctx.effect(() => () => {
    for (const dispose of capabilityDisposers) dispose();
    for (const [target, type, listener] of pageListeners) target.removeEventListener(type, listener);
    return service.dispose();
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
export { ensureRubyRuntime, RUBY_RUNTIME_DIR, RUBY_RUNTIME_VERSION } from '../engine/index.js';
export {
  startRuntimeAssetBridge,
  RUNTIME_REQUEST_ROOT,
  type RuntimeAssetBridgeController,
  type RuntimeAssetBridgeOptions,
  startBrowserControlBridge,
  CONTROL_REQUEST_ROOT,
  type BrowserControlBridgeController,
  type BrowserControlBridgeHandlers,
  type BrowserControlBridgeOptions,
  type BrowserControlAction,
  type BrowserControlRequest,
  type BrowserControlResponse,
  TERMINAL_MAX_BUFFER_BYTES,
} from '../engine/index.js';
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
} from '../persist/index.js';
export {
  clearDbActivePorts,
  dbActivePortFor,
  setDbActivePort,
  SERVICE_TEMPLATES,
  serviceTemplate,
} from '../services/index.js';
export {
  PACKAGE_MANIFEST_PATH,
  PACKAGE_MANIFEST_VERSION,
  readPackageManifest,
  writePackageManifest,
  recordPackageInstall,
  recordPackageRemove,
  packageManifestJson,
} from '../pkg/index.js';
export type { InstalledPackage, PackageManifest, PackageManifestFs } from '../pkg/index.js';
export { DEFAULT_INSTANCE_BOOT_STEPS } from '../instance/index.js';
export type { TerminalOutput } from '../terminal/output.js';
export type { BootUI, LogKind } from '../terminal/ui.js';
export type {
  ResolvedSuccinixConfig,
  SuccinixCapabilityPattern,
} from './config.js';
export * from './types.js';
export {
  TerminalClient,
  createTerminalIdentity,
  RpcTerminalClient,
} from '../engine/index.js';
export type {
  BrowserRpcTerminalOptions,
  TerminalTransportFs,
} from '../engine/index.js';
export {
  USERLAND_PROFILE,
  USERLAND_DENY_EXIT_CODE,
  USERLAND_DENYLIST,
  defaultUserlandCapabilities,
  deniedCommandCapability,
  denylistedCommandResult,
  isDenylistedCommand,
  createUserlandRegistry,
} from '../userland/index.js';
export type {
  UserlandCommandStatus,
  UserlandRuntime,
  UserlandExecution,
  UserlandCommandCapability,
  UserlandCapabilitySnapshot,
  UserlandRegistry,
  UserlandCommandDefinition,
  UserlandPackageSource,
  UserlandServiceTemplate,
} from '../userland/index.js';
