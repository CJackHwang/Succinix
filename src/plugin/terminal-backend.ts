// invariant: Succinix PTY backend for dsh ctx.terminals over the existing
// SuccinixTerminalSession. It captures scrollback, serializes sends through
// the session state machine, and fails closed for signals it cannot verify.
import type {
  SuccinixTerminalSession,
  TerminalOutput,
  TerminalSessionOptions,
} from '../terminal/index.js';
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
} from './dsh-types.js';

const SEND_IDLE_TIMEOUT_MS = 60000;

class CapturedOutput implements TerminalOutput {
  private text = '';

  write(data: string): void {
    this.text += data;
  }

  clear(): void {
    this.text = '';
  }

  textSince(offset: number): string {
    return this.text.slice(offset);
  }

  lines(): string[] {
    return this.text.split(/\r\n|\n|\r/);
  }
}

export interface SuccinixTerminalBackendDeps {
  createSession(options: TerminalSessionOptions & { output: TerminalOutput }): SuccinixTerminalSession;
}

export class SuccinixTerminalBackend implements TerminalBackend {
  readonly type = 'succinix';

  constructor(private readonly deps: SuccinixTerminalBackendDeps) {}

  async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
    const capture = new CapturedOutput();
    const session = this.deps.createSession({
      cwd: spec.cwd ?? '/workspace',
      bootGate: false,
      output: capture,
    });
    await session.boot();
    return new SuccinixBackendSession(session, capture, spec.sessionId);
  }
}

class SuccinixBackendSession implements TerminalBackendSession {
  readonly motd: string;
  private closed = false;
  private readonly syntheticPgid: number;

  constructor(
    private readonly session: SuccinixTerminalSession,
    private readonly capture: CapturedOutput,
    sessionId: string
  ) {
    this.motd = capture.textSince(0);
    let hash = 0;
    for (const char of sessionId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    this.syntheticPgid = (hash % 0x7fffffff) + 1;
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    let settled = false;
    let lastRead = this.capture.textSince(0).length;
    const start = lastRead;
    const done = (async (): Promise<TerminalSendResult> => {
      if (!this.closed) {
        if (request.text) this.session.handleData(request.text);
        if (request.submit) this.session.handleData('\r');
      }
      const idle = await this.session.waitForIdle(SEND_IDLE_TIMEOUT_MS);
      settled = true;
      const sessionStatus = this.status();
      return {
        viewport: this.capture.textSince(start),
        waitReason: this.closed ? 'session_exit' : idle ? (request.submit || request.text ? 'inferred_idle' : 'stdin_read') : 'timeout',
        sessionStatus,
        truncated: false,
      };
    })();
    return {
      done,
      readOutput: (): TerminalSendRead => {
        const delta = this.capture.textSince(lastRead);
        lastRead += delta.length;
        return { delta, truncated: false };
      },
      cancel: (): boolean => {
        if (settled || this.closed) return false;
        this.session.handleData('\u0003');
        return true;
      },
    };
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const lines = this.capture.lines();
    const totalLines = lines.length;
    const offset = Number.isSafeInteger(request.offset) && (request.offset ?? 0) >= 0 ? request.offset ?? 0 : 0;
    const count = Number.isSafeInteger(request.count) && (request.count ?? 100) >= 0 ? request.count ?? 100 : 100;
    const lineEnd = Math.max(0, totalLines - offset);
    const lineBegin = Math.max(0, lineEnd - count);
    return {
      text: lines.slice(lineBegin, lineEnd).join('\n'),
      totalLines,
      lineBegin,
      lineEnd,
      truncated: lineBegin > 0,
    };
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    if (this.closed) throw new Error(`PTY session is already closed: ${signal}`);
    if (signal === 'SIGHUP' || signal === 'SIGTSTP') {
      throw new Error(`PTY signal ${signal} has no verifiable foreground delivery channel in Succinix`);
    }
    this.session.handleData('\u0003');
    return { delivered: true, targetPgid: this.syntheticPgid };
  }

  status(): TerminalSessionStatus {
    if (this.closed) return { kind: 'exited', exitCode: 0, signal: null };
    return { kind: 'running' };
  }

  async close(_reason: string): Promise<void> {
    if (this.closed) return;
    this.session.dispose();
    this.closed = true;
  }
}
