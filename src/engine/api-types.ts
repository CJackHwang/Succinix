/** Public v0.7 execution and observability contracts.
 *
 * This file intentionally contains only data shapes.  It is safe to import
 * from browser code, WebContainer host adapters, and third-party userland
 * packages without pulling in either DOM or node APIs.
 */

export interface RpcTiming {
  queueMs: number;
  hostMs?: number;
  resultPollMs: number;
  totalMs: number;
}

export interface RuntimeErrorShape {
  code: string;
  message: string;
  runtime: string;
  retryable: boolean;
  degraded: boolean;
  details?: Record<string, unknown>;
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string | undefined>;
  instanceId?: string;
}

export interface SpawnOptions extends ExecOptions {
  detached?: boolean;
  interactive?: boolean;
  scope?: string;
}

export interface KillOptions {
  signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL';
  forceAfterMs?: number;
  instanceId?: string;
}

export interface ProcessListOptions {
  runtime?: string;
  scope?: string;
  instanceId?: string;
}

export interface RuntimeStatus {
  runtime: string;
  state: 'unavailable' | 'loading' | 'ready' | 'degraded' | 'failed';
  version?: string;
  cached?: boolean;
  error?: RuntimeErrorShape;
}

export interface PersistenceStatus {
  formatVersion: number;
  state: 'clean' | 'dirty' | 'saving' | 'saved' | 'quota-exceeded' | 'corrupt' | 'degraded';
  generation?: number;
  bytes?: number;
  lastSavedAt?: number;
  legacyDetected?: boolean;
}

export interface DegradationStatus extends RuntimeErrorShape {
  degraded: true;
}

export interface InteractiveTerminalOpenOptions {
  instanceId: string;
  cols: number;
  rows: number;
}

export interface InteractiveTerminalSession {
  readonly id: string;
  send(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  onData(listener: (data: string) => void): () => void;
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void>;
  close(): Promise<void>;
}

export interface InteractiveTerminalService {
  open(options: InteractiveTerminalOpenOptions): Promise<InteractiveTerminalSession>;
}
