import { describe, expect, it, vi } from 'vitest';
import { RpcTerminal, TerminalMailboxHost } from '../src/engine/host/terminal.js';
import { RpcTerminalClient } from '../src/terminal/transport.js';
import { TERMINAL_PROTOCOL_VERSION, mailboxPath, hostMailboxPath, type TerminalIdentity } from '../src/terminal/transport-protocol.js';

class MemoryFs {
  readonly files = new Map<string, string>();
  private key(path: string): string { return path.replace(/^\//, ''); }
  existsSync(path: string): boolean { const p = this.key(path); return [...this.files.keys()].some((k) => k === p || k.startsWith(`${p}/`)); }
  mkdirSync(): void { /* implicit */ }
  readdirSync(path: string): string[] {
    const p = this.key(path).replace(/\/$/, '');
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(`${p}/`)) continue;
      const rest = key.slice(p.length + 1);
      names.add(rest.split('/')[0]!);
    }
    if (!names.size) throw new Error('ENOENT');
    return [...names];
  }
  readFileSync(path: string, _encoding?: 'utf8'): string { const v = this.files.get(this.key(path)); if (v === undefined) throw new Error('ENOENT'); return v; }
  writeFileSync(path: string, data: string): void { this.files.set(this.key(path), data); }
  renameSync(from: string, to: string): void { const value = this.files.get(this.key(from)); if (value === undefined) throw new Error('ENOENT'); this.files.delete(this.key(from)); this.files.set(this.key(to), value); }
  unlinkSync(path: string): void { if (!this.files.delete(this.key(path))) throw new Error('ENOENT'); }
  rmSync(path: string): void { const p = this.key(path).replace(/\/$/, ''); for (const k of [...this.files.keys()]) if (k === p || k.startsWith(`${p}/`)) this.files.delete(k); }
  async readFile(path: string): Promise<string> { return this.readFileSync(path); }
  async writeFile(path: string, data: string): Promise<void> { this.writeFileSync(path, data); }
  async readdir(path: string): Promise<Array<{ name: string; type: string }>> { return this.readdirSync(path).map((name) => ({ name, type: 'file' })); }
  async mkdir(): Promise<void> { /* implicit */ }
  async rm(path: string): Promise<void> { this.rmSync(path); }
  async rename(from: string, to: string): Promise<void> { this.renameSync(from, to); }
}

function identity(nonce = 'boot-1'): TerminalIdentity { return { protocolVersion: TERMINAL_PROTOCOL_VERSION, instanceId: 'default', sessionId: 'session-1', bootNonce: nonce }; }

describe('terminal mailbox transport', () => {
  it('rejects nested instance ids before they can become mailbox paths', () => {
    const nested = { ...identity(), instanceId: 'users/alice' };
    expect(() => mailboxPath(nested, 'open.json')).toThrow('invalid terminal id');
  });

  it('coalesces output and retains sequence frames until ack', () => {
    const fs = new MemoryFs();
    const term = new RpcTerminal(identity(), { fs });
    term.write('hello');
    term.write(' world');
    term.flush();
    const path = hostMailboxPath(identity(), 'out-000000000001.json');
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).data).toBe('hello world');
    expect(fs.files.has(path)).toBe(true);
  });

  it('applies open.lastAck so replay files already consumed by the browser are pruned', () => {
    const fs = new MemoryFs();
    let opened: RpcTerminal | undefined;
    const host = new TerminalMailboxHost((open, opts) => {
      opened = new RpcTerminal(open, opts);
      return opened;
    }, { fs });
    fs.writeFileSync(hostMailboxPath(identity(), 'open.json'), JSON.stringify({ ...identity(), type: 'open', cols: 80, rows: 24 }));
    host.poll();
    opened!.write('one');
    opened!.write('two');
    opened!.flush();
    const first = hostMailboxPath(identity(), 'out-000000000001.json');
    expect(fs.files.has(first)).toBe(true);

    fs.writeFileSync(hostMailboxPath(identity(), 'open.json'), JSON.stringify({ ...identity(), type: 'open', cols: 80, rows: 24, lastAck: 1 }));
    host.poll();
    expect(fs.files.has(first)).toBe(false);
  });

  it('routes input, resize, and drops stale nonce frames', () => {
    const fs = new MemoryFs();
    let opened: RpcTerminal | undefined;
    const host = new TerminalMailboxHost((open, opts) => {
      opened = new RpcTerminal(open, opts);
      return opened;
    }, { fs });
    const open = { ...identity(), type: 'open' as const, cols: 80, rows: 24 };
    fs.writeFileSync(hostMailboxPath(identity(), 'open.json'), JSON.stringify(open));
    host.poll();
    const seen: string[] = [];
    opened!.onData((data) => seen.push(data));
    fs.writeFileSync(hostMailboxPath(identity(), 'in-000000000001.json'), JSON.stringify({ ...identity('old'), type: 'input', seq: 1, data: 'stale' }));
    fs.writeFileSync(hostMailboxPath(identity(), 'in-000000000002.json'), JSON.stringify({ ...identity(), type: 'input', seq: 2, data: 'ok' }));
    fs.writeFileSync(hostMailboxPath(identity(), 'in-000000000003.json'), JSON.stringify({ ...identity(), type: 'resize', seq: 3, cols: 120, rows: 40 }));
    host.poll();
    expect(seen).toEqual(['ok']);
    expect(opened!.cols).toBe(120);
    expect(opened!.rows).toBe(40);
  });

  it('closes the host session and removes the mailbox on dispose frames', () => {
    const fs = new MemoryFs();
    const closed: TerminalIdentity[] = [];
    const host = new TerminalMailboxHost((open, opts) => new RpcTerminal(open, opts), {
      fs,
      onSessionClose: (id) => closed.push(id),
    });
    fs.writeFileSync(hostMailboxPath(identity(), 'open.json'), JSON.stringify({ ...identity(), type: 'open', cols: 80, rows: 24 }));
    host.poll();
    expect(host.sessionCount()).toBe(1);

    fs.writeFileSync(hostMailboxPath(identity(), 'in-000000000001.json'), JSON.stringify({ ...identity(), type: 'dispose', seq: 1 }));
    host.poll();
    expect(host.sessionCount()).toBe(0);
    expect(closed).toEqual([identity()]);
    expect([...fs.files.keys()].some((key) => key.includes('/session-1/'))).toBe(false);
  });

  it('browser client sends xterm data and consumes ordered output', async () => {
    vi.useFakeTimers();
    try {
      const fs = new MemoryFs();
      const output: string[] = [];
      const client = new RpcTerminalClient({ fs, identity: identity(), onOutput: (data) => output.push(data), pollMs: 1 });
      await client.open();
      await client.sendData('ls\r');
      const input = JSON.parse(fs.readFileSync(mailboxPath(identity(), 'in-000000000001.json'), 'utf8'));
      expect(input.data).toBe('ls\r');
      fs.writeFileSync(mailboxPath(identity(), 'out-000000000001.json'), JSON.stringify({ ...identity(), type: 'output', seq: 1, data: 'ok\r\n' }));
      await vi.advanceTimersByTimeAsync(2);
      expect(output).toEqual(['ok\r\n']);
      expect(client.receivedOutputByteCount).toBe(4);
      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fans output out to the xterm renderer and interactive subscribers', async () => {
    vi.useFakeTimers();
    try {
      const fs = new MemoryFs();
      const rendered: string[] = [];
      const subscribed: string[] = [];
      const client = new RpcTerminalClient({ fs, identity: identity(), onOutput: (data) => rendered.push(data), pollMs: 1 });
      client.onOutput((data) => subscribed.push(data));
      await client.open();
      fs.writeFileSync(mailboxPath(identity(), 'out-000000000001.json'), JSON.stringify({ ...identity(), type: 'output', seq: 1, data: 'frame-0' }));
      await vi.advanceTimersByTimeAsync(2);

      expect(rendered).toEqual(['frame-0']);
      expect(subscribed).toEqual(['frame-0']);
      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-opens before flushing input when device data arrives first', async () => {
    const fs = new MemoryFs();
    const client = new RpcTerminalClient({ fs, identity: identity(), pollMs: 1 });
    await client.sendData('early');
    expect(JSON.parse(fs.readFileSync(mailboxPath(identity(), 'open.json'), 'utf8')).type).toBe('open');
    expect(JSON.parse(fs.readFileSync(mailboxPath(identity(), 'in-000000000001.json'), 'utf8')).data).toBe('early');
    await client.dispose();
  });

  it('replays initial output delivered before an interactive subscriber registers', async () => {
    vi.useFakeTimers();
    try {
      const fs = new MemoryFs();
      const client = new RpcTerminalClient({ fs, identity: identity(), pollMs: 1 });
      await client.open();
      fs.writeFileSync(mailboxPath(identity(), 'out-000000000001.json'), JSON.stringify({ ...identity(), type: 'output', seq: 1, data: 'guest@succinix:~$ ' }));
      await vi.advanceTimersByTimeAsync(2);

      const output: string[] = [];
      client.onOutput((data) => output.push(data));
      await vi.advanceTimersByTimeAsync(2);

      expect(output).toEqual(['guest@succinix:~$ ']);
      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for missing output sequence numbers before acking replay', async () => {
    vi.useFakeTimers();
    try {
      const fs = new MemoryFs();
      const output: string[] = [];
      const client = new RpcTerminalClient({ fs, identity: identity(), onOutput: (data) => output.push(data), pollMs: 1 });
      await client.open();
      fs.writeFileSync(mailboxPath(identity(), 'out-000000000002.json'), JSON.stringify({ ...identity(), type: 'output', seq: 2, data: 'two' }));
      await vi.advanceTimersByTimeAsync(2);
      expect(output).toEqual([]);
      expect(fs.files.has(mailboxPath(identity(), 'ack.json').slice(1))).toBe(false);

      fs.writeFileSync(mailboxPath(identity(), 'out-000000000001.json'), JSON.stringify({ ...identity(), type: 'output', seq: 1, data: 'one' }));
      await vi.advanceTimersByTimeAsync(2);
      expect(output).toEqual(['one', 'two']);
      expect(JSON.parse(fs.readFileSync(mailboxPath(identity(), 'ack.json'), 'utf8')).ack).toBe(2);
      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews nonce without replaying stale input into the new host epoch', async () => {
    const fs = new MemoryFs();
    const client = new RpcTerminalClient({ fs, identity: identity('old'), pollMs: 1 });
    await client.open();
    await client.sendData('old\r');
    await client.renewBootNonce('new');
    expect(client.bootNonce).toBe('new');
    const frames = [...fs.files.entries()].filter(([name]) => name.includes('/in-') && name.endsWith('.json')).map(([, value]) => JSON.parse(value));
    expect(frames.some((frame) => frame.bootNonce === 'old')).toBe(false);
    expect(JSON.parse(fs.readFileSync(mailboxPath({ ...identity('new') }, 'open.json'), 'utf8')).bootNonce).toBe('new');
    await client.dispose();
  });
});

describe('terminal backpressure', () => {
  it('host terminal rejects an oversized write before buffering any of it', () => {
    const fs = new MemoryFs();
    const events: number[] = [];
    const term = new RpcTerminal(identity(), { fs, maxBufferedBytes: 16, onBackpressure: (bytes) => events.push(bytes) });
    expect(() => term.write('x'.repeat(32))).toThrow(/terminal backpressure/);
    expect(term.backpressured).toBe(true);
    expect(events).toContain(0);
    const controlPath = hostMailboxPath(identity(), 'out-000000000001.json');
    const frame = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
    expect(frame.control).toBe('backpressure');
    expect(frame.bufferedBytes).toBe(0);
    expect(term.bufferedBytes).toBe(0);
    expect(term.discardedOutputBytes).toBe(0);
    term.write('x'.repeat(16));
    term.flush();
    expect(term.bufferedBytes).toBe(0);
    expect(term.backpressured).toBe(true);
    term.acknowledge(2);
    expect(term.backpressured).toBe(false);
    expect(events.at(-1)).toBe(0);
  });

  it('reports clamped terminal dimensions when a mailbox resize arrives', () => {
    const sizes: Array<{ cols: number; rows: number }> = [];
    const term = new RpcTerminal(identity(), {
      fs: new MemoryFs(),
      onResize: (cols, rows) => sizes.push({ cols, rows }),
    });

    term.resize(120.8, 40.2);

    expect(sizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(term).toMatchObject({ cols: 120, rows: 40 });
  });

  it('rejects unacknowledged output atomically and resumes after the browser ACK', () => {
    const fs = new MemoryFs();
    let opened: RpcTerminal | undefined;
    const host = new TerminalMailboxHost((open, opts) => {
      opened = new RpcTerminal(open, { ...opts, maxBufferedBytes: 8 });
      return opened;
    }, { fs });
    fs.writeFileSync(hostMailboxPath(identity(), 'open.json'), JSON.stringify({ ...identity(), type: 'open', cols: 80, rows: 24 }));
    host.poll();
    expect(() => opened!.write('abcdefghijk')).toThrow(/terminal backpressure/);
    expect(opened!.unacknowledgedBytes).toBe(0);
    expect(opened!.discardedOutputBytes).toBe(0);
    opened!.write('abcdefgh');
    opened!.flush();
    expect(opened!.unacknowledgedBytes).toBe(8);
    expect(() => opened!.write('later')).toThrow(/terminal backpressure/);
    expect(opened!.discardedOutputBytes).toBe(0);

    fs.writeFileSync(hostMailboxPath(identity(), 'ack.json'), JSON.stringify({ ...identity(), type: 'ack', ack: 2 }));
    host.poll();
    expect(opened!.unacknowledgedBytes).toBe(0);
    opened!.write('next');
    opened!.flush();
    expect(opened!.unacknowledgedBytes).toBe(4);
  });

  it('expires a mailbox which stops sending heartbeats', () => {
    const fs = new MemoryFs();
    const closed: TerminalIdentity[] = [];
    let now = 100;
    const host = new TerminalMailboxHost((open, opts) => new RpcTerminal(open, opts), {
      fs,
      now: () => now,
      sessionTtlMs: 50,
      onSessionClose: (value) => closed.push(value),
    });
    fs.writeFileSync(hostMailboxPath(identity(), 'open.json'), JSON.stringify({ ...identity(), type: 'open', cols: 80, rows: 24 }));
    host.poll();
    now = 151;
    host.poll();
    expect(host.sessionCount()).toBe(0);
    expect(closed).toEqual([identity()]);
    expect([...fs.files.keys()].some((path) => path.includes('/session-1/'))).toBe(false);
  });

  it('prunes an orphaned mailbox only after the session TTL', () => {
    const fs = new MemoryFs();
    let now = 100;
    const host = new TerminalMailboxHost((open, opts) => new RpcTerminal(open, opts), {
      fs,
      now: () => now,
      sessionTtlMs: 50,
    });
    const orphan = '.succinix-terminal/default/crashed-session/in-000000000001.json';
    fs.writeFileSync(orphan, JSON.stringify({ type: 'input', data: 'stale' }));

    host.poll();
    now = 150;
    host.poll();
    expect(fs.existsSync('.succinix-terminal/default/crashed-session')).toBe(true);

    now = 151;
    host.poll();
    expect(fs.existsSync('.succinix-terminal/default/crashed-session')).toBe(false);
    expect(host.sessionCount()).toBe(0);
  });


});
