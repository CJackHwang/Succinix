// S0.7: event-sourced JSONL ctx.sessionPersistence mirror over the browser FS.
import { describe, it, expect, vi } from 'vitest';
import type { FileSystemAPI } from '@webcontainer/api';
import { FakeFS } from './helpers/fakes.js';
import {
  SessionFormatUnsupportedError,
  SessionId,
  SessionPersistenceCorruptionError,
  type SessionEvent,
  type SessionHeader,
} from '../src/plugin/dsh-types.js';
import {
  SuccinixSessionPersistence,
  type SessionPersistenceServiceDeps,
} from '../src/plugin/persistence-service.js';
import { SegmentedSessionLog } from '../src/persist/session-segments.js';

function header(id = 's-1', overrides: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt: 1000, ...overrides };
}

function event(type: string, seq: number, data: Record<string, unknown> = {}, extras: { ignorable?: true } = {}): SessionEvent {
  return { type, seq, time: 2000 + seq, data, ...extras };
}

function encoded(id: string): string {
  return `${encodeURIComponent(id)}.jsonl`;
}

function browserPath(id: string): string {
  return `/.succinix/sessions/${encoded(id)}`;
}

function setup(options: {
  isLive?: (id: string) => boolean;
  liveEvents?: (id: string) => readonly SessionEvent[] | undefined;
  onFlush?: () => Promise<void> | void;
  segmented?: boolean;
} = {}) {
  const fake = new FakeFS();
  const flushes: number[] = [];
  const deps: SessionPersistenceServiceDeps = {
    getFs: () => fake as unknown as FileSystemAPI,
    getClient: () => undefined,
    stateRoot: '/workspace/.succinix/sessions',
    isLive: options.isLive,
    liveEvents: options.liveEvents,
    onFlush: options.onFlush ?? (() => {
      flushes.push(flushes.length);
    }),
    segmented: options.segmented,
  };
  const service = new SuccinixSessionPersistence(deps);
  return { fake, service, flushes };
}

async function appendReady(service: SuccinixSessionPersistence, id: string, count: number): Promise<SessionHeader> {
  const meta = header(id);
  await service.create(meta);
  const events: SessionEvent[] = [];
  for (let seq = 0; seq < count; seq += 2) {
    events.push(event('turn/start', seq, { turn: seq / 2 }));
    events.push(event('turn/end', seq + 1, { turn: seq / 2 }));
  }
  await service.append(meta.id, events);
  return meta;
}

function turnLog(extraEvents: SessionEvent[], tornTail?: string): string {
  const meta = header('s-1');
  const lines = [
    JSON.stringify(meta),
    ...extraEvents.map((entry) => JSON.stringify(entry)),
  ];
  if (tornTail !== undefined) lines.push(tornTail);
  return lines.join('\n') + '\n';
}

function interruptedEvents(): SessionEvent[] {
  return [
    event('turn/start', 0, { turn: 1 }),
    event('step/start', 1, { turn: 1, step: 2 }),
    event('tool/call', 2, { callId: 'call-1', turn: 1, step: 2 }),
  ];
}

describe('ctx.sessionPersistence lifecycle', () => {
  it('keeps lazy creates invisible until the first append materializes them', async () => {
    const { fake, service } = setup();
    const meta = header('lazy');
    await service.create(meta);
    expect(await service.list()).toEqual([]);
    expect(await service.listSnapshots()).toEqual([]);
    expect(await service.readRaw(meta.id)).toBeUndefined();
    expect(fake.has(browserPath('lazy'))).toBe(false);

    await service.append(meta.id, [event('turn/start', 0, { turn: 0 })]);
    expect((await service.list()).map((entry) => entry.id)).toEqual([meta.id]);
    expect(fake.has(browserPath('lazy'))).toBe(true);
  });

  it('rejects duplicate creates and appends to unknown sessions', async () => {
    const { service } = setup();
    const meta = header('dup');
    await service.create(meta);
    await expect(service.create(meta)).rejects.toThrow('already exists');
    await expect(service.append(SessionId('unknown'), [event('turn/start', 0, { turn: 0 })])).rejects.toThrow('not found');
  });

  it('locates per-session encoded JSONL artifacts under the state root', async () => {
    const { service } = setup();
    const meta = header('a b/c');
    const location = service.locate(meta);
    expect(location).toEqual({ kind: 'jsonl', path: `/workspace/.succinix/sessions/${encodeURIComponent('a b/c')}.jsonl` });
    expect(service.supportsRawArtifacts).toBe(true);
  });
});

describe('ctx.sessionPersistence append contract', () => {
  it('appends contiguous batches and reads from any seq watermark', async () => {
    const { service } = setup();
    const meta = header('seq');
    await service.create(meta);
    await service.append(meta.id, [event('turn/start', 0, { turn: 0 })]);
    await service.append(meta.id, [event('turn/end', 1, { turn: 0 })]);
    const all = await service.readFrom(meta.id, 0);
    expect(all.events.map((entry) => entry.seq)).toEqual([0, 1]);
    expect((await service.readFrom(meta.id, 1)).events.map((entry) => entry.seq)).toEqual([1]);
    expect((await service.readFrom(meta.id, 2)).events).toEqual([]);
    expect((await service.readFrom(meta.id, 99)).events).toEqual([]);
    await expect(service.readFrom(meta.id, -1)).rejects.toThrow(TypeError);
  });

  it('rejects non-contiguous seq before touching the artifact', async () => {
    const { fake, service } = setup();
    const meta = header('gap');
    await service.create(meta);
    await expect(service.append(meta.id, [event('turn/start', 1, { turn: 0 })])).rejects.toThrow('append seq mismatch');
    expect(fake.has(browserPath('gap'))).toBe(false);
  });

  it('rejects non-JSON-serializable event data and names the event type', async () => {
    const { fake, service } = setup();
    const meta = header('bad-json');
    await service.create(meta);
    const bad = event('tool/call', 0, { big: 1n });
    await expect(service.append(meta.id, [bad])).rejects.toThrow(/event "tool\/call" data/);
    expect(fake.has(browserPath('bad-json'))).toBe(false);
  });

  it('serializes concurrent appends per session', async () => {
    const { service } = setup();
    const meta = header('concurrent');
    await service.create(meta);
    await Promise.all([
      service.append(meta.id, [event('turn/start', 0, { turn: 0 })]),
      service.append(meta.id, [event('turn/end', 1, { turn: 0 })]),
    ]);
    const log = await service.readFrom(meta.id, 0);
    expect(log.events.map((entry) => entry.seq)).toEqual([0, 1]);
  });

  it('flushes after durable file writes', async () => {
    const { service, flushes } = setup();
    const meta = header('flush');
    await service.create(meta);
    expect(flushes).toEqual([]);
    await service.append(meta.id, [event('turn/start', 0, { turn: 0 })]);
    expect(flushes.length).toBe(1);
  });
});

describe('ctx.sessionPersistence raw artifacts and revisions', () => {
  it('readRaw returns verbatim content with a suffix-free filename', async () => {
    const { fake, service } = setup();
    const meta = header('raw');
    await service.create(meta);
    const first = event('turn/start', 0, { turn: 0 });
    await service.append(meta.id, [first]);
    const artifact = await service.readRaw(meta.id);
    expect(artifact?.filename).toBe('raw');
    expect(artifact?.content).toBe(fake.raw(browserPath('raw')));
    expect(artifact?.content).toContain(JSON.stringify(first));
    expect(artifact?.meta.id).toBe(meta.id);
  });

  it('listSnapshots is read-only and revisions are source-qualified', async () => {
    const { fake, service } = setup();
    const meta = header('rev-a');
    await service.create(meta);
    await service.append(meta.id, [event('turn/start', 0, { turn: 0 })]);
    const beforeRaw = fake.raw(browserPath('rev-a'));
    const first = await service.listSnapshots();
    await service.inspect(meta.id);
    const second = await service.listSnapshots();
    expect(second).toEqual(first);
    expect(fake.raw(browserPath('rev-a'))).toBe(beforeRaw);

    const other = header('rev-b');
    await service.create(other);
    await service.append(other.id, [event('turn/start', 0, { turn: 0 })]);
    const [a, b] = await service.listSnapshots();
    expect(a?.revision).not.toBe(b?.revision);
    expect((await service.listSnapshots())[0]?.revision).toBe(a?.revision);
  });
});

describe('ctx.sessionPersistence repair and format refusal', () => {
  it('inspect never commits torn-tail repair; load truncates and closes the turn', async () => {
    const { fake, service } = setup();
    const id = 's-1';
    await fake.writeFile(browserPath(id), turnLog(interruptedEvents(), '{"type":"tool/result","seq":3,'));
    const before = await service.listSnapshots();
    const inspected = await service.inspect(SessionId(id));
    expect(inspected.events.length).toBe(6);
    expect(inspected.events.at(-1)?.type).toBe('turn/end');
    expect(fake.raw(browserPath(id))).toContain('"seq":3,');

    const loaded = await service.load(SessionId(id));
    expect(loaded.events.map((entry) => entry.type)).toEqual([
      'turn/start',
      'step/start',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
    ]);
    const raw = fake.raw(browserPath(id)) as string;
    expect(raw).not.toContain('{"type":"tool/result","seq":3,\n');
    expect(raw).toContain('{"type":"tool/result","seq":3,"time"');
    expect(raw.endsWith('\n')).toBe(true);
    expect((await service.listSnapshots())[0]?.revision).not.toBe(before[0]?.revision);
  });

  it('prepare after inspect still commits the cached cold repair', async () => {
    const { fake, service } = setup();
    const id = 's-1';
    await fake.writeFile(browserPath(id), turnLog(interruptedEvents()));
    const inspected = await service.inspect(SessionId(id));
    expect(inspected.events.length).toBe(6);
    expect(fake.raw(browserPath(id))).not.toContain('"tool/result"');
    const preparation = await service.prepare(SessionId(id));
    expect(preparation.session).toBeDefined();
    expect(fake.raw(browserPath(id))).toContain('"tool/result"');
    preparation[Symbol.dispose]();
  });

  it('rejects corruption in the committed prefix', async () => {
    const id = 's-1';
    const text = turnLog([event('turn/start', 0, { turn: 0 })], '{broken') + '{"type":"turn/end","seq":1,"time":2001,"data":{"turn":0}}\n';
    const fake = new FakeFS();
    const deps: SessionPersistenceServiceDeps = {
      getFs: () => fake as unknown as FileSystemAPI,
      getClient: () => undefined,
      stateRoot: '/workspace/.succinix/sessions',
    };
    const service2 = new SuccinixSessionPersistence(deps);
    await fake.writeFile(browserPath(id), text);
    await expect(service2.load(SessionId(id))).rejects.toBeInstanceOf(SessionPersistenceCorruptionError);
  });

  it('refuses unsupported format versions and unknown required event types', async () => {
    const fake = new FakeFS();
    const deps: SessionPersistenceServiceDeps = {
      getFs: () => fake as unknown as FileSystemAPI,
      getClient: () => undefined,
      stateRoot: '/workspace/.succinix/sessions',
    };
    const local = new SuccinixSessionPersistence(deps);

    const unknownText = JSON.stringify(header('unknown')) + '\n'
      + JSON.stringify(event('custom/next', 0, {})) + '\n';
    await fake.writeFile(browserPath('unknown'), unknownText);
    await expect(local.load(SessionId('unknown'))).rejects.toBeInstanceOf(SessionFormatUnsupportedError);

    const ignorableText = JSON.stringify(header('ignorable')) + '\n'
      + JSON.stringify(event('custom/next', 0, {}, { ignorable: true })) + '\n';
    await fake.writeFile(browserPath('ignorable'), ignorableText);
    const loaded = await local.load(SessionId('ignorable'));
    expect(loaded.events[0]?.type).toBe('custom/next');

    const future = header('future', { version: 999 });
    await fake.writeFile(browserPath('future'), JSON.stringify(future) + '\n');
    await expect(local.load(SessionId('future'))).rejects.toBeInstanceOf(SessionFormatUnsupportedError);
    await expect(local.load(SessionId('future'))).rejects.toThrow(/upgrade the harness/);
  });
});

describe('ctx.sessionPersistence live sessions', () => {
  it('load rejects an open live turn; inspect yields the live snapshot without repair', async () => {
    const live = [
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 2 }),
    ];
    const { service } = setup({
      isLive: () => true,
      liveEvents: () => live,
    });
    const meta = header('live');
    await service.create(meta);
    await expect(service.load(meta.id)).rejects.toThrow('live turn is open');
    await expect(service.prepare(meta.id)).rejects.toThrow('live');
    const inspected = await service.inspect(meta.id);
    expect(inspected.events).toEqual(live);
  });

  it('load accepts a balanced live log as a durable snapshot', async () => {
    const live = [
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1 }),
    ];
    const { service } = setup({
      isLive: () => true,
      liveEvents: () => live,
    });
    const meta = header('live-balanced');
    await service.create(meta);
    const loaded = await service.load(meta.id);
    expect(loaded.events).toEqual(live);
  });

  it('fails closed when a live identity has no live event view', async () => {
    const { service } = setup({ isLive: () => true });
    const meta = header('live-no-view');
    await service.create(meta);
    await expect(service.inspect(meta.id)).rejects.toThrow('no live event view');
    await expect(service.load(meta.id)).rejects.toThrow('live');
  });
});

describe('ctx.sessionPersistence segmented v0.7 storage', () => {
  it('stores the dsh session as a manifest plus JSONL segments while preserving the public raw/read contract', async () => {
    const { fake, service } = setup({ segmented: true });
    const meta = header('segmented');
    await service.create(meta);
    await service.append(meta.id, Array.from({ length: 501 }, (_, seq) => event('assistant/chunk', seq, { seq })));
    const root = '/.succinix/sessions/segments';
    expect(fake.has(`${root}/segmented.manifest.json`)).toBe(true);
    expect(fake.has(`${root}/segmented.0.jsonl`)).toBe(true);
    expect(fake.has(`${root}/segmented.1.jsonl`)).toBe(true);
    expect((await service.readFrom(meta.id, 500)).events.map((entry) => entry.seq)).toEqual([500]);
    const raw = await service.readRaw(meta.id);
    expect(raw?.content.split('\n').filter(Boolean)).toHaveLength(502);
    expect((await service.listSnapshots())[0]?.header.id).toBe(meta.id);
  });

  it('keeps 10k individual appends contiguous without rebuilding prior segments', async () => {
    const { service } = setup({ segmented: true });
    const meta = header('segmented-incremental');
    const readFrom = vi.spyOn(SegmentedSessionLog.prototype, 'readFrom');
    await service.create(meta);
    for (let seq = 0; seq < 10_000; seq++) await service.append(meta.id, [event('assistant/chunk', seq, { seq })]);
    expect(readFrom).not.toHaveBeenCalled();
    const restored = await service.readFrom(meta.id, 0);
    expect(restored.events).toHaveLength(10_000);
    expect(restored.events.at(-1)?.seq).toBe(9_999);
  });
});

describe('ctx.sessionPersistence preparation', () => {
  it('prepares a frozen session view and releases its reservation on dispose', async () => {
    const { service } = setup();
    const meta = await appendReady(service, 'prep', 2);
    const preparation = await service.prepare(meta.id);
    const view = preparation.session as { id: string; header: SessionHeader; events: readonly SessionEvent[] };
    expect(Object.isFrozen(view)).toBe(true);
    expect(view.id).toBe(meta.id);
    expect(view.header.id).toBe(meta.id);
    expect(view.events.map((entry) => entry.seq)).toEqual([0, 1]);
    await expect(service.append(meta.id, [event('turn/end', 2, { turn: 0 })])).rejects.toThrow('reserved');

    preparation[Symbol.dispose]();
    preparation[Symbol.dispose]();
    await service.append(meta.id, [event('turn/end', 2, { turn: 0 })]);
    expect((await service.readFrom(meta.id, 0)).events.length).toBe(3);
  });

  it('refuses to prepare missing or live sessions', async () => {
    const cold = setup();
    await expect(cold.service.prepare(SessionId('missing'))).rejects.toThrow('not found');
    const live = setup({ isLive: () => true });
    await expect(live.service.prepare(SessionId('live'))).rejects.toThrow('live');
  });
});
