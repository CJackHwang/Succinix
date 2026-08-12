// app shell contract shared by the Succinix app plugins.
import type { Terminal } from '@xterm/xterm';
import type { WebContainer } from '@webcontainer/api';
import type {
  LocalCommandHandler,
  SuccinixInstance,
  SuccinixTerminalSession,
  TerminalClient,
  TerminalExecutor,
  TerminalOutput,
} from '@succinix/engine';
import type { BootUI } from '../boot-ui.js';
import type { CommandContext } from '../commands.js';
import type { TestResult } from '../tests.js';

export interface AppShell {
  instance: SuccinixInstance;
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
  executor: TerminalExecutor;
  term: Terminal;
  output: TerminalOutput;
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
  getOutput(): TerminalOutput;
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
  makeHandlers(): Record<string, LocalCommandHandler>;
}

export type { CommandContext };

export interface AppSnapshotService {
  attach(shell: AppShell): void;
}

export interface AppWatchdogService {
  attach(shell: AppShell): void;
}

export interface AppSelftestService {
  run(shell: AppShell): Promise<TestResult>;
}

export interface AppDevhooksService {
  attach(shell: AppShell): void;
}

export type { SuccinixTerminalSession };
