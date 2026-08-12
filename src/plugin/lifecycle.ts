// invariant: soft fiber dispose vs hard shutdown semantics.
import type { HostManager } from './host-manager.js';

export interface LifecycleOptions {
  disposeMode: 'soft' | 'hard';
  flushOnPageHide: boolean;
}

export interface SuccinixLifecycle {
  dispose(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createLifecycle(manager: HostManager, options: LifecycleOptions): SuccinixLifecycle {
  return {
    async dispose() {
      if (options.disposeMode === 'hard') await manager.shutdown();
    },
    async shutdown() {
      await manager.shutdown();
    },
  };
}
