// invariant: ctx.succinix service contract + Context/Events type augmentation.
import type { WebContainer } from '@webcontainer/api';
import type {
  EngineBootHooks,
  ProcInfo,
  TerminalClient,
  TerminalExecutor,
} from '../engine/index.js';
import type { SuccinixInstanceOptions } from '../instance/index.js';
import type {
  SaveResult,
  PersistContext,
  SnapshotMeta,
} from '../persist.js';
import type {
  SuccinixTerminalSession,
  TerminalOutput,
  TerminalSessionOptions,
} from '../terminal/index.js';
import type { SuccinixConfig } from './config.js';
import type {
  SuccinixEventMap,
  SuccinixEventHandler,
  SuccinixPortEvent,
} from './events.js';
import type { SuccinixPluginState } from './state.js';

export type { SuccinixConfig } from './config.js';
export type { SuccinixPluginState, SuccinixStateReason } from './state.js';
export type {
  SuccinixEventMap,
  SuccinixEventHandler,
  SuccinixStateEvent,
  SuccinixPortEvent,
  SuccinixCommandEvent,
  SuccinixInstanceEvent,
  SuccinixWorkspaceEvent,
  SuccinixProcessEvent,
} from './events.js';
export type {
  CommandLogEntry,
  EngineBootHooks,
  ExecResult,
  ProcInfo,
  TerminalClient,
  TerminalExecutor,
} from '../engine/index.js';
export type {
  PersistContext,
  SaveResult,
  SnapshotMeta,
} from '../persist.js';
export type { SuccinixRestartContext } from '../instance/index.js';
export type {
  SuccinixTerminalSession,
  TerminalOutput,
  TerminalSessionOptions,
} from '../terminal/index.js';

export interface AttachOptions {
  output?: TerminalOutput;
  terminal?: TerminalSessionOptions;
  statePrefix?: string;
  home?: string;
  persistence?: SuccinixInstanceOptions['persistence'];
  executor?: EngineBootHooks;
  bootSteps?: SuccinixInstanceOptions['bootSteps'];
  bootUI?: SuccinixInstanceOptions['bootUI'];
  onRestart?: SuccinixInstanceOptions['onRestart'];
}

export interface BootOptions extends AttachOptions {
  instanceId?: string;
}

export type EnsureInstanceOptions = AttachOptions;

export interface SuccinixContainerHandle {
  readonly mode: 'internal' | 'external';
  readonly state: 'unattached' | 'booting' | 'ready' | 'disposed';
  readonly wc: WebContainer | null;
  readonly hostPid: number | null;
  readonly startedAt: number | null;
}

export interface SuccinixTerminalService {
  create(output: TerminalOutput, opts?: TerminalSessionOptions): SuccinixTerminalSession;
}

export interface SuccinixSnapshotService {
  save(force?: boolean): Promise<SaveResult>;
  restore(): Promise<void>;
  meta(): Promise<SnapshotMeta | null>;
  clear(): Promise<void>;
}

export type SuccinixPersistService = PersistContext;

export interface SuccinixWorkspaceView {
  restore(): Promise<void>;
  flush(tag?: string): Promise<void>;
  list(): Promise<unknown[]>;
  readonly stateRoot: string;
  readonly home: string;
}

export type SuccinixWorkspaceService = SuccinixWorkspaceView;

export interface SuccinixPortsService {
  list(): Map<number, string>;
  ready(port: number): string | undefined;
  onServerReady(handler: (payload: SuccinixPortEvent) => void): () => void;
  onServerClosed(handler: (payload: SuccinixPortEvent) => void): () => void;
  /** Reserve a port for the current instance before spawn (multi-instance attribution). */
  expect(port: number): void;
  /** Release a previously reserved port. */
  release(port: number): void;
  /** Return another instance id that already reserved this port, or null. */
  hasConflict(port: number): string | null;
}

export interface SuccinixServiceDefinition {
  name: string;
  command: string;
  port: number | null;
}

export interface SuccinixServiceState {
  def: SuccinixServiceDefinition;
  state: 'running' | 'stopped';
  pid?: number;
  effectivePort: number | null;
  url?: string;
}

export interface SuccinixServiceAction {
  ok: boolean;
  message: string;
  pid?: number;
}

export interface SuccinixServicesService {
  list(): Promise<SuccinixServiceState[]>;
  read(): Promise<SuccinixServiceDefinition[]>;
  status(name: string): Promise<SuccinixServiceState>;
  start(name: string): Promise<SuccinixServiceAction>;
  stop(name: string): Promise<SuccinixServiceAction>;
  enable(name: string): Promise<boolean>;
  disable(name: string): Promise<boolean>;
  add(name: string, command: string, port: number | null): Promise<void>;
  remove(name: string): Promise<boolean>;
  autostart(): Promise<string[]>;
  ensureFiles(): Promise<void>;
}

export type SuccinixCapabilityPattern =
  | 'terminal.exec'
  | 'terminal.spawn'
  | 'terminal.kill'
  | 'terminal.interrupt'
  | 'fs.read'
  | 'fs.write'
  | 'workspace.restore'
  | 'workspace.flush'
  | 'workspace.list';

export interface SuccinixCapabilityService {
  check(pattern: SuccinixCapabilityPattern): boolean;
  list(): SuccinixCapabilityPattern[];
  define(pattern: SuccinixCapabilityPattern, checker?: () => boolean): () => void;
}

export interface SuccinixInstance {
  instanceId: string;
  client: TerminalClient;
  terminal: SuccinixTerminalSession;
  executor: TerminalExecutor;
  persist: PersistContext;
  ports: Map<number, string>;
  statePrefix?: string;
  snapshot: { save(force?: boolean): Promise<unknown>; restore(): Promise<void> };
  services: SuccinixServicesService;
  workspace: SuccinixWorkspaceView;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SuccinixService {
  readonly state: SuccinixPluginState;
  readonly container: SuccinixContainerHandle;
  readonly executor: TerminalExecutor;
  readonly terminal: SuccinixTerminalService;
  readonly snapshot: SuccinixSnapshotService;
  readonly persist: SuccinixPersistService;
  readonly workspace: SuccinixWorkspaceService;
  readonly ports: SuccinixPortsService;
  readonly services: SuccinixServicesService;
  readonly capabilities: SuccinixCapabilityService;
  readonly instance: SuccinixInstance | null;

  attach(wc: WebContainer, opts?: AttachOptions): Promise<void>;
  boot(opts?: BootOptions): Promise<WebContainer>;
  ensureInstance(containerId: string, opts?: EnsureInstanceOptions): Promise<SuccinixInstance>;
  getInstance(containerId: string): SuccinixInstance | undefined;
  releaseInstance(containerId: string): Promise<void>;
  listProcesses(containerId?: string): Promise<ProcInfo[]>;

  on<K extends keyof SuccinixEventMap>(event: K, handler: SuccinixEventHandler<K>): () => void;
  onServerReady(handler: (payload: SuccinixPortEvent) => void): () => void;
  onServerClosed(handler: (payload: SuccinixPortEvent) => void): () => void;

  dispose(): Promise<void>;
  shutdown(): Promise<void>;
  flush(): Promise<void>;
  reconfigure(next: SuccinixConfig): Promise<void>;
}

declare module 'cordis' {
  interface Context {
    succinix: SuccinixService;
  }
}
