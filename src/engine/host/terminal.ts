import type { ITerminal } from '@lifo-sh/core';
import {
  TERMINAL_FLUSH_MS,
  TERMINAL_FRAME_LIMIT,
  TERMINAL_MAILBOX_ROOT,
  TERMINAL_MAX_BUFFER_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  TERMINAL_SESSION_TTL_MS,
  frameFile,
  hostMailboxPath,
  isTerminalIdentity,
  parseFrameSequence,
  type TerminalAckFrame,
  TerminalBackpressureError,
  type TerminalIdentity,
  type TerminalInputFrame,
  type TerminalOpenFrame,
  type TerminalOutputFrame,
} from '../../terminal/transport-protocol.js';
import {
  byteLength,
  clampDimension,
  decodePathPart,
  dirname,
  nodeFs,
  readJson,
  rootPath,
  sameIdentity,
  splitByBytes,
  unlinkQuiet,
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

export interface TerminalMailboxFactory {
  (open: TerminalOpenFrame, options: { fs: TerminalMailboxFs }): RpcTerminal;
}

export interface TerminalMailboxHostOptions {
  fs?: TerminalMailboxFs;
  onSessionClose?: (identity: TerminalIdentity, terminal: RpcTerminal) => void;
  sessionTtlMs?: number;
  now?: () => number;
}

interface HostSession {
  identity: TerminalIdentity;
  terminal: RpcTerminal;
  lastInput: number;
  lastAck: number;
  lastSeenAt: number;
}

/** Host-side mailbox scanner. Call poll() from the existing 50 ms host loop. */
export class TerminalMailboxHost {
  private readonly mailboxFs: TerminalMailboxFs;
  private readonly onSessionClose?: (identity: TerminalIdentity, terminal: RpcTerminal) => void;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, HostSession>();
  // 浏览器可能在创建邮箱目录后、原子发布 open frame 前崩溃。这类路径没有
  // HostSession，需要独立的有界观察窗口。
  private readonly orphanedAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly factory: TerminalMailboxFactory, options: TerminalMailboxHostOptions = {}) {
    this.mailboxFs = options.fs ?? nodeFs;
    this.onSessionClose = options.onSessionClose;
    this.sessionTtlMs = Math.max(1, options.sessionTtlMs ?? TERMINAL_SESSION_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  start(intervalMs = 16): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), Math.max(1, intervalMs));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sessions.values()) {
      s.terminal.dispose();
      this.onSessionClose?.(s.identity, s.terminal);
    }
    this.sessions.clear();
    this.orphanedAt.clear();
  }

  sessionCount(): number { return this.sessions.size; }

  poll(): number {
    let handled = 0;
    const root = TERMINAL_MAILBOX_ROOT.slice(1);
    this.dropMissingOrphans();
    let instances: string[];
    try { instances = this.mailboxFs.readdirSync(root); } catch { return 0; }
    for (const encodedInstanceId of instances) {
      const instanceId = decodePathPart(encodedInstanceId);
      if (!instanceId) {
        this.pruneOrphan(`${root}/${encodedInstanceId}`);
        continue;
      }
      let sessions: string[];
      try { sessions = this.mailboxFs.readdirSync(`${root}/${encodedInstanceId}`); } catch { continue; }
      for (const encodedSessionId of sessions) {
        const sessionId = decodePathPart(encodedSessionId);
        const dir = `${root}/${encodedInstanceId}/${encodedSessionId}`;
        if (!sessionId) {
          this.pruneOrphan(dir);
          continue;
        }
        let canonicalDir: string;
        try {
          canonicalDir = rootPath(instanceId, sessionId);
        } catch {
          this.pruneOrphan(dir);
          continue;
        }
        if (canonicalDir !== dir) {
          this.pruneOrphan(dir);
          continue;
        }
        handled += this.pollSession(canonicalDir, instanceId, sessionId);
      }
    }
    return handled;
  }

  private pollSession(dir: string, instanceId: string, sessionId: string): number {
    let names: string[];
    try { names = this.mailboxFs.readdirSync(dir); } catch { return 0; }
    let handled = 0;
    const openName = names.includes('open.json') ? 'open.json' : null;
    if (openName) {
      const open = readJson(this.mailboxFs, `${dir}/${openName}`) as TerminalOpenFrame | null;
      if (open && isTerminalIdentity(open) && open.type === 'open' && open.instanceId === instanceId && open.sessionId === sessionId) {
        this.orphanedAt.delete(dir);
        const key = `${instanceId}/${sessionId}`;
        const old = this.sessions.get(key);
        if (!old || old.identity.bootNonce !== open.bootNonce) {
          if (old) {
            old.terminal.dispose();
            // A reconnect/host-respawn replaces the device endpoint.  Detach
            // the old endpoint before attaching the new nonce so callbacks
            // and mailbox ownership do not leak across sessions.
            this.onSessionClose?.(old.identity, old.terminal);
          }
          const terminal = this.factory(open, { fs: this.mailboxFs });
          this.sessions.set(key, {
            identity: { protocolVersion: TERMINAL_PROTOCOL_VERSION, instanceId, sessionId, bootNonce: open.bootNonce },
            terminal,
            lastInput: 0,
            lastAck: open.lastAck ?? 0,
            lastSeenAt: this.now(),
          });
        } else {
          const state = this.sessions.get(key);
          if (state && typeof open.lastAck === 'number' && Number.isFinite(open.lastAck) && open.lastAck > state.lastAck) {
            state.lastAck = Math.floor(open.lastAck);
            state.terminal.acknowledge(state.lastAck);
            for (const name of names) {
              const seq = parseFrameSequence(name, 'out');
              if (seq !== null && seq <= state.lastAck) unlinkQuiet(this.mailboxFs, `${dir}/${name}`);
            }
          }
        }
        handled++;
      }
    }
    const key = `${instanceId}/${sessionId}`;
    const state = this.sessions.get(key);
    if (!state) {
      this.pruneOrphan(dir);
      return handled;
    }
    if (this.now() - state.lastSeenAt > this.sessionTtlMs) {
      this.closeSession(key, dir, state);
      return handled;
    }
    const ack = readJson(this.mailboxFs, `${dir}/ack.json`) as TerminalAckFrame | null;
    if (ack && isTerminalIdentity(ack) && ack.type === 'ack' && sameIdentity(ack, state.identity)) {
      this.applyAck(state, dir, names, ack.ack);
      state.lastSeenAt = this.now();
      unlinkQuiet(this.mailboxFs, `${dir}/ack.json`);
      handled++;
    }
    const inputs = names.map((name) => ({ name, seq: parseFrameSequence(name, 'in') })).filter((x): x is { name: string; seq: number } => x.seq !== null).sort((a, b) => a.seq - b.seq);
    for (const input of inputs) {
      const frame = readJson(this.mailboxFs, `${dir}/${input.name}`) as TerminalInputFrame | null;
      if (!frame || !isTerminalIdentity(frame) || !sameIdentity(frame, state.identity)) {
        unlinkQuiet(this.mailboxFs, `${dir}/${input.name}`);
        continue;
      }
      if (frame.seq <= state.lastInput) {
        unlinkQuiet(this.mailboxFs, `${dir}/${input.name}`);
        continue;
      }
      try {
        if (frame.type === 'input') state.terminal.acceptInput(frame.data ?? '');
        else if (frame.type === 'resize') state.terminal.resize(frame.cols ?? state.terminal.cols, frame.rows ?? state.terminal.rows);
        else if (frame.type === 'focus') state.terminal.focus();
        else if (frame.type === 'clear') state.terminal.clear();
        else if (frame.type === 'dispose') {
          unlinkQuiet(this.mailboxFs, `${dir}/${input.name}`);
          this.closeSession(key, dir, state);
          break;
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'TerminalBackpressureError') break;
        throw error;
      }
      state.lastInput = frame.seq;
      state.lastSeenAt = this.now();
      handled++;
      unlinkQuiet(this.mailboxFs, `${dir}/${input.name}`);
    }
    state.terminal.flush();
    return handled;
  }

  private applyAck(state: HostSession, dir: string, names: string[], ack: number): void {
    state.lastAck = Math.max(state.lastAck, ack);
    state.terminal.acknowledge(state.lastAck);
    for (const name of names) {
      const seq = parseFrameSequence(name, 'out');
      if (seq !== null && seq <= state.lastAck) unlinkQuiet(this.mailboxFs, `${dir}/${name}`);
    }
  }

  private closeSession(key: string, dir: string, state: HostSession): void {
    state.terminal.dispose();
    this.onSessionClose?.(state.identity, state.terminal);
    this.sessions.delete(key);
    this.orphanedAt.delete(dir);
    this.mailboxFs.rmSync?.(dir, { recursive: true, force: true });
  }

  private pruneOrphan(dir: string): void {
    const firstSeenAt = this.orphanedAt.get(dir);
    if (firstSeenAt === undefined) {
      this.orphanedAt.set(dir, this.now());
      return;
    }
    if (this.now() - firstSeenAt <= this.sessionTtlMs) return;
    this.orphanedAt.delete(dir);
    this.mailboxFs.rmSync?.(dir, { recursive: true, force: true });
  }

  private dropMissingOrphans(): void {
    for (const dir of this.orphanedAt.keys()) {
      if (!this.mailboxFs.existsSync(dir)) this.orphanedAt.delete(dir);
    }
  }
}

export { TERMINAL_MAILBOX_ROOT };
