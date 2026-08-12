// invariant: default instance identity and unavailable-state helpers.
import type { ResolvedSuccinixConfig } from './config.js';
import type { SuccinixPluginState } from './state.js';

export function defaultInstanceUnavailable(state: SuccinixPluginState): Error {
  return new Error(state.lastError ?? 'default instance is not available');
}

export function defaultInstanceId(config: ResolvedSuccinixConfig): string {
  return config.defaultInstance.instanceId || 'default';
}
