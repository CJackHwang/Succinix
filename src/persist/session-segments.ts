// Segmented JSONL session persistence (v0.7).  Storage is the execution-world
// FileSystemAPI; no browser-side session state is kept by this module.

import type { FileSystemAPI } from '@webcontainer/api';

export const SESSION_SEGMENT_FORMAT_VERSION = 2 as const;
export const DEFAULT_SESSION_SEGMENT_EVENTS = 500;
export const DEFAULT_SESSION_SEGMENT_BYTES = 1024 * 1024;

export interface SessionSegmentEvent {
  type: string;
  seq: number;
  [key: string]: unknown;
}

export interface SessionSegmentDescriptor {
  index: number;
  file: string;
  firstSeq: number;
  lastSeq: number;
  eventCount: number;
  byteLength: number;
}

export interface SessionSegmentManifest {
  formatVersion: typeof SESSION_SEGMENT_FORMAT_VERSION;
  id: string;
  createdAt: number;
  nextSeq: number;
  revision: string;
  segments: SessionSegmentDescriptor[];
  /** Session header is stored in the manifest so raw artifacts can be rebuilt
   * without a second browser-side state store. */
  header?: unknown;
}

export interface SegmentedSessionOptions {
  fs: FileSystemAPI;
  root?: string;
  segmentMaxEvents?: number;
  segmentMaxBytes?: number;
  onFlush?: () => Promise<void> | void;
  flushDebounceMs?: number;
}

export class SessionSegmentCorruptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SessionSegmentCorruptionError';
  }
}

export class SessionSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionSequenceError';
  }
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}
function join(root: string, name: string): string {
  return `${root.replace(/\/+$/, '')}/${name}`;
}
function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
function revisionFor(id: string, raw: string): string {
  // Deterministic non-cryptographic revision is sufficient for optimistic reads;
  // payload integrity is enforced by JSON parsing and sequence validation.
  let hash = 0xcbf29ce484222325n;
  for (const c of `${id}\u0000${raw}`) {
    hash ^= BigInt(c.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `succinix:jsonl:v2:${id}:${raw.length}:${hash.toString(16).padStart(16, '0')}`;
}

async function readText(fs: FileSystemAPI, path: string): Promise<string | undefined> {
  try {
    const data = await fs.readFile(path, 'utf8');
    return typeof data === 'string' ? data : new TextDecoder().decode(data);
  } catch {
    return undefined;
  }
}
async function atomicWrite(fs: FileSystemAPI, path: string, text: string): Promise<void> {
  const temp = `${path}.tmp-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(temp, text);
  await fs.rename(temp, path);
}
function parseLines(text: string, path: string): { events: SessionSegmentEvent[]; repaired: boolean } {
  if (!text) return { events: [], repaired: false };
  const lines = text.split('\n');
  const hasTail = lines[lines.length - 1] === '';
  if (hasTail) lines.pop();
  const events: SessionSegmentEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try {
      const value = JSON.parse(lines[i]) as SessionSegmentEvent;
      if (!value || typeof value !== 'object' || !Number.isInteger(value.seq) || typeof value.type !== 'string') throw new Error('invalid event');
      events.push(value);
    } catch (error) {
      // A crash may leave a partial final JSONL record.  Interior corruption is
      // never silently accepted.
      if (i === lines.length - 1 && !hasTail) return { events, repaired: true };
      throw new SessionSegmentCorruptionError(`invalid JSONL event in ${path} at line ${i + 1}`, { cause: error });
    }
  }
  return { events, repaired: false };
}

export class SegmentedSessionLog {
  readonly id: string;
  private readonly fs: FileSystemAPI;
  private readonly root: string;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly onFlush?: () => Promise<void> | void;
  private readonly flushDebounceMs: number;
  private manifestValue: SessionSegmentManifest | null = null;
  private operation: Promise<unknown> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(id: string, options: SegmentedSessionOptions) {
    if (!id || id.includes('/') || id === '.' || id === '..') throw new TypeError('session id must be a non-empty path-safe string');
    this.id = id;
    this.fs = options.fs;
    this.root = options.root ?? '/workspace/.succinix/sessions';
    this.maxEvents = options.segmentMaxEvents ?? DEFAULT_SESSION_SEGMENT_EVENTS;
    this.maxBytes = options.segmentMaxBytes ?? DEFAULT_SESSION_SEGMENT_BYTES;
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1) throw new RangeError('segmentMaxEvents must be a positive integer');
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new RangeError('segmentMaxBytes must be a positive integer');
    this.onFlush = options.onFlush;
    this.flushDebounceMs = options.flushDebounceMs ?? 500;
  }

  private manifestPath(): string { return join(this.root, `${encodeId(this.id)}.manifest.json`); }
  private segmentPath(index: number): string { return join(this.root, `${encodeId(this.id)}.${index}.jsonl`); }

  private async ensureRoot(): Promise<void> {
    await this.fs.mkdir(this.root, { recursive: true });
  }

  private async readManifest(): Promise<SessionSegmentManifest | null> {
    if (this.manifestValue) return this.manifestValue;
    const raw = await readText(this.fs, this.manifestPath());
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as SessionSegmentManifest;
      if (value.formatVersion !== SESSION_SEGMENT_FORMAT_VERSION || value.id !== this.id || !Array.isArray(value.segments)) throw new Error('unsupported manifest');
      this.manifestValue = value;
      return value;
    } catch (error) {
      throw new SessionSegmentCorruptionError(`invalid session manifest for "${this.id}"`, { cause: error });
    }
  }

  async create(createdAt = Date.now(), header?: unknown): Promise<SessionSegmentManifest> {
    return this.serial(async () => {
      const current = await this.readManifest();
      if (current) return structuredClone(current);
      await this.ensureRoot();
      const manifest: SessionSegmentManifest = { formatVersion: SESSION_SEGMENT_FORMAT_VERSION, id: this.id, createdAt, nextSeq: 0, revision: revisionFor(this.id, ''), segments: [], header: structuredClone(header) };
      await atomicWrite(this.fs, this.manifestPath(), JSON.stringify(manifest));
      this.manifestValue = manifest;
      return structuredClone(manifest);
    });
  }

  async manifest(): Promise<SessionSegmentManifest> {
    const value = await this.readManifest();
    if (!value) throw new SessionSegmentCorruptionError(`session "${this.id}" does not exist`);
    return structuredClone(value);
  }

  async append(events: readonly SessionSegmentEvent[]): Promise<SessionSegmentManifest> {
    if (!events.length) return this.manifest();
    return this.serial(async () => {
      let manifest = await this.readManifest();
      if (!manifest) {
        await this.ensureRoot();
        manifest = { formatVersion: SESSION_SEGMENT_FORMAT_VERSION, id: this.id, createdAt: Date.now(), nextSeq: 0, revision: revisionFor(this.id, ''), segments: [] };
      }
      let expected = manifest.nextSeq;
      for (const event of events) {
        if (!event || typeof event.type !== 'string' || !Number.isInteger(event.seq) || event.seq !== expected) throw new SessionSequenceError(`session "${this.id}" expected sequence ${expected}`);
        expected++;
      }
      let segment = manifest.segments.at(-1);
      let segmentText = segment ? await readText(this.fs, segment.file) ?? '' : '';
      let segmentEvents = segment ? parseLines(segmentText, segment.file).events : [];
      const touched = new Map<number, { file: string; text: string }>();
      for (const event of events) {
        const line = `${JSON.stringify(event)}\n`;
        const wouldExceed = segment && segmentEvents.length > 0 && (segmentEvents.length >= this.maxEvents || bytes(segmentText) + bytes(line) > this.maxBytes);
        if (wouldExceed) {
          segment = undefined;
          segmentText = '';
          segmentEvents = [];
        }
        if (!segment) {
          const index = manifest.segments.length;
          segment = { index, file: this.segmentPath(index), firstSeq: event.seq, lastSeq: event.seq, eventCount: 0, byteLength: 0 };
          manifest.segments.push(segment);
        }
        segmentText += line;
        segmentEvents.push(event);
        segment.lastSeq = event.seq;
        segment.eventCount = segmentEvents.length;
        segment.byteLength = bytes(segmentText);
        touched.set(segment.index, { file: segment.file, text: segmentText });
      }
      // One atomic write per touched segment (not per event) keeps large append
      // batches within the v0.7 latency budget while preserving crash-safe tails.
      for (const value of touched.values()) await atomicWrite(this.fs, value.file, value.text);
      manifest.nextSeq = expected;
      // 每次提交都要改变 revision；此处重建全部 segment 会让 10k 单条 append
      // 退化为二次复杂度。上一个 manifest revision 与本批精确 JSONL 行组成的
      // 链既确定，也覆盖此前所有已提交批次。
      manifest.revision = revisionFor(this.id, `${manifest.revision}\u0000${events.map((event) => JSON.stringify(event)).join('\n')}`);
      await atomicWrite(this.fs, this.manifestPath(), JSON.stringify(manifest));
      this.manifestValue = manifest;
      this.scheduleFlush();
      return structuredClone(manifest);
    });
  }

  private async readRawInternal(manifest: SessionSegmentManifest): Promise<string> {
    let raw = '';
    for (const segment of manifest.segments) raw += await readText(this.fs, segment.file) ?? '';
    return raw;
  }

  async readRaw(): Promise<string> {
    const manifest = await this.manifest();
    return this.readRawInternal(manifest);
  }

  async readFrom(sequence = 0): Promise<SessionSegmentEvent[]> {
    if (!Number.isInteger(sequence) || sequence < 0) throw new RangeError('sequence must be a non-negative integer');
    const manifest = await this.manifest();
    const events: SessionSegmentEvent[] = [];
    let expected: number | undefined;
    let repairedManifest = false;
    for (const segment of manifest.segments) {
      if (segment.lastSeq < sequence) continue;
      const raw = await readText(this.fs, segment.file);
      if (raw === undefined) throw new SessionSegmentCorruptionError(`missing session segment ${segment.file}`);
      const parsed = parseLines(raw, segment.file);
      for (const event of parsed.events) {
        if (expected !== undefined && event.seq !== expected) throw new SessionSequenceError(`non-contiguous sequence in session "${this.id}"`);
        if (event.seq >= sequence) events.push(event);
        expected = event.seq + 1;
      }
      if (parsed.repaired) {
        const repairedText = `${parsed.events.map((e) => JSON.stringify(e)).join('\n')}${parsed.events.length ? '\n' : ''}`;
        await atomicWrite(this.fs, segment.file, repairedText);
        segment.eventCount = parsed.events.length;
        segment.byteLength = bytes(repairedText);
        segment.lastSeq = parsed.events.at(-1)?.seq ?? segment.firstSeq - 1;
        repairedManifest = true;
      }
    }
    if (repairedManifest) {
      manifest.nextSeq = manifest.segments.reduce((next, segment) => Math.max(next, segment.lastSeq + 1), 0);
      manifest.revision = revisionFor(this.id, await this.readRawInternal(manifest));
      await atomicWrite(this.fs, this.manifestPath(), JSON.stringify(manifest));
      this.manifestValue = manifest;
    }
    return events;
  }

  async compact(): Promise<SessionSegmentManifest> {
    return this.serial(async () => {
      const manifest = await this.manifest();
      const events = await this.readFrom(0);
      const text = events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
      const temp = `${this.manifestPath()}.compact-${Math.random().toString(36).slice(2)}`;
      // Keep the new segment under a unique name until the manifest switch.  A
      // crash can therefore leave either the old manifest+segments or the new
      // manifest+segment, never a manifest pointing at a partially replaced file.
      const replacement = `${this.root.replace(/\/+$/, '')}/${encodeId(this.id)}.compact-${Math.random().toString(36).slice(2)}.jsonl`;
      const compacted: SessionSegmentDescriptor = { index: 0, file: replacement, firstSeq: events[0]?.seq ?? 0, lastSeq: events.at(-1)?.seq ?? -1, eventCount: events.length, byteLength: bytes(text) };
      const next = { ...manifest, segments: events.length ? [compacted] : [], revision: revisionFor(this.id, text) };
      await this.fs.writeFile(replacement, text);
      await this.fs.writeFile(temp, JSON.stringify(next));
      await this.fs.rename(temp, this.manifestPath());
      this.manifestValue = next;
      // Cleanup is intentionally after the atomic manifest switch.  Failure to
      // remove stale segments is harmless; they are not reachable through it.
      for (const old of manifest.segments) {
        if (old.file !== replacement) {
          try { await this.fs.rm(old.file); } catch { /* best effort */ }
        }
      }
      return structuredClone(next);
    });
  }

  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    await this.onFlush?.();
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private scheduleFlush(): void {
    if (!this.onFlush) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.onFlush?.(); }, this.flushDebounceMs);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => undefined);
    return next;
  }
}
