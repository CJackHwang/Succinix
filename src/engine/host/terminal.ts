import fs from 'node:fs';
import type { ITerminal } from '@lifo-sh/core';
import {
  TERMINAL_FLUSH_MS,
  TERMINAL_FRAME_LIMIT,
  TERMINAL_MAILBOX_ROOT,
  TERMINAL_MAX_BUFFER_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  frameFile,
  hostMailboxPath,
  isTerminalIdentity,
  mailboxPath,
  parseFrameSequence,
  type TerminalAckFrame,
  type TerminalIdentity,
  type TerminalInputFrame,
  type TerminalOpenFrame,
  type TerminalOutputFrame,
} from '../../terminal/transport-protocol.js';

/** Minimal synchronous file surface used by the in-WebContainer daemon. */
export interface TerminalMailboxFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  rmSync?(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

const nodeFs: TerminalMailboxFs = fs;

export interface RpcTerminalOptions {
  fs?: TerminalMailboxFs;
  /** Output frames waiting for browser acknowledgement are retained on disk. */
  maxBufferedBytes?: number;
  onBackpressure?: (bufferedBytes: number) => void;
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
  private pendingBytes = 0;
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
  }

  private readonly onBackpressure?: (bufferedBytes: number) => void;

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }
  get disposed(): boolean { return this._disposed; }
  get bufferedBytes(): number { return this.pendingBytes; }
  get backpressured(): boolean { return this._backpressured; }

  write(data: string): void {
    if (this._disposed || !data) return;
    // Keep every byte (rather than dropping terminal output) while exposing a
    // bounded-pressure signal to the scheduler.  Flushes are split at 32 KiB.
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
      this.earlyInput.push(data);
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
    this.control('resize', undefined, this._cols, this._rows);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.length = 0;
    this.pendingBytes = 0;
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
    if (chunk) this.writeFrame({ type: 'output', seq: ++this.outputSeq, data: chunk });
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
    const now = this.pendingBytes >= this.maxBufferedBytes;
    if (now === this._backpressured) return;
    this._backpressured = now;
    this.onBackpressure?.(this.pendingBytes);
    if (!this._disposed) this.control('backpressure', undefined, undefined, undefined, this.pendingBytes);
  }
}

export interface TerminalMailboxFactory {
  (open: TerminalOpenFrame, options: { fs: TerminalMailboxFs }): RpcTerminal;
}

export interface TerminalMailboxHostOptions {
  fs?: TerminalMailboxFs;
  onSessionClose?: (identity: TerminalIdentity, terminal: RpcTerminal) => void;
}

interface HostSession {
  identity: TerminalIdentity;
  terminal: RpcTerminal;
  lastInput: number;
  lastAck: number;
}

/** Host-side mailbox scanner. Call poll() from the existing 50 ms host loop. */
export class TerminalMailboxHost {
  private readonly mailboxFs: TerminalMailboxFs;
  private readonly onSessionClose?: (identity: TerminalIdentity, terminal: RpcTerminal) => void;
  private readonly sessions = new Map<string, HostSession>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly factory: TerminalMailboxFactory, options: TerminalMailboxHostOptions = {}) {
    this.mailboxFs = options.fs ?? nodeFs;
    this.onSessionClose = options.onSessionClose;
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
  }

  sessionCount(): number { return this.sessions.size; }

  poll(): number {
    let handled = 0;
    const root = TERMINAL_MAILBOX_ROOT.slice(1);
    let instances: string[];
    try { instances = this.mailboxFs.readdirSync(root); } catch { return 0; }
    for (const encodedInstanceId of instances) {
      const instanceId = decodePathPart(encodedInstanceId);
      if (!instanceId) continue;
      let sessions: string[];
      try { sessions = this.mailboxFs.readdirSync(`${root}/${encodedInstanceId}`); } catch { continue; }
      for (const encodedSessionId of sessions) {
        const sessionId = decodePathPart(encodedSessionId);
        if (sessionId) handled += this.pollSession(instanceId, sessionId);
      }
    }
    return handled;
  }

  private pollSession(instanceId: string, sessionId: string): number {
    const dir = `${rootPath(instanceId, sessionId)}`;
    let names: string[];
    try { names = this.mailboxFs.readdirSync(dir); } catch { return 0; }
    let handled = 0;
    const openName = names.includes('open.json') ? 'open.json' : null;
    if (openName) {
      const open = readJson(this.mailboxFs, `${dir}/${openName}`) as TerminalOpenFrame | null;
      if (open && isTerminalIdentity(open) && open.type === 'open' && open.instanceId === instanceId && open.sessionId === sessionId) {
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
          this.sessions.set(key, { identity: { protocolVersion: TERMINAL_PROTOCOL_VERSION, instanceId, sessionId, bootNonce: open.bootNonce }, terminal, lastInput: 0, lastAck: open.lastAck ?? 0 });
        } else {
          const state = this.sessions.get(key);
          if (state && typeof open.lastAck === 'number' && Number.isFinite(open.lastAck) && open.lastAck > state.lastAck) {
            state.lastAck = Math.floor(open.lastAck);
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
    if (!state) return handled;
    const ack = readJson(this.mailboxFs, `${dir}/ack.json`) as TerminalAckFrame | null;
    if (ack && isTerminalIdentity(ack) && ack.type === 'ack' && sameIdentity(ack, state.identity)) {
      this.applyAck(state, dir, names, ack.ack);
      unlinkQuiet(this.mailboxFs, `${dir}/ack.json`);
      handled++;
    }
    const inputs = names.map((name) => ({ name, seq: parseFrameSequence(name, 'in') })).filter((x): x is { name: string; seq: number } => x.seq !== null).sort((a, b) => a.seq - b.seq);
    for (const input of inputs) {
      const frame = readJson(this.mailboxFs, `${dir}/${input.name}`) as TerminalInputFrame | null;
      unlinkQuiet(this.mailboxFs, `${dir}/${input.name}`);
      if (!frame || !isTerminalIdentity(frame) || !sameIdentity(frame, state.identity)) continue;
      if (frame.seq <= state.lastInput) continue;
      state.lastInput = frame.seq;
      handled++;
      if (frame.type === 'input') state.terminal.acceptInput(frame.data ?? '');
      else if (frame.type === 'resize') state.terminal.resize(frame.cols ?? state.terminal.cols, frame.rows ?? state.terminal.rows);
      else if (frame.type === 'focus') state.terminal.focus();
      else if (frame.type === 'clear') state.terminal.clear();
      else if (frame.type === 'dispose') {
        state.terminal.dispose();
        this.onSessionClose?.(state.identity, state.terminal);
        this.sessions.delete(key);
        this.mailboxFs.rmSync?.(dir, { recursive: true, force: true });
        break;
      }
    }
    state.terminal.flush();
    return handled;
  }

  private applyAck(state: HostSession, dir: string, names: string[], ack: number): void {
    state.lastAck = Math.max(state.lastAck, ack);
    for (const name of names) {
      const seq = parseFrameSequence(name, 'out');
      if (seq !== null && seq <= state.lastAck) unlinkQuiet(this.mailboxFs, `${dir}/${name}`);
    }
  }
}

function rootPath(instanceId: string, sessionId: string): string {
  return mailboxPath({ instanceId, sessionId }, 'open.json').slice(1, -'/open.json'.length);
}
function decodePathPart(value: string): string | null {
  try { const decoded = decodeURIComponent(value); return decoded && decoded !== '.' && decoded !== '..' ? decoded : null; } catch { return null; }
}

function dirname(file: string): string { const i = file.lastIndexOf('/'); return i > 0 ? file.slice(0, i) : '.'; }
function byteLength(s: string): number { return typeof Buffer === 'undefined' ? s.length : Buffer.byteLength(s); }
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
function clampDimension(value: number, fallback: number): number { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
function unlinkQuiet(fsys: TerminalMailboxFs, path: string): void { try { fsys.unlinkSync(path); } catch { /* already consumed */ } }
function readJson(fsys: TerminalMailboxFs, path: string): unknown {
  try { return JSON.parse(fsys.readFileSync(path, 'utf8')); } catch { return null; }
}
function sameIdentity(a: TerminalIdentity, b: TerminalIdentity): boolean {
  return a.protocolVersion === b.protocolVersion && a.instanceId === b.instanceId && a.sessionId === b.sessionId && a.bootNonce === b.bootNonce;
}

export { TERMINAL_MAILBOX_ROOT };
