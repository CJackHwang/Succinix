// File RPC v2 contracts shared by the browser client and the WebContainer host.
// Keep this module free of node/browser imports so protocol validation can be
// reused by both sides and by third-party clients.

export const RPC_PROTOCOL_VERSION = 2 as const;
export const LEGACY_RPC_PROTOCOL_VERSION = 1 as const;
export const RPC_CMD_FILE = '/cmd.json';
export const RPC_ERROR_FILE = '/rpc-error.json';

export type RpcRequestId = string | number;

export interface RpcTiming {
  queueMs: number;
  hostMs?: number;
  resultPollMs: number;
  totalMs: number;
}

export type RpcRuntimeHint = 'node' | 'python' | 'lifo' | 'protocol';

export interface RpcV2Envelope {
  protocolVersion: typeof RPC_PROTOCOL_VERSION;
  id: RpcRequestId;
  cmd: string;
  bootNonce: string;
  instanceId?: string;
  runtimeHint?: RpcRuntimeHint;
  opts?: Record<string, unknown>;
  queuedAt?: number;
}

export interface RpcDeliveryAck {
  protocolVersion: typeof RPC_PROTOCOL_VERSION;
  id: RpcRequestId;
  bootNonce: string;
  instanceId: string;
  acceptedAt: number;
}

export interface RpcStructuredError {
  code:
    | 'MALFORMED_JSON'
    | 'INVALID_REQUEST'
    | 'INVALID_REQUEST_ID'
    | 'UNSUPPORTED_PROTOCOL'
    | 'STALE_BOOT_NONCE';
  message: string;
  details?: Record<string, unknown>;
}

// IDs are embedded in result/ack filenames. Restricting the alphabet is both a
// protocol invariant and a path traversal boundary.
const RPC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidRpcRequestId(id: unknown): id is RpcRequestId {
  if (typeof id === 'number') return Number.isSafeInteger(id) && id >= 0;
  return typeof id === 'string' && RPC_ID_RE.test(id);
}

export function rpcIdText(id: RpcRequestId): string {
  if (!isValidRpcRequestId(id)) throw new Error('invalid RPC request id');
  return String(id);
}

export function rpcResultPath(id: RpcRequestId, leadingSlash = true): string {
  return `${leadingSlash ? '/' : ''}result-${rpcIdText(id)}.json`;
}

export function rpcAckPath(id: RpcRequestId, leadingSlash = true): string {
  return `${leadingSlash ? '/' : ''}ack-${rpcIdText(id)}.json`;
}

export function inferRuntimeHint(cmd: string, opts?: Record<string, unknown>): RpcRuntimeHint {
  if (cmd !== 'run' && cmd !== 'spawn') return 'protocol';
  const command = String(opts?.command ?? '').trim();
  if (/^(node|npm|npx)(\s|$)/.test(command)) return 'node';
  if (/^(python|python3|pip|pip3)(\s|$)/.test(command)) return 'python';
  return 'lifo';
}

/** A FIFO-bounded dedup set. Re-adding an id does not refresh its age. */
export class BoundedProcessedIds {
  private readonly values = new Set<string>();

  constructor(readonly limit = 2048) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('processed id limit must be a positive integer');
  }

  has(id: RpcRequestId): boolean {
    return this.values.has(rpcIdText(id));
  }

  add(id: RpcRequestId): void {
    const text = rpcIdText(id);
    if (this.values.has(text)) return;
    this.values.add(text);
    while (this.values.size > this.limit) {
      const oldest = this.values.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  get size(): number {
    return this.values.size;
  }
}

export function makeRpcRequestPrefix(random = Math.random, now = Date.now): string {
  const time = now().toString(36);
  const entropy = Math.floor(random() * 0x100000000)
    .toString(36)
    .padStart(7, '0');
  return `${time}-${entropy}`;
}

/** Generate a process/page scoped nonce.  It is deliberately not a UUID API so
 * the protocol also works in the WebContainer's small runtime. */
export function makeRpcBootNonce(random = Math.random, now = Date.now): string {
  return `boot-${makeRpcRequestPrefix(random, now)}-${Math.floor(random() * 0x100000000).toString(36)}`;
}
