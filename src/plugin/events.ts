// invariant: typed succinix/* app observability events + Cordis Events augmentation.
import type { SuccinixPluginState, SuccinixStateReason } from './state.js';

export interface SuccinixStateEvent {
  state: SuccinixPluginState;
  reason: SuccinixStateReason;
  changed: string[];
}

export interface SuccinixPortEvent {
  port: number;
  url?: string;
  instanceId?: string;
}

export interface SuccinixCommandEvent {
  id: string;
  instanceId: string;
  command: string;
  runtime: 'node' | 'lifo' | 'browser';
  exitCode: number | null;
  startedAt: number;
  durationMs: number;
  pid?: number;
  timedOut?: boolean;
  error?: string;
}

export interface SuccinixInstanceEvent {
  containerId: string;
  state: 'created' | 'released';
}

export interface SuccinixWorkspaceEvent {
  instanceId: string;
  reason: 'save' | 'restore' | 'clear' | 'flush';
  savedAt?: number;
}

export interface SuccinixProcessEvent {
  instanceId: string;
  processes: Array<{ pid: number; status: string; command: string }>;
}

export interface SuccinixEventMap {
  'succinix/state': SuccinixStateEvent;
  'succinix/server-ready': SuccinixPortEvent;
  'succinix/server-closed': SuccinixPortEvent;
  'succinix/command': SuccinixCommandEvent;
  'succinix/instance': SuccinixInstanceEvent;
  'succinix/workspace': SuccinixWorkspaceEvent;
  'succinix/process': SuccinixProcessEvent;
}

export type SuccinixEventHandler<K extends keyof SuccinixEventMap> = (payload: SuccinixEventMap[K]) => void;

declare module '@deepseek-ai/cordis' {
  interface Events {
    'succinix/state'(event: SuccinixStateEvent): void;
    'succinix/server-ready'(event: SuccinixPortEvent): void;
    'succinix/server-closed'(event: SuccinixPortEvent): void;
    'succinix/command'(event: SuccinixCommandEvent): void;
    'succinix/instance'(event: SuccinixInstanceEvent): void;
    'succinix/workspace'(event: SuccinixWorkspaceEvent): void;
    'succinix/process'(event: SuccinixProcessEvent): void;
  }
}
