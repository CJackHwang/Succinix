import type { ITerminal } from '@lifo-sh/core';

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
  private readonly deviceListeners = new Map<ITerminal, Set<(data: string) => void>>();
  private readonly pendingOutput: string[] = [];
  private pendingBytes = 0;
  private _backpressured = false;
  private _cols: number;
  private _rows: number;

  constructor(cols = 80, rows = 24, private readonly maxPendingBytes = 256 * 1024) {
    this._cols = saneDimension(cols, 80);
    this._rows = saneDimension(rows, 24);
  }

  get cols(): number { return this.device?.cols ?? this._cols; }
  get rows(): number { return this.device?.rows ?? this._rows; }
  get backpressured(): boolean { return this._backpressured; }

  attach(device: ITerminal): void {
    if (this.device === device) return;
    if (this.device) this.removeDeviceListeners(this.device);
    this.device = device;
    this._cols = device.cols;
    this._rows = device.rows;
    for (const data of this.pendingOutput.splice(0)) device.write(data);
    this.pendingBytes = 0;
    this._backpressured = false;
    const attached = new Set<(data: string) => void>();
    this.deviceListeners.set(device, attached);
    for (const listener of this.listeners) {
      device.onData(listener);
      attached.add(listener);
    }
  }

  detach(device?: ITerminal): void {
    if (device === undefined || this.device === device) {
      if (this.device) this.removeDeviceListeners(this.device);
      this.device = null;
    }
  }

  write(data: string): void {
    if (!data) return;
    if (this.device) {
      this.device.write(data);
      return;
    }
    this.pendingOutput.push(data);
    this.pendingBytes += byteLength(data);
    // Never drop terminal bytes while a browser device is reconnecting.  The
    // mailbox has replay/ack semantics; this hub only bridges the stable Lifo
    // terminal to the newest device endpoint. Expose pressure instead of
    // silently truncating an editor redraw.
    this._backpressured = this.pendingBytes >= this.maxPendingBytes;
  }

  writeln(data: string): void { this.write(`${data}\r\n`); }

  onData(callback: (data: string) => void): void {
    this.listeners.add(callback);
    if (this.device) {
      this.device.onData(callback);
      this.deviceListeners.get(this.device)?.add(callback);
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
    if (this.device) this.removeDeviceListeners(this.device);
    this.device = null;
    this.listeners.clear();
    this.deviceListeners.clear();
    this.pendingOutput.length = 0;
    this.pendingBytes = 0;
    this._backpressured = false;
  }

  private removeDeviceListeners(device: ITerminal): void {
    const callbacks = this.deviceListeners.get(device);
    if (!callbacks) return;
    const removable = device as ITerminal & { removeDataListener?: (listener: (data: string) => void) => void };
    if (removable.removeDataListener) {
      for (const callback of callbacks) removable.removeDataListener(callback);
    }
    this.deviceListeners.delete(device);
  }
}

function saneDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
