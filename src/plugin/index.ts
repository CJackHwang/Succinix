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
export type {
  ResolvedSuccinixConfig,
  SuccinixCapabilityPattern,
} from './config.js';
export * from './types.js';
