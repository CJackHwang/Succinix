// invariant: default instance aggregation is a C2 implementation detail.
import type { SuccinixPluginState } from './state.js';
import type { EnsureInstanceOptions, SuccinixInstance } from './types.js';

export function defaultInstanceUnavailable(state: SuccinixPluginState): Error {
  return new Error(state.lastError ?? 'default instance is not available');
}

export async function createDefaultInstance(_opts: EnsureInstanceOptions): Promise<SuccinixInstance> {
  throw new Error('default instance aggregation is implemented in engine 0.5.0 C2');
}
