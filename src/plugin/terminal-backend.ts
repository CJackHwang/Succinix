// invariant: Succinix PTY backend for dsh ctx.terminals over the
// WebContainer-native InteractiveTerminalSession. Browser code never parses
// shell lines or owns history, completion, raw mode, cwd, or job state.
import type { InteractiveTerminalSession } from '../engine/index.js';
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

const INITIAL_OUTPUT_GRACE_MS = 250;
const OUTPUT_QUIET_MS = 50;
const SEND_IDLE_TIMEOUT_MS = 60000;

class CapturedOutput {
  private text = '';
  private revision = 0;

  append(data: string): void {
    this.text += data;
    this.revision++;
  }

  textSince(offset: number): string {
    return this.text.slice(offset);
  }

  length(): number {
    return this.text.length;
  }

  currentRevision(): number {
    return this.revision;
  }

  lines(): string[] {
    return this.text.split(/\r\n|\n|\r/);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQuiet(
  capture: CapturedOutput,
  timeoutMs: number,
  signal?: AbortSignal,
  requireOutput = false,
  initialRevision = capture.currentRevision(),
): Promise<boolean> {
  const startedAt = Date.now();
  let quietSince = startedAt;
  let revision = initialRevision;
  let observed = !requireOutput;
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) return false;
    const current = capture.currentRevision();
    if (current !== revision) {
      revision = current;
      observed = true;
      quietSince = Date.now();
    }
    if (observed && Date.now() - quietSince >= OUTPUT_QUIET_MS) return true;
    await wait(10);
  }
  return false;
}

export interface SuccinixTerminalBackendDeps {
  open(spec: TerminalBackendSpawnSpec): Promise<InteractiveTerminalSession>;
}

export class SuccinixTerminalBackend implements TerminalBackend {
  readonly type = 'succinix';

  constructor(private readonly deps: SuccinixTerminalBackendDeps) {}

  async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
    spec.signal?.throwIfAborted();
    const session = await this.deps.open(spec);
    const capture = new CapturedOutput();
    const unsubscribe = session.onData((data) => capture.append(data));
    try {
      // The initial shell prompt is useful session metadata, but the public
      // interactive transport has no prompt-ready handshake. Do not reject a
      // usable terminal merely because an already-running Sandbox emitted its
      // prompt before this device attached.
      await waitForQuiet(capture, INITIAL_OUTPUT_GRACE_MS, spec.signal, true);
      spec.signal?.throwIfAborted();
      return new SuccinixBackendSession(session, capture, unsubscribe, spec.sessionId);
    } catch (error) {
      unsubscribe();
      await session.close();
      throw error;
    }
  }
}

class SuccinixBackendSession implements TerminalBackendSession {
  readonly motd: string;
  private closed = false;
  private readonly syntheticPgid: number;

  constructor(
    private readonly session: InteractiveTerminalSession,
    private readonly capture: CapturedOutput,
    private readonly unsubscribe: () => void,
    sessionId: string,
  ) {
    this.motd = capture.textSince(0);
    let hash = 0;
    for (const char of sessionId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    this.syntheticPgid = (hash % 0x7fffffff) + 1;
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    let settled = false;
    let lastRead = this.capture.length();
    const start = lastRead;
    const done = this.sendAndWait(request, start).finally(() => { settled = true; });
    return {
      done,
      readOutput: (): TerminalSendRead => {
        const delta = this.capture.textSince(lastRead);
        lastRead += delta.length;
        return { delta, truncated: false };
      },
      cancel: (): boolean => {
        if (settled || this.closed) return false;
        void this.session.signal('SIGINT');
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
    await this.session.signal(signal);
    return { delivered: true, targetPgid: this.syntheticPgid };
  }

  status(): TerminalSessionStatus {
    return this.closed
      ? { kind: 'exited', exitCode: 0, signal: null }
      : { kind: 'running' };
  }

  async close(_reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    await this.session.close();
  }

  private async sendAndWait(request: TerminalSendRequest, start: number): Promise<TerminalSendResult> {
    const initialRevision = this.capture.currentRevision();
    if (!this.closed) {
      const data = `${request.text}${request.submit ? '\r' : ''}`;
      if (data) await this.session.send(data);
    }
    const idle = await waitForQuiet(
      this.capture,
      SEND_IDLE_TIMEOUT_MS,
      request.signal,
      request.submit || request.text.length > 0,
      initialRevision,
    );
    return {
      viewport: this.capture.textSince(start),
      waitReason: this.closed ? 'session_exit' : idle ? (request.submit || request.text ? 'inferred_idle' : 'stdin_read') : 'timeout',
      sessionStatus: this.status(),
      truncated: false,
    };
  }
}
