// invariant: workspace facade over persist/instance paths (C2 wires real behavior).
import type { SuccinixWorkspaceService } from './types.js';

export interface WorkspaceOptions {
  stateRoot: string;
  home: string;
}

export function createWorkspaceService(opts: WorkspaceOptions): SuccinixWorkspaceService {
  return {
    async restore() {
      // C2: restore instance snapshot through ctx.succinix.snapshot.
    },
    async flush(_tag?: string) {
      // C2: force persist after workspace mutations.
    },
    async list() {
      return [];
    },
    stateRoot: opts.stateRoot,
    home: opts.home,
  };
}
