// invariant: JSONL event-log format, validation, and repair helpers for the
// dsh ctx.sessionPersistence provider.
import {
  SessionFormatUnsupportedError,
  SessionId,
  SessionPersistenceCorruptionError,
  SessionPersistenceRevision,
  type SessionEvent,
  type SessionHeader,
  type SessionLocation,
} from './dsh-types.js';

export const SESSION_FORMAT_VERSION = 0;
export const JSONL_EXTENSION = '.jsonl';
export const DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5;

const KNOWN_SESSION_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'todo/write',
  'request/header',
  'request/context',
  'session/end-seed',
  'agent/inbox/spliced',
]);

export interface StoredLog {
  meta: SessionHeader;
  events: SessionEvent[];
  validLength: number;
  torn: boolean;
  revision: SessionPersistenceRevision;
  rawText: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, seen: Set<unknown> = new Set()): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function' || typeof value === 'undefined') {
    return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value) || !isJsonValue(value[index], seen)) return false;
    }
    return true;
  }
  if (!isPlainObject(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const child of Object.values(value)) {
    if (!isJsonValue(child, seen)) return false;
  }
  return true;
}

export function snapshotJson<T>(value: T, label = 'value'): T {
  if (!isJsonValue(value)) throw new TypeError(`${label} must be losslessly JSON-serializable`);
  return structuredClone(value) as T;
}

function isSessionId(value: unknown): value is SessionId {
  return typeof value === 'string' && value.length > 0;
}

export function isSessionHeader(value: unknown): value is SessionHeader {
  if (!isPlainObject(value)) return false;
  const header = value as Record<string, unknown>;
  if (!Number.isSafeInteger(header.version) || (header.version as number) < 0) return false;
  if (!isSessionId(header.id)) return false;
  if (!Number.isSafeInteger(header.createdAt) || (header.createdAt as number) < 0) return false;
  if (header.cwd !== undefined && (typeof header.cwd !== 'string' || !header.cwd.startsWith('/'))) return false;
  if (header.parentSession !== undefined && !isSessionId(header.parentSession)) return false;
  if (header.seedLength !== undefined && (!Number.isSafeInteger(header.seedLength) || (header.seedLength as number) < 0)) return false;
  if (header.origin !== undefined && header.origin !== 'subagent') return false;
  if (header.delegationDepth !== undefined && (!Number.isSafeInteger(header.delegationDepth) || (header.delegationDepth as number) < 0)) return false;
  if (header.agentPreset !== undefined && typeof header.agentPreset !== 'string') return false;
  return true;
}

function isEventRecord(value: unknown): value is SessionEvent {
  if (!isPlainObject(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== 'string' || event.type.length === 0) return false;
  if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0) return false;
  if (!Number.isSafeInteger(event.time)) return false;
  return 'data' in event;
}

function parseHeaderLine(line: string, id: SessionId): SessionHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new SessionPersistenceCorruptionError(`stored session "${id}" has an unreadable header line`, { cause: error });
  }
  if (!isSessionHeader(parsed)) {
    throw new SessionPersistenceCorruptionError(`stored session "${id}" has an invalid header line`);
  }
  if (parsed.id !== id) {
    throw new SessionPersistenceCorruptionError(`stored session identity mismatch: requested "${id}", header contains "${String(parsed.id)}"`);
  }
  return parsed;
}

export function eventLine(event: SessionEvent): string {
  const extras = event as SessionEvent & {
    sourceEventSeqs?: readonly number[];
    surfaceOp?: unknown;
  };
  return JSON.stringify({
    type: event.type,
    seq: event.seq,
    time: event.time,
    data: event.data,
    ...(event.ignorable === true ? { ignorable: true } : {}),
    ...(extras.sourceEventSeqs !== undefined ? { sourceEventSeqs: extras.sourceEventSeqs } : {}),
    ...(extras.surfaceOp !== undefined ? { surfaceOp: extras.surfaceOp } : {}),
  });
}

function findLastIndex<T>(entries: readonly T[], predicate: (entry: T) => boolean): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (predicate(entries[index]!)) return index;
  }
  return -1;
}

export function headerLine(meta: SessionHeader): string {
  return JSON.stringify(meta);
}

export function revisionFor(id: SessionId, text: string): SessionPersistenceRevision {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return SessionPersistenceRevision(`succinix:jsonl:${id}:${text.length}:${hash.toString(16).padStart(16, '0')}`);
}

export function artifactName(id: SessionId): string {
  return `${encodeURIComponent(id)}${JSONL_EXTENSION}`;
}

export function artifactBase(id: SessionId): string {
  return encodeURIComponent(id);
}

export function parseStoredLog(text: string, id: SessionId, location: SessionLocation): StoredLog {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) {
    throw new SessionPersistenceCorruptionError(`stored session "${id}" is empty`);
  }
  const meta = parseHeaderLine(lines[0]!, id);
  if (meta.version !== SESSION_FORMAT_VERSION) {
    throw new SessionFormatUnsupportedError(
      `session "${id}" uses format version ${meta.version}; upgrade the harness to read it (raw log: ${location.path})`,
      location
    );
  }
  const events: SessionEvent[] = [];
  let validLength = lines[0]!.length + 1;
  let torn = false;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    const lineStart = validLength;
    const lineWithBreak = line + '\n';
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1) {
        torn = true;
        break;
      }
      throw new SessionPersistenceCorruptionError(
        `stored session "${id}" has a malformed event at line ${index + 1}`,
        { cause: error }
      );
    }
    if (!isEventRecord(parsed)) {
      throw new SessionPersistenceCorruptionError(`stored session "${id}" has an invalid event at line ${index + 1}`);
    }
    const event = parsed as SessionEvent;
    if (event.seq !== events.length) {
      throw new SessionPersistenceCorruptionError(
        `stored session "${id}" has a sequence gap: expected ${events.length}, got ${event.seq} at line ${index + 1}`
      );
    }
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
      throw new SessionFormatUnsupportedError(
        `session "${id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log (raw log: ${location.path})`,
        location
      );
    }
    snapshotJson(event.data, `event "${event.type}" (seq ${event.seq}) data`);
    events.push(event);
    validLength = lineStart + lineWithBreak.length;
  }
  return {
    meta,
    events,
    validLength,
    torn,
    revision: revisionFor(id, text),
    rawText: text,
  };
}

interface InterruptedState {
  turns: Array<{ turn: number; seq: number }>;
  steps: Array<{ turn: number; step: number; seq: number }>;
  toolCalls: Array<{ callId: string; turn: number; step: number; seq: number }>;
}

function interruptedState(events: readonly SessionEvent[]): InterruptedState {
  const turns: Array<{ turn: number; seq: number }> = [];
  const steps: Array<{ turn: number; step: number; seq: number }> = [];
  const toolCalls: Array<{ callId: string; turn: number; step: number; seq: number }> = [];
  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    if (event.type === 'turn/start' && Number.isSafeInteger(data.turn)) {
      turns.push({ turn: data.turn as number, seq: event.seq });
    } else if (event.type === 'turn/end' && Number.isSafeInteger(data.turn)) {
      const index = findLastIndex(turns, (entry) => entry.turn === data.turn);
      if (index >= 0) turns.splice(index, 1);
    } else if (event.type === 'step/start' && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)) {
      steps.push({ turn: data.turn as number, step: data.step as number, seq: event.seq });
    } else if (event.type === 'step/end' && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)) {
      const index = findLastIndex(steps, (entry) => entry.turn === data.turn && entry.step === data.step);
      if (index >= 0) steps.splice(index, 1);
    } else if (event.type === 'tool/call' && typeof data.callId === 'string') {
      toolCalls.push({
        callId: data.callId,
        turn: Number.isSafeInteger(data.turn) ? (data.turn as number) : 0,
        step: Number.isSafeInteger(data.step) ? (data.step as number) : 0,
        seq: event.seq,
      });
    } else if (event.type === 'tool/result') {
      const message = isPlainObject(data.message) ? data.message : {};
      const callId = message.toolCallId;
      if (typeof callId === 'string') {
        const index = findLastIndex(toolCalls, (entry) => entry.callId === callId);
        if (index >= 0) toolCalls.splice(index, 1);
      }
    }
  }
  return { turns, steps, toolCalls };
}

export function syntheticClosers(events: readonly SessionEvent[], id: SessionId): SessionEvent[] {
  const open = interruptedState(events);
  const closers: SessionEvent[] = [];
  const now = Date.now();
  let seq = events.length;
  for (const call of open.toolCalls.reverse()) {
    closers.push({
      type: 'tool/result',
      seq: seq++,
      time: now,
      data: {
        turn: call.turn,
        step: call.step,
        message: {
          role: 'tool',
          toolCallId: call.callId,
          content: `TOOL_OUTCOME_UNKNOWN: tool call "${call.callId}" from session "${id}" was interrupted before a durable result was recorded. Verify side effects before retrying.`,
        },
        error: { name: 'ToolError', code: 'TOOL_OUTCOME_UNKNOWN' },
      },
    });
  }
  for (const step of open.steps.reverse()) {
    closers.push({
      type: 'step/end',
      seq: seq++,
      time: now,
      data: { turn: step.turn, step: step.step },
    });
  }
  for (const turn of open.turns.reverse()) {
    closers.push({
      type: 'turn/end',
      seq: seq++,
      time: now,
      data: { turn: turn.turn, reason: { kind: 'interrupted' } },
    });
  }
  return closers;
}

export function isBalanced(events: readonly SessionEvent[]): boolean {
  const open = interruptedState(events);
  return open.turns.length === 0 && open.steps.length === 0 && open.toolCalls.length === 0;
}
