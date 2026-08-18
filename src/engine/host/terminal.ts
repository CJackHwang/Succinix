import type { ITerminal } from '@lifo-sh/core';
import {
  TERMINAL_FLUSH_MS,
  TERMINAL_FRAME_LIMIT,
  TERMINAL_MAX_BUFFER_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  frameFile,
  hostMailboxPath,
  isTerminalIdentity,
  TerminalBackpressureError,
  type TerminalIdentity,
  type TerminalOutputFrame,
} from '../../terminal/transport-protocol.js';
import {
  byteLength,
  clampDimension,
  dirname,
  nodeFs,
  splitByBytes,
  type TerminalMailboxFs,
} from './terminal-mailbox-utils.js';

export type { TerminalMailboxFs } from './terminal-mailbox-utils.js';

export interface RpcTerminalOptions {
  fs?: TerminalMailboxFs;
  /** Output frames waiting for browser acknowledgement are retained on disk. */
  maxBufferedBytes?: number;
  onBackpressure?: (bufferedBytes: number) => void;
  onResize?: (cols: number, rows: number) => void;
}

/**
 * Host-side implementation of Lifo's public ITerminal contract.
 *
 * It has no shell/editor/history semantics.  It only translates terminal
 * device operations to mailbox frames and delivers browser input to Lifo's
 * Shell through onData().
 */
export class RpcTerminal implements ITerminal {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly bootNonce: string;

  private readonly mailboxFs: TerminalMailboxFs;
  private readonly maxBufferedBytes: number;
  private readonly listeners = new Set<(data: string) => void>();
  private readonly earlyInput: string[] = [];
  private readonly pending: string[] = [];
  private readonly outputBytesBySeq = new Map<number, number>();
  private pendingBytes = 0;
  private outstandingBytes = 0;
  private discardedBytes = 0;
  private earlyInputBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private outputSeq = 0;
  private _cols: number;
  private _rows: number;
  private _disposed = false;
  private _backpressured = false;

  constructor(identity: TerminalIdentity, options: RpcTerminalOptions = {}, dimensions = { cols: 80, rows: 24 }) {
    if (!isTerminalIdentity(identity)) throw new Error('invalid terminal identity');
    this.sessionId = identity.sessionId;
    this.instanceId = identity.instanceId;
    this.bootNonce = identity.bootNonce;
    this.mailboxFs = options.fs ?? nodeFs;
    this.maxBufferedBytes = options.maxBufferedBytes ?? TERMINAL_MAX_BUFFER_BYTES;
    this._cols = clampDimension(dimensions.cols, 80);
    this._rows = clampDimension(dimensions.rows, 24);
    this.onBackpressure = options.onBackpressure;
    this.onResize = options.onResize;
  }

  private readonly onBackpressure?: (bufferedBytes: number) => void;
  private readonly onResize?: (cols: number, rows: number) => void;

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }
  get disposed(): boolean { return this._disposed; }
  get bufferedBytes(): number { return this.pendingBytes; }
  get unacknowledgedBytes(): number { return this.outstandingBytes; }
  get discardedOutputBytes(): number { return this.discardedBytes; }
  get backpressured(): boolean { return this._backpressured; }

  write(data: string): void {
    if (this._disposed || !data) return;
    // Output which has not been acknowledged also occupies the session budget.
    // ITerminal.write() is synchronous, so the only available producer-control
    // contract is deterministic refusal of the tail once that budget is full.
    const dataBytes = byteLength(data);
    const availableBytes = this.availableBytes();
    if (dataBytes > availableBytes) {
      this.setBackpressure();
      throw new TerminalBackpressureError(dataBytes, availableBytes);
    }
    for (const chunk of splitByBytes(data, TERMINAL_FRAME_LIMIT)) {
      this.pending.push(chunk);
      this.pendingBytes += byteLength(chunk);
    }
    this.updateBackpressure();
    if (this.pendingBytes >= TERMINAL_FRAME_LIMIT) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), TERMINAL_FLUSH_MS);
  }

  writeln(data: string): void { this.write(`${data}\r\n`); }

  onData(callback: (data: string) => void): void {
    if (this._disposed) return;
    this.listeners.add(callback);
    // Mailbox polling may receive paste/input immediately after open while
    // Sandbox.create() is still wiring Shell.onData. Replay those bytes once
    // the Lifo terminal seam is attached instead of losing the first keystroke.
    if (this.earlyInput.length) {
      const queued = this.earlyInput.splice(0);
      this.earlyInputBytes = 0;
      for (const data of queued) callback(data);
    }
  }

  /** Internal detach hook used by TerminalHub; ITerminal keeps onData void. */
  removeDataListener(callback: (data: string) => void): void {
    this.listeners.delete(callback);
  }

  /** Called by TerminalMailboxHost for an input frame. */
  acceptInput(data: string): void {
    if (this._disposed || !data) return;
    if (this.listeners.size === 0) {
      const dataBytes = byteLength(data);
      const availableBytes = Math.max(0, this.maxBufferedBytes - this.earlyInputBytes);
      if (dataBytes > availableBytes) throw new TerminalBackpressureError(dataBytes, availableBytes);
      this.earlyInput.push(data);
      this.earlyInputBytes += dataBytes;
      return;
    }
    for (const listener of [...this.listeners]) listener(data);
  }

  focus(): void { this.control('focus'); }
  clear(): void { this.control('clear'); }

  resize(cols: number, rows: number): void {
    if (this._disposed) return;
    this._cols = clampDimension(cols, this._cols);
    this._rows = clampDimension(rows, this._rows);
    this.onResize?.(this._cols, this._rows);
    this.control('resize', undefined, this._cols, this._rows);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.outputBytesBySeq.clear();
    this.outstandingBytes = 0;
    this.earlyInput.length = 0;
    this.earlyInputBytes = 0;
    this.listeners.clear();
    this.updateBackpressure();
  }

  /** Flush output synchronously so host's mailbox loop can be fire-and-forget. */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this._disposed || this.pending.length === 0) return;
    let chunk = '';
    let chunkBytes = 0;
    while (this.pending.length) {
      const next = this.pending[0]!;
      const nextBytes = byteLength(next);
      if (chunk && chunkBytes + nextBytes > TERMINAL_FRAME_LIMIT) break;
      this.pending.shift();
      chunk += next;
      chunkBytes += nextBytes;
      this.pendingBytes -= nextBytes;
      if (chunkBytes >= TERMINAL_FRAME_LIMIT) break;
    }
    if (chunk) {
      const seq = ++this.outputSeq;
      this.outputBytesBySeq.set(seq, chunkBytes);
      this.outstandingBytes += chunkBytes;
      this.writeFrame({ type: 'output', seq, data: chunk });
    }
    this.updateBackpressure();
    if (this.pending.length) this.flushTimer = setTimeout(() => this.flush(), TERMINAL_FLUSH_MS);
  }

  private control(control: TerminalOutputFrame['control'], data?: string, cols?: number, rows?: number, bufferedBytes?: number): void {
    if (this._disposed) return;
    this.writeFrame({ type: 'output', seq: ++this.outputSeq, control, data, cols, rows, bufferedBytes });
  }

  private writeFrame(frame: Omit<TerminalOutputFrame, keyof TerminalIdentity>): void {
    const identity = this.identity();
    const file = hostMailboxPath(identity, frameFile('out', frame.seq));
    const temp = `${file}.tmp-${Math.random().toString(36).slice(2)}`;
    this.mailboxFs.mkdirSync(dirname(file), { recursive: true });
    this.mailboxFs.writeFileSync(temp, JSON.stringify({ ...identity, protocolVersion: TERMINAL_PROTOCOL_VERSION, ...frame }));
    this.mailboxFs.renameSync(temp, file);
  }

  private identity(): TerminalIdentity {
    return { protocolVersion: TERMINAL_PROTOCOL_VERSION, sessionId: this.sessionId, instanceId: this.instanceId, bootNonce: this.bootNonce };
  }

  private updateBackpressure(): void {
    const now = this.pendingBytes + this.outstandingBytes >= this.maxBufferedBytes;
    if (now === this._backpressured) return;
    this._backpressured = now;
    this.onBackpressure?.(this.pendingBytes);
    if (!this._disposed) this.control('backpressure', undefined, undefined, undefined, this.pendingBytes);
  }

  private setBackpressure(): void {
    if (!this._backpressured) {
      this._backpressured = true;
      this.onBackpressure?.(this.pendingBytes + this.outstandingBytes);
      if (!this._disposed) this.control('backpressure', undefined, undefined, undefined, this.pendingBytes + this.outstandingBytes);
    }
  }

  /** The mailbox host calls this only after validating a browser ACK. */
  acknowledge(sequence: number): void {
    for (const [seq, bytes] of this.outputBytesBySeq) {
      if (seq > sequence) continue;
      this.outputBytesBySeq.delete(seq);
      this.outstandingBytes -= bytes;
    }
    this.updateBackpressure();
  }

  private availableBytes(): number {
    return Math.max(0, this.maxBufferedBytes - this.pendingBytes - this.outstandingBytes);
  }
}

export { TERMINAL_MAILBOX_ROOT } from '../../terminal/transport-protocol.js';
export {
  TerminalMailboxHost,
  type TerminalMailboxFactory,
  type TerminalMailboxHostOptions,
} from './terminal-mailbox-host.js';
