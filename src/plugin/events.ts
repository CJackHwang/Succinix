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

/** Command lifecycle event emitted before execution begins. */
export interface SuccinixCommandStartEvent {
  id: string;
  instanceId: string;
  command: string;
  startedAt: number;
}

/** v0.7 command completion event. The legacy `succinix/command` event remains
 * an alias during the 0.7 migration window. */
export type SuccinixCommandFinishEvent = SuccinixCommandEvent;

export interface SuccinixRuntimeReadyEvent {
  runtime: 'node' | 'python' | 'lifo' | 'ruby' | 'wasi';
  instanceId?: string;
  loadedAt: number;
  cached: boolean;
}

export interface SuccinixDegradationEvent {
  code: string;
  message: string;
  runtime: string;
  retryable: boolean;
  degraded: true;
  instanceId?: string;
}

export interface SuccinixPersistenceEvent {
  instanceId: string;
  state: 'clean' | 'dirty' | 'saving' | 'saved' | 'quota-exceeded' | 'corrupt' | 'degraded';
  generation?: number;
  savedAt?: number;
  error?: string;
}

export interface SuccinixTerminalEvent {
  instanceId: string;
  sessionId: string;
  bootNonce: string;
}

export interface SuccinixTerminalBackpressureEvent extends SuccinixTerminalEvent {
  queuedBytes: number;
  limitBytes: number;
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
  'succinix/command-start': SuccinixCommandStartEvent;
  'succinix/command-finish': SuccinixCommandFinishEvent;
  'succinix/runtime-ready': SuccinixRuntimeReadyEvent;
  'succinix/degradation': SuccinixDegradationEvent;
  'succinix/persistence': SuccinixPersistenceEvent;
  'succinix/terminal-open': SuccinixTerminalEvent;
  'succinix/terminal-close': SuccinixTerminalEvent;
  'succinix/terminal-backpressure': SuccinixTerminalBackpressureEvent;
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
    'succinix/command-start'(event: SuccinixCommandStartEvent): void;
    'succinix/command-finish'(event: SuccinixCommandFinishEvent): void;
    'succinix/runtime-ready'(event: SuccinixRuntimeReadyEvent): void;
    'succinix/degradation'(event: SuccinixDegradationEvent): void;
    'succinix/persistence'(event: SuccinixPersistenceEvent): void;
    'succinix/terminal-open'(event: SuccinixTerminalEvent): void;
    'succinix/terminal-close'(event: SuccinixTerminalEvent): void;
    'succinix/terminal-backpressure'(event: SuccinixTerminalBackpressureEvent): void;
    'succinix/instance'(event: SuccinixInstanceEvent): void;
    'succinix/workspace'(event: SuccinixWorkspaceEvent): void;
    'succinix/process'(event: SuccinixProcessEvent): void;
  }
}
