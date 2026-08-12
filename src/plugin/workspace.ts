// invariant: workspace facade over persist/instance paths.
import type { SuccinixWorkspaceService } from './types.js';

export interface WorkspaceBackend {
  restore(): Promise<void>;
  flush(tag?: string): Promise<void>;
  list(): Promise<unknown[]>;
}

export interface WorkspaceOptions {
  stateRoot: string;
  home: string;
  backend: WorkspaceBackend;
}

export function createWorkspaceService(opts: WorkspaceOptions): SuccinixWorkspaceService {
  return {
    restore: () => opts.backend.restore(),
    flush: (tag) => opts.backend.flush(tag),
    list: () => opts.backend.list(),
    stateRoot: opts.stateRoot,
    home: opts.home,
  };
}

export type { SuccinixWorkspaceService };
