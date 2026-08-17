// app shell contract shared by the Succinix app plugins.
import type { Terminal } from '@xterm/xterm';
import type { WebContainer } from '@webcontainer/api';
import type {
  SuccinixInstance,
  TerminalClient,
  TerminalExecutor,
  RpcTerminalClient,
  RuntimeAssetBridgeController,
} from '@succinix/engine';
import type { BootUI } from '../boot-ui.js';
import type { CommandContext } from '../commands/index.js';
import type { TestResult } from '../selftest/index.js';

export interface AppShell {
  instance: SuccinixInstance;
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
  executor: TerminalExecutor;
  /** Thin browser device endpoint for the WebContainer-native Lifo shell. */
  interactive: RpcTerminalClient;
  runtimeAssets: RuntimeAssetBridgeController;
  term: Terminal;
  ui: BootUI;
  instanceId: string;
  userId?: string;
  fit(): void;
  saveSnapshot(force?: boolean): Promise<unknown>;
  onInstanceReset(): Promise<void>;
  onInstanceStop(): Promise<void>;
}

export interface AppTerminalService {
  getTerm(): Terminal;
  fit(): void;
  wire(shell: AppShell): void;
}

export interface AppContainerService {
  start(): Promise<AppShell | null>;
  getShell(): AppShell | null;
}

export interface AppShellService {
  getShell(): AppShell | null;
  setShell(shell: AppShell | null): void;
}

export interface AppCommandsService {
  attach(shell: AppShell): CommandContext;
}

export type { CommandContext };

export interface AppSnapshotService {
  attach(shell: AppShell): void;
  stop(): void;
}

export interface AppWatchdogService {
  attach(shell: AppShell): void;
  stop(): void;
}

export interface AppSelftestService {
  run(shell: AppShell): Promise<TestResult>;
}

export interface AppDevhooksService {
  attach(shell: AppShell): void;
}
