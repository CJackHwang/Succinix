import {
  TERMINAL_MAILBOX_ROOT,
  TERMINAL_PROTOCOL_VERSION,
  TERMINAL_SESSION_TTL_MS,
  isTerminalIdentity,
  parseFrameSequence,
  type TerminalAckFrame,
  type TerminalIdentity,
  type TerminalInputFrame,
  type TerminalOpenFrame,
} from '../../terminal/transport-protocol.js';
import {
  decodePathPart,
  nodeFs,
  readJson,
  rootPath,
  sameIdentity,
  unlinkQuiet,
  type TerminalMailboxFs,
} from './terminal-mailbox-utils.js';
import type { RpcTerminal } from './terminal.js';

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

/** Host-side mailbox scanner. Call poll() from the existing host loop. */
export class TerminalMailboxHost {
  private readonly mailboxFs: TerminalMailboxFs;
  private readonly onSessionClose?: (identity: TerminalIdentity, terminal: RpcTerminal) => void;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, HostSession>();
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
    for (const session of this.sessions.values()) {
      session.terminal.dispose();
      this.onSessionClose?.(session.identity, session.terminal);
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
        try { canonicalDir = rootPath(instanceId, sessionId); } catch {
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
    if (names.includes('open.json')) {
      const open = readJson(this.mailboxFs, `${dir}/open.json`) as TerminalOpenFrame | null;
      if (open && isTerminalIdentity(open) && open.type === 'open' && open.instanceId === instanceId && open.sessionId === sessionId) {
        this.openSession(dir, instanceId, sessionId, open, names);
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
    handled += this.applyInputs(dir, names, key, state);
    state.terminal.flush();
    return handled;
  }

  private openSession(dir: string, instanceId: string, sessionId: string, open: TerminalOpenFrame, names: string[]): void {
    this.orphanedAt.delete(dir);
    const key = `${instanceId}/${sessionId}`;
    const old = this.sessions.get(key);
    if (!old || old.identity.bootNonce !== open.bootNonce) {
      if (old) {
        old.terminal.dispose();
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
      return;
    }
    if (typeof open.lastAck === 'number' && Number.isFinite(open.lastAck) && open.lastAck > old.lastAck) {
      old.lastAck = Math.floor(open.lastAck);
      this.applyAck(old, dir, names, old.lastAck);
    }
  }

  private applyInputs(dir: string, names: string[], key: string, state: HostSession): number {
    let handled = 0;
    const inputs = names
      .map((name) => ({ name, seq: parseFrameSequence(name, 'in') }))
      .filter((entry): entry is { name: string; seq: number } => entry.seq !== null)
      .sort((left, right) => left.seq - right.seq);
    for (const input of inputs) {
      const path = `${dir}/${input.name}`;
      const frame = readJson(this.mailboxFs, path) as TerminalInputFrame | null;
      if (!frame || !isTerminalIdentity(frame) || !sameIdentity(frame, state.identity) || frame.seq <= state.lastInput) {
        unlinkQuiet(this.mailboxFs, path);
        continue;
      }
      try {
        if (frame.type === 'input') state.terminal.acceptInput(frame.data ?? '');
        else if (frame.type === 'resize') state.terminal.resize(frame.cols ?? state.terminal.cols, frame.rows ?? state.terminal.rows);
        else if (frame.type === 'focus') state.terminal.focus();
        else if (frame.type === 'clear') state.terminal.clear();
        else if (frame.type === 'dispose') {
          unlinkQuiet(this.mailboxFs, path);
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
      unlinkQuiet(this.mailboxFs, path);
    }
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
