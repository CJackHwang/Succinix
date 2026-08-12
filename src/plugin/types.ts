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
import type { ServiceActionResult, ServiceState } from '../services/index.js';
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

export interface AttachOptions {
  output?: TerminalOutput;
  terminal?: TerminalSessionOptions;
  statePrefix?: string;
  home?: string;
  persistence?: SuccinixInstanceOptions['persistence'];
  executor?: EngineBootHooks;
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
}

export interface SuccinixServicesService {
  list(): Promise<ServiceState[]>;
  start(name: string): Promise<ServiceActionResult>;
  stop(name: string): Promise<ServiceActionResult>;
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
  reconfigure(next: SuccinixConfig): Promise<void>;
}

declare module 'cordis' {
  interface Context {
    succinix: SuccinixService;
  }
}
