import { describe, expect, it, vi } from 'vitest';
import { TerminalHub } from '../src/engine/terminal-hub.js';

class Device {
  readonly writes: string[] = [];
  private readonly listeners = new Set<(data: string) => void>();
  cols = 80;
  rows = 24;
  focusCount = 0;
  clearCount = 0;
  write(data: string): void { this.writes.push(data); }
  writeln(data: string): void { this.write(`${data}\n`); }
  onData(callback: (data: string) => void): void { this.listeners.add(callback); }
  removeDataListener(callback: (data: string) => void): void { this.listeners.delete(callback); }
  focus(): void { this.focusCount++; }
  clear(): void { this.clearCount++; }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; }
  emit(data: string): void { for (const listener of this.listeners) listener(data); }
}

describe('instance terminal scheduler', () => {
  it('waits for a submitted interactive command before starting a batch command', async () => {
    const hub = new TerminalHub();
    const device = new Device();
    const events: string[] = [];
    hub.onData((data) => events.push(`interactive:${data}`));
    hub.attach(device);
    device.emit('cd /workspace/next\r');

    const batch = hub.runBatch(async () => { events.push('batch'); }, 1000);
    await Promise.resolve();
    expect(events).toEqual(['interactive:cd /workspace/next\r']);

    hub.write('guest@succinix:/workspace/next$ ');
    await batch;
    expect(events).toEqual(['interactive:cd /workspace/next\r', 'batch']);
  });

  it('queues later terminal input until the active batch command finishes', async () => {
    const hub = new TerminalHub();
    const device = new Device();
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    hub.onData((data) => events.push(data));
    hub.attach(device);

    const batch = hub.runBatch(async () => { started(); await blocked; }, 1000);
    await active;
    device.emit('export MODE=interactive\r');
    expect(events).toEqual([]);

    release();
    await batch;
    expect(events).toEqual(['export MODE=interactive\r']);
  });

  it('releases pasted complete command lines one at a time after each prompt', async () => {
    vi.useFakeTimers();
    try {
      const hub = new TerminalHub();
      const device = new Device();
      const events: string[] = [];
      hub.onData((data) => events.push(data));
      hub.attach(device);

      device.emit('printf first\r');
      device.emit('printf second\rprintf third\r');
      expect(events).toEqual(['printf first\r']);

      hub.write('guest@succinix:/workspace$ ');
      expect(events).toEqual(['printf first\r']);
      await Promise.resolve();
      expect(events).toEqual(['printf first\r', 'printf second\r']);

      hub.write('guest@succinix:/workspace$ ');
      await Promise.resolve();
      expect(events).toEqual(['printf first\r', 'printf second\r', 'printf third\r']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds later complete command lines until the active shell command prints a prompt', async () => {
    vi.useFakeTimers();
    try {
      const hub = new TerminalHub();
      const device = new Device();
      const events: string[] = [];
      hub.onData((data) => events.push(data));
      hub.attach(device);

      device.emit('printf first\r');
      await vi.advanceTimersByTimeAsync(1);
      device.emit('printf second\r');
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(['printf first\r']);

      hub.write('guest@succinix:/workspace$ ');
      await Promise.resolve();
      expect(events).toEqual(['printf first\r', 'printf second\r']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a detached output write atomically and preserves terminal device controls after reconnect', () => {
    const hub = new TerminalHub(80, 24, 4);
    expect(() => hub.write('abcdef')).toThrow(/terminal backpressure/);

    expect(hub.bufferedBytes).toBe(0);
    expect(hub.discardedBytes).toBe(0);
    expect(hub.backpressured).toBe(true);

    hub.write('abcd');

    const device = new Device();
    hub.attach(device);
    hub.focus();
    hub.clear();
    hub.resize(120, 40);

    expect(device.writes).toEqual(['abcd']);
    expect(hub.bufferedBytes).toBe(0);
    expect(hub.backpressured).toBe(false);
    expect(device.focusCount).toBe(1);
    expect(device.clearCount).toBe(1);
    expect(device).toMatchObject({ cols: 120, rows: 40 });
  });

  it('replaces stale device listeners and rejects terminal input queued behind a batch atomically', async () => {
    const hub = new TerminalHub(80, 24, 4);
    const first = new Device();
    const second = new Device();
    const input: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    hub.onData((data) => input.push(data));
    hub.attach(first);
    first.emit('old');
    hub.attach(second);
    first.emit('ignored');

    const batch = hub.runBatch(async () => { started(); await blocked; }, 1_000);
    await active;
    expect(() => second.emit('abcde')).toThrow(/terminal backpressure/);
    expect(hub.discardedInputBytes).toBe(0);

    second.emit('abcd');

    release();
    await batch;
    second.emit('new');
    hub.detach(second);
    second.emit('detached');

    expect(input).toEqual(['old', 'abcd', 'new']);
  });

  it('fails a batch when the foreground interactive command does not return to a prompt', async () => {
    vi.useFakeTimers();
    try {
      const hub = new TerminalHub();
      const device = new Device();
      hub.attach(device);
      device.emit('sleep 60\r');

      const rejected = expect(hub.runBatch(async () => undefined, 10))
        .rejects.toThrow('interactive terminal did not become idle');
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
