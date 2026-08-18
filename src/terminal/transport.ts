import type { ITerminal } from '@lifo-sh/core';
import {
  TERMINAL_FLUSH_MS,
  TERMINAL_FRAME_LIMIT,
  TERMINAL_HEARTBEAT_MS,
  TERMINAL_MAX_BUFFER_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  frameFile,
  mailboxPath,
  isTerminalIdentity,
  parseFrameSequence,
  TerminalBackpressureError,
  type TerminalIdentity,
  type TerminalInputFrame,
  type TerminalOutputFrame,
} from './transport-protocol.js';

/** Thin browser-side filesystem surface (WebContainer's wc.fs satisfies it). */
export interface TerminalTransportFs {
  readFile(path: string, encoding?: 'utf8'): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(path: string): Promise<Array<{ name: string; type?: string }>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm?(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
}

export interface BrowserRpcTerminalOptions {
  fs: TerminalTransportFs;
  identity: TerminalIdentity;
  cols?: number;
  rows?: number;
  pollMs?: number;
  maxBufferedBytes?: number;
  heartbeatMs?: number;
  onOutput?: (data: string) => void;
  onControl?: (control: TerminalOutputFrame['control'], frame: TerminalOutputFrame) => void;
  onBackpressure?: (bufferedBytes: number) => void;
}

/**
 * Browser/device half of the terminal mailbox.  It deliberately has no line
 * editor, history, command parser, or filesystem state: xterm supplies data
 * events and Lifo's Shell owns all interaction semantics in WebContainer.
 */
export class RpcTerminalClient implements ITerminal {
  readonly sessionId: string;
  readonly instanceId: string;
  private _bootNonce: string;

  private readonly fs: TerminalTransportFs;
  private readonly pollMs: number;
  private readonly maxBufferedBytes: number;
  private readonly heartbeatMs: number;
  private readonly output?: (data: string) => void;
  private readonly controlCallback?: (control: TerminalOutputFrame['control'], frame: TerminalOutputFrame) => void;
  private readonly backpressureCallback?: (bufferedBytes: number) => void;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly outputListeners = new Set<(data: string) => void>();
  // `InteractiveTerminalService.open()` must create the mailbox before it can
  // return its public session. The host can therefore deliver the first shell
  // prompt before callers register `onData`; retain that output until the
  // first subscriber exists instead of silently losing it.
  private readonly pendingInitialOutput: string[] = [];
  private pendingInitialOutputBytes = 0;
  private readonly pending: Array<{ type: TerminalInputFrame['type']; data?: string; cols?: number; rows?: number }> = [];
  private pendingBytes = 0;
  private inputSeq = 0;
  private outputSeq = 0;
  private receivedOutputBytes = 0;
  private _cols: number;
  private _rows: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private running = false;
  private disposed = false;
  private fenced = false;
  private openPromise: Promise<void> | null = null;
  private _backpressured = false;

  constructor(options: BrowserRpcTerminalOptions) {
    if (!isTerminalIdentity(options.identity)) throw new Error('invalid terminal identity');
    this.fs = options.fs;
    this.sessionId = options.identity.sessionId;
    this.instanceId = options.identity.instanceId;
    this._bootNonce = options.identity.bootNonce;
    this.pollMs = Math.max(1, options.pollMs ?? TERMINAL_FLUSH_MS);
    this.maxBufferedBytes = Math.max(1, options.maxBufferedBytes ?? TERMINAL_MAX_BUFFER_BYTES);
    this.heartbeatMs = Math.max(1, options.heartbeatMs ?? TERMINAL_HEARTBEAT_MS);
    this.output = options.onOutput;
    this.controlCallback = options.onControl;
    this.backpressureCallback = options.onBackpressure;
    this._cols = dimension(options.cols, 80);
    this._rows = dimension(options.rows, 24);
  }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }
  get bootNonce(): string { return this._bootNonce; }
  get bufferedBytes(): number { return this.pendingBytes; }
  get bufferedInitialOutputBytes(): number { return this.pendingInitialOutputBytes; }
  get discardedInitialOutputBytes(): number { return 0; }
  get backpressured(): boolean { return this._backpressured; }
  get isFenced(): boolean { return this.fenced; }
  get sentInputSequence(): number { return this.inputSeq; }
  get receivedOutputSequence(): number { return this.outputSeq; }
  get receivedOutputByteCount(): number { return this.receivedOutputBytes; }

  /** Create/renew the session mailbox and begin polling output frames. */
  async open(): Promise<void> {
    if (this.disposed) return;
    if (this.fenced) throw new Error('terminal session is fenced');
    if (this.openPromise) return this.openPromise;
    this.openPromise = (async () => {
      const dir = this.dir();
      await this.fs.mkdir(dir, { recursive: true });
      await atomicWrite(this.fs, mailboxPath(this.identity(), 'open.json'), JSON.stringify({
        ...this.identity(), type: 'open', cols: this._cols, rows: this._rows, lastAck: this.outputSeq,
      }));
      this.running = true;
      this.schedulePoll(0);
      this.scheduleHeartbeat();
    })().finally(() => { this.openPromise = null; });
    return this.openPromise;
  }

  write(data: string): void {
    if (this.output) {
      this.receivedOutputBytes += byteLength(data);
      this.output(data);
      return;
    }
    if (!this.output && this.outputListeners.size === 0) {
      const dataBytes = byteLength(data);
      const availableBytes = Math.max(0, this.maxBufferedBytes - this.pendingInitialOutputBytes);
      if (dataBytes > availableBytes) throw new TerminalBackpressureError(dataBytes, availableBytes);
      this.pendingInitialOutput.push(data);
      this.pendingInitialOutputBytes += dataBytes;
      this.receivedOutputBytes += dataBytes;
      return;
    }
    this.receivedOutputBytes += byteLength(data);
    for (const listener of [...this.outputListeners]) listener(data);
  }
  writeln(data: string): void { this.write(`${data}\r\n`); }

  /** ITerminal's callback is retained for embedders that feed device data via sendData(). */
  onData(callback: (data: string) => void): void { if (!this.disposed) this.dataListeners.add(callback); }
  removeDataListener(callback: (data: string) => void): void { this.dataListeners.delete(callback); }

  /** Output-side subscription used by the public interactive session facade. */
  onOutput(callback: (data: string) => void): () => void {
    if (this.disposed) return () => {};
    this.outputListeners.add(callback);
    if (this.pendingInitialOutput.length) {
      const initialOutput = this.pendingInitialOutput.splice(0);
      this.pendingInitialOutputBytes = 0;
      for (const data of initialOutput) callback(data);
    }
    return () => this.outputListeners.delete(callback);
  }

  /** xterm's onData handler should call this method. */
  async sendData(data: string): Promise<void> {
    if (this.disposed || !data) return;
    if (this.fenced) throw new Error('terminal session is fenced');
    await this.open();
    if (this.disposed) return;
    if (!this.enqueue({ type: 'input', data })) throw new Error('terminal input backpressure');
    for (const listener of [...this.dataListeners]) listener(data);
    await this.flushInput();
  }

  focus(): void { if (this.enqueue({ type: 'focus' })) void this.flushInput(); }
  clear(): void { if (this.enqueue({ type: 'clear' })) void this.flushInput(); }
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this._cols = dimension(cols, this._cols);
    this._rows = dimension(rows, this._rows);
    if (this.enqueue({ type: 'resize', cols: this._cols, rows: this._rows })) void this.flushInput();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.running || this.openPromise) {
      this.pending.length = 0;
      this.pendingBytes = 0;
      this.enqueue({ type: 'dispose' });
      await this.flushInput();
    }
    this.disposed = true;
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.inputTimer) clearTimeout(this.inputTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.pollTimer = this.inputTimer = this.heartbeatTimer = null;
    this.dataListeners.clear();
    this.outputListeners.clear();
    this.pendingInitialOutput.length = 0;
    this.pendingInitialOutputBytes = 0;
  }

  /** Re-open after a temporary browser disconnect while preserving output ack. */
  async reconnect(): Promise<void> {
    if (this.disposed) throw new Error('terminal is disposed');
    await this.open();
  }

  /** Stop accepting device bytes and remove the old mailbox before host death. */
  async fence(): Promise<void> {
    if (this.disposed || this.fenced) return;
    this.fenced = true;
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.inputTimer) clearTimeout(this.inputTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.pollTimer = this.inputTimer = this.heartbeatTimer = null;
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.updateBackpressure();
    await remove(this.fs, this.dir(), true);
  }

  /** Host respawn boundary: rotate the nonce so stale frames from the old
   * daemon can never be consumed by the replacement host. */
  async renewBootNonce(nonce = randomId()): Promise<void> {
    if (this.disposed) throw new Error('terminal is disposed');
    await this.fence();
    this._bootNonce = nonce;
    // Input sequence remains monotonic across nonce epochs; output sequence
    // restarts because a fresh host mailbox starts replay at output frame 1.
    this.outputSeq = 0;
    this.fenced = false;
    await this.open();
  }

  private enqueue(frame: { type: TerminalInputFrame['type']; data?: string; cols?: number; rows?: number }): boolean {
    if (this.disposed || this.fenced) return false;
    const dataBytes = frame.data ? byteLength(frame.data) : 0;
    if (dataBytes > this.maxBufferedBytes - this.pendingBytes) {
      this.updateBackpressure();
      return false;
    }
    if (frame.data && dataBytes > TERMINAL_FRAME_LIMIT) {
      for (const chunk of splitByBytes(frame.data, TERMINAL_FRAME_LIMIT)) this.push({ ...frame, data: chunk });
      this.updateBackpressure();
      void this.scheduleInputFlush();
      return true;
    }
    this.push(frame);
    this.updateBackpressure();
    void this.scheduleInputFlush();
    return true;
  }

  private push(frame: { type: TerminalInputFrame['type']; data?: string; cols?: number; rows?: number }): void {
    if (!frame.data && frame.type !== 'dispose') {
      const last = this.pending.at(-1);
      if (last?.type === frame.type) {
        Object.assign(last, frame);
        return;
      }
      const controlCount = this.pending.filter((item) => !item.data).length;
      if (controlCount >= 64) return;
    }
    this.pending.push(frame);
    this.pendingBytes += frame.data ? byteLength(frame.data) : 0;
  }

  private async scheduleInputFlush(): Promise<void> {
    if (this.pendingBytes >= TERMINAL_FRAME_LIMIT) void this.flushInput();
    else if (!this.inputTimer) this.inputTimer = setTimeout(() => void this.flushInput(), TERMINAL_FLUSH_MS);
  }

  private async flushInput(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.drainInput().finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  private async drainInput(): Promise<void> {
    if (this.inputTimer) clearTimeout(this.inputTimer);
    this.inputTimer = null;
    if (this.disposed || this.pending.length === 0) return;
    if (!this.running) {
      if (this.openPromise) await this.openPromise;
      else return;
    }
    while (this.pending.length && this.running && !this.disposed && !this.fenced) {
      const frameIdentity = this.identity();
      const frames: typeof this.pending = [];
      let bytes = 0;
      while (this.pending.length) {
        const frame = this.pending[0]!;
        const size = frame.data ? byteLength(frame.data) : 0;
        if (frames.length && bytes + size > TERMINAL_FRAME_LIMIT) break;
        this.pending.shift();
        frames.push(frame);
        bytes += size;
        this.pendingBytes -= size;
        if (bytes >= TERMINAL_FRAME_LIMIT) break;
      }
      try {
        for (const frame of frames) {
          const seq = ++this.inputSeq;
          await atomicWrite(this.fs, mailboxPath(frameIdentity, frameFile('in', seq)), JSON.stringify({
            ...frameIdentity, ...frame, seq,
          }));
        }
      } catch (error) {
        this.pending.unshift(...frames);
        this.pendingBytes += bytes;
        throw error;
      }
    }
    this.updateBackpressure();
    if (this.pending.length) this.inputTimer = setTimeout(() => void this.flushInput(), TERMINAL_FLUSH_MS);
  }

  private async poll(): Promise<void> {
    if (!this.running || this.disposed) return;
    const dir = this.dir();
    try {
      const entries = await this.fs.readdir(dir);
      const outputs = entries.map((e) => ({ name: e.name, seq: parseFrameSequence(e.name, 'out') })).filter((x): x is { name: string; seq: number } => x.seq !== null).sort((a, b) => a.seq - b.seq);
      for (const item of outputs) {
        const frame = await readJson(this.fs, `${dir}/${item.name}`) as TerminalOutputFrame | null;
        if (!frame || !isTerminalIdentity(frame) || !sameIdentity(frame, this.identity())) {
          await remove(this.fs, `${dir}/${item.name}`);
          continue;
        }
        if (frame.seq <= this.outputSeq) { await remove(this.fs, `${dir}/${item.name}`); continue; }
        if (frame.seq !== this.outputSeq + 1) break; // wait for replayed missing frame
        if (frame.data) this.write(frame.data);
        if (frame.control) this.controlCallback?.(frame.control, frame);
        if (frame.control === 'backpressure') this.backpressureCallback?.(typeof frame.bufferedBytes === 'number' ? frame.bufferedBytes : 0);
        this.outputSeq = frame.seq;
        await atomicWrite(this.fs, mailboxPath(this.identity(), 'ack.json'), JSON.stringify({ ...this.identity(), type: 'ack', ack: this.outputSeq }));
      }
    } catch {
      // A temporary mailbox read failure is a disconnect, not a shell error;
      // keep polling so a reconnect can resume from the last acknowledgement.
    }
    this.schedulePoll(this.pollMs);
  }

  private schedulePoll(delay: number): void {
    if (!this.running || this.disposed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }
  private scheduleHeartbeat(): void {
    if (!this.running || this.disposed || this.fenced) return;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.enqueue({ type: 'heartbeat' })) void this.flushInput().catch(() => {});
      this.scheduleHeartbeat();
    }, this.heartbeatMs);
  }
  private identity(): TerminalIdentity { return { protocolVersion: TERMINAL_PROTOCOL_VERSION, instanceId: this.instanceId, sessionId: this.sessionId, bootNonce: this.bootNonce }; }
  private dir(): string { return mailboxPath(this.identity(), 'open.json').slice(0, -'/open.json'.length); }
  private updateBackpressure(): void {
    const now = this.pendingBytes >= this.maxBufferedBytes;
    if (now === this._backpressured) return;
    this._backpressured = now;
    this.backpressureCallback?.(this.pendingBytes);
  }
}

export function createTerminalIdentity(instanceId: string, sessionId = randomId(), bootNonce = randomId()): TerminalIdentity {
  return { protocolVersion: TERMINAL_PROTOCOL_VERSION, instanceId, sessionId, bootNonce };
}

async function atomicWrite(fsys: TerminalTransportFs, path: string, text: string): Promise<void> {
  const temp = `${path}.tmp-${randomId()}`;
  await fsys.writeFile(temp, text);
  if (fsys.rename) await fsys.rename(temp, path);
  else await fsys.writeFile(path, text);
}
async function readJson(fsys: TerminalTransportFs, path: string): Promise<unknown> { try { return JSON.parse(await fsys.readFile(path, 'utf8')); } catch { return null; } }
async function remove(fsys: TerminalTransportFs, path: string, recursive = false): Promise<void> {
  try { await fsys.rm?.(path, { force: true, recursive }); } catch { /* consumed */ }
}
function sameIdentity(a: TerminalIdentity, b: TerminalIdentity): boolean { return a.protocolVersion === b.protocolVersion && a.instanceId === b.instanceId && a.sessionId === b.sessionId && a.bootNonce === b.bootNonce; }
function randomId(): string { const c = globalThis.crypto; if (c?.getRandomValues) { const b = new Uint32Array(3); c.getRandomValues(b); return [...b].map((n) => n.toString(36)).join('-'); } return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
function dimension(value: number | undefined, fallback: number): number { return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback; }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function splitByBytes(value: string, limit: number): string[] {
  if (byteLength(value) <= limit) return [value];
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const char of value) {
    const n = byteLength(char);
    if (chunk && bytes + n > limit) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += char;
    bytes += n;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
