// invariant: @succinix/engine plugin entry ({ name, apply, Config }).
import type { Context } from 'cordis';
import {
  resolveConfig,
  SuccinixConfigSchema,
  type SuccinixConfig,
} from './config.js';
import { getHostManager } from './host-manager.js';
import { createLifecycle } from './lifecycle.js';
import { createSuccinixService } from './services.js';

export const name = 'succinix';
export const Config = SuccinixConfigSchema;

export function apply(ctx: Context, config: SuccinixConfig): void {
  const resolved = resolveConfig(config);
  const service = createSuccinixService(ctx, resolved);
  ctx.provide('succinix', service);
  const lifecycle = createLifecycle(getHostManager(), resolved.lifecycle);
  ctx.effect(() => () => {
    void lifecycle.dispose();
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
