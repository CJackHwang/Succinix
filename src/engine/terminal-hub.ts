import type { ITerminal } from '@lifo-sh/core';
import { TERMINAL_MAX_BUFFER_BYTES, TerminalBackpressureError } from '../terminal/transport-protocol.js';

/**
 * Stable terminal object supplied to `Sandbox.create` for an instance.
 *
 * Lifo constructs and starts its Shell during Sandbox.create, so the terminal
 * object must exist before a browser session opens.  TerminalHub keeps that
 * object stable and swaps only the thin device endpoint (RpcTerminal) on
 * reconnect.  It contains no line editor, history, files, or command state.
 */
export class TerminalHub implements ITerminal {
  private device: ITerminal | null = null;
  private readonly listeners = new Set<(data: string) => void>();
  private readonly deviceListeners = new Map<ITerminal, (data: string) => void>();
  private readonly pendingOutput: string[] = [];
  private readonly pendingInput: string[] = [];
  private readonly pendingSubmittedInput: string[] = [];
  private pendingBytes = 0;
  private pendingInputBytes = 0;
  private pendingSubmittedInputBytes = 0;
  private droppedBytes = 0;
  private droppedInputBytes = 0;
  private _backpressured = false;
  private _cols: number;
  private _rows: number;
  private disposed = false;
  private batchActive = false;
  private batchTail: Promise<void> = Promise.resolve();
  private interactiveRunning = false;
  private interactiveIdle: Promise<void> = Promise.resolve();
  private resolveInteractiveIdle: (() => void) | null = null;
  private submittedInputFlushQueued = false;
  private outputTail = '';

  constructor(cols = 80, rows = 24, private readonly maxPendingBytes = TERMINAL_MAX_BUFFER_BYTES) {
    this._cols = saneDimension(cols, 80);
    this._rows = saneDimension(rows, 24);
  }

  get cols(): number { return this.device?.cols ?? this._cols; }
  get rows(): number { return this.device?.rows ?? this._rows; }
  get backpressured(): boolean { return this._backpressured; }
  get bufferedBytes(): number { return this.pendingBytes; }
  get discardedBytes(): number { return this.droppedBytes; }
  get discardedInputBytes(): number { return this.droppedInputBytes; }

  attach(device: ITerminal): void {
    if (this.disposed) return;
    if (this.device === device) return;
    if (this.device) this.removeDeviceListeners(this.device);
    this.device = null;
    this._cols = device.cols;
    this._rows = device.rows;
    while (this.pendingOutput.length) {
      const data = this.pendingOutput[0]!;
      device.write(data);
      this.pendingOutput.shift();
      this.pendingBytes -= byteLength(data);
    }
    this.updateBackpressure();
    this.device = device;
    const listener = (data: string) => this.acceptInput(data);
    this.deviceListeners.set(device, listener);
    device.onData(listener);
  }

  detach(device?: ITerminal): void {
    if (device === undefined || this.device === device) {
      if (this.device) this.removeDeviceListeners(this.device);
      this.device = null;
    }
  }

  write(data: string): void {
    if (!data) return;
    this.observeOutput(data);
    if (this.device) {
      this.device.write(data);
      return;
    }
    const dataBytes = byteLength(data);
    const availableBytes = Math.max(0, this.maxPendingBytes - this.pendingBytes);
    if (dataBytes > availableBytes) {
      this._backpressured = true;
      throw new TerminalBackpressureError(dataBytes, availableBytes);
    }
    this.pendingOutput.push(data);
    this.pendingBytes += dataBytes;
    this._backpressured = this.pendingBytes >= this.maxPendingBytes;
  }

  writeln(data: string): void { this.write(`${data}\r\n`); }

  onData(callback: (data: string) => void): void {
    this.listeners.add(callback);
  }

  /** Serialize a batch command with the same instance's interactive shell. */
  async runBatch<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
    const previous = this.batchTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.batchTail = previous.then(() => gate);
    await previous;
    try {
      await this.waitForInteractiveIdle(timeoutMs);
      this.batchActive = true;
      return await task();
    } finally {
      this.batchActive = false;
      this.flushPendingInput();
      this.scheduleSubmittedInputFlush();
      release();
    }
  }

  focus(): void { this.device?.focus(); }
  clear(): void { this.device?.clear(); }

  resize(cols: number, rows: number): void {
    this._cols = saneDimension(cols, this._cols);
    this._rows = saneDimension(rows, this._rows);
    const resize = (this.device as ITerminal & { resize?: (cols: number, rows: number) => void } | null)?.resize;
    resize?.call(this.device, this._cols, this._rows);
  }

  /** Release device callbacks and buffered output during instance teardown. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.device) this.removeDeviceListeners(this.device);
    this.device = null;
    this.listeners.clear();
    this.deviceListeners.clear();
    this.pendingOutput.length = 0;
    this.pendingInput.length = 0;
    this.pendingSubmittedInput.length = 0;
    this.pendingBytes = 0;
    this.pendingInputBytes = 0;
    this.pendingSubmittedInputBytes = 0;
    this.droppedBytes = 0;
    this.droppedInputBytes = 0;
    this._backpressured = false;
    this.submittedInputFlushQueued = false;
    this.finishInteractiveCommand();
  }

  private removeDeviceListeners(device: ITerminal): void {
    const callback = this.deviceListeners.get(device);
    if (!callback) return;
    const removable = device as ITerminal & { removeDataListener?: (listener: (data: string) => void) => void };
    removable.removeDataListener?.(callback);
    this.deviceListeners.delete(device);
  }

  private acceptInput(data: string): void {
    if (!data) return;
    if (this.batchActive) {
      this.enqueueInput(data);
      return;
    }
    // Lifo Shell treats multiple complete lines received in one terminal
    // callback as a paste and preserves its own command queue. The first
    // line must enter immediately so the instance scheduler observes it;
    // later complete lines are merged after the prompt returns.
    if (this.interactiveRunning && isCompleteCommandSubmission(data)) {
      this.enqueueSubmittedInput(data);
      return;
    }
    this.deliverInput(data);
  }

  private enqueueInput(data: string): void {
    const dataBytes = byteLength(data);
    const availableBytes = Math.max(0, this.maxPendingBytes - this.pendingInputBytes - this.pendingSubmittedInputBytes);
    if (dataBytes > availableBytes) throw new TerminalBackpressureError(dataBytes, availableBytes);
    this.pendingInput.push(data);
    this.pendingInputBytes += dataBytes;
    this.updateBackpressure();
  }

  private enqueueSubmittedInput(data: string): void {
    for (const submission of splitCommandSubmissions(data)) {
      const submissionBytes = byteLength(submission);
      const availableBytes = Math.max(0, this.maxPendingBytes - this.pendingInputBytes - this.pendingSubmittedInputBytes);
      if (submissionBytes > availableBytes) throw new TerminalBackpressureError(submissionBytes, availableBytes);
      this.pendingSubmittedInput.push(submission);
      this.pendingSubmittedInputBytes += submissionBytes;
    }
    this.updateBackpressure();
  }

  private deliverInput(data: string): void {
    if (!this.interactiveRunning && /\r|\n/.test(data)) this.beginInteractiveCommand();
    for (const listener of [...this.listeners]) listener(data);
  }

  private flushPendingInput(): void {
    const queued = this.pendingInput.splice(0);
    this.pendingInputBytes = 0;
    for (const data of queued) this.deliverInput(data);
    this.updateBackpressure();
  }

  private flushSubmittedInput(): void {
    if (this.disposed || this.batchActive || this.interactiveRunning || this.pendingSubmittedInput.length === 0) return;
    const queued = this.pendingSubmittedInput.shift()!;
    this.pendingSubmittedInputBytes -= byteLength(queued);
    this.updateBackpressure();
    this.deliverInput(queued);
  }

  private scheduleSubmittedInputFlush(): void {
    if (this.submittedInputFlushQueued || this.disposed || this.pendingSubmittedInput.length === 0) return;
    this.submittedInputFlushQueued = true;
    queueMicrotask(() => {
      this.submittedInputFlushQueued = false;
      this.flushSubmittedInput();
    });
  }

  private beginInteractiveCommand(): void {
    this.interactiveRunning = true;
    this.interactiveIdle = new Promise<void>((resolve) => { this.resolveInteractiveIdle = resolve; });
  }

  private finishInteractiveCommand(): void {
    if (!this.interactiveRunning) return;
    this.interactiveRunning = false;
    this.resolveInteractiveIdle?.();
    this.resolveInteractiveIdle = null;
    this.scheduleSubmittedInputFlush();
  }

  private observeOutput(data: string): void {
    this.outputTail = `${this.outputTail}${data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')}`.slice(-512);
    if (this.interactiveRunning && /guest@succinix:(?:~|\/[^$\r\n]*)\$\s*$/.test(this.outputTail)) this.finishInteractiveCommand();
  }

  private async waitForInteractiveIdle(timeoutMs: number): Promise<void> {
    if (!this.interactiveRunning) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.interactiveIdle,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('interactive terminal did not become idle')), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private updateBackpressure(): void {
    this._backpressured = this.pendingBytes + this.pendingInputBytes + this.pendingSubmittedInputBytes >= this.maxPendingBytes;
  }
}

function isCompleteCommandSubmission(data: string): boolean {
  return data.length > 1 && /\r|\n/.test(data);
}

function splitCommandSubmissions(data: string): string[] {
  const submissions: string[] = [];
  let start = 0;
  const lineEnd = /\r\n|\r|\n/g;
  for (let match = lineEnd.exec(data); match; match = lineEnd.exec(data)) {
    submissions.push(data.slice(start, match.index + match[0].length));
    start = match.index + match[0].length;
  }
  if (start < data.length) submissions.push(data.slice(start));
  return submissions;
}

function saneDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
