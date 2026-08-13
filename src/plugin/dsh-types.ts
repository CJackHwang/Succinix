// invariant: vendored dsh 0.1.0-rc.6 service shapes (types only, no cordis import).
// These types mirror docs/contracts/dsh-0.1.0-rc.6; the shape gate keeps the
// method/code surface aligned with the official d.ts snapshot.

export type Branded<T extends string> = string & { readonly __brand?: T };

export class HarnessError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

// ─── ctx.fs ────────────────────────────────────────────────────────────────

export type FsTargetKey = Branded<'FsTargetKey'>;
export function FsTargetKey(key: string): FsTargetKey {
  return key as FsTargetKey;
}

export type FsVersion = Branded<'FsVersion'>;
export function FsVersion(value: string): FsVersion {
  return value as FsVersion;
}

export type FsObservation =
  | { readonly kind: 'present'; readonly version: FsVersion }
  | { readonly kind: 'absent' };

export interface FsTarget {
  readonly targetKey: FsTargetKey;
  readonly displayPath: string;
}

export interface FsInfo {
  readonly version: FsVersion;
  readonly type: 'file' | 'directory' | 'other';
  readonly size?: number;
}

export interface FsPathInfo {
  readonly version: FsVersion;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly size?: number;
}

export interface FsDirEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'other';
  readonly target: FsTarget;
  readonly version?: FsVersion;
  readonly size?: number;
}

export type FsWriteIntent =
  | { readonly kind: 'createIfAbsent' }
  | { readonly kind: 'replaceIfVersion'; readonly version: FsVersion };

export interface FsWriteOutcome {
  readonly operation: 'create' | 'update';
  readonly version: FsVersion;
  readonly before: string | null;
  readonly after: string;
}

export interface FsEditRequest {
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}

export interface FsEditOutcome {
  readonly version: FsVersion;
  readonly before: string;
  readonly after: string;
}

export type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED'
  | 'FS_SANDBOX_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED';

export class FsError extends HarnessError {
  readonly code: FsErrorCode;

  constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
    super(message, code, options);
    this.code = code;
  }
}

export interface FileSystem {
  readonly sandboxMode: SandboxMode | undefined;
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  fileUrl(target: FsTarget): string;
  contains(parent: FsTarget, child: FsTarget): boolean;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>;
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy
  ): Promise<FsWriteOutcome>;
  editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy
  ): Promise<FsEditOutcome>;
}

// ─── ctx.sandbox ───────────────────────────────────────────────────────────

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>;

export interface SandboxExecutionPolicy {
  readonly mode: SandboxMode;
  readonly workspaceRoot: string;
  readonly sessionId?: SessionId;
}

export interface SandboxPolicy extends SandboxExecutionPolicy {
  readonly mode: ConfinedSandboxMode;
}

export type SandboxEnforcement = 'full' | 'partial';

export interface RunnerFailureRule {
  readonly allowedExitCodes?: readonly number[];
  readonly fatalSignatures: readonly string[];
  readonly informationalLines?: readonly string[];
}

export interface ConfinedArgv {
  readonly argv: string[];
  readonly enforcement: SandboxEnforcement;
  readonly denialSignatures: readonly string[];
  readonly runnerFailureRules: readonly RunnerFailureRule[];
}

export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE';

export class SandboxUnavailableError extends HarnessError {
  constructor(mode: ConfinedSandboxMode, detail = 'no enforcing sandbox backend is available') {
    super(`sandbox unavailable for mode ${mode}: ${detail}`, SANDBOX_UNAVAILABLE);
  }
}

export interface SandboxProvider {
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv;
}

// ─── shared session identity ───────────────────────────────────────────────

export type SessionId = Branded<'SessionId'>;
export function SessionId(value: string): SessionId {
  return value as SessionId;
}

export interface SessionHeader {
  readonly version: number;
  readonly id: SessionId;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: SessionId;
  readonly seedLength?: number;
  readonly origin?: 'subagent';
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

export interface SessionEvent<T extends string = string> {
  readonly type: T;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
  readonly ignorable?: true;
}

export interface SessionPreparation {
  readonly session: unknown;
  [Symbol.dispose](): void;
}

// ─── ctx.terminals ─────────────────────────────────────────────────────────

export interface Agent {
  readonly id: SessionId;
  readonly status: 'idle' | 'running';
  readonly ctx: unknown;
}

export type TerminalSessionIdValue = Branded<'TerminalSessionId'>;
export type TerminalSessionId = TerminalSessionIdValue;
export function TerminalSessionId(value: string): TerminalSessionId {
  return value as TerminalSessionId;
}

export type TerminalErrorCode =
  | 'DUPLICATE_BACKEND'
  | 'DUPLICATE_NAME'
  | 'FOREIGN_SESSION'
  | 'NO_BACKEND'
  | 'NO_SESSION'
  | 'OWNER_NOT_LIVE'
  | 'SEND_ACTIVE'
  | 'SERVICE_DISPOSING';

export class TerminalError extends Error {
  readonly code: TerminalErrorCode;

  constructor(message: string, code: TerminalErrorCode) {
    super(message);
    this.name = 'TerminalError';
    this.code = code;
  }
}

export class TerminalBackendCleanupError extends AggregateError {
  readonly spawnError: unknown;
  readonly cleanupError: unknown;

  constructor(spawnError: unknown, cleanupError: unknown) {
    super([spawnError, cleanupError], 'terminal backend setup and cleanup both failed');
    this.name = 'TerminalBackendCleanupError';
    this.spawnError = spawnError;
    this.cleanupError = cleanupError;
  }
}

export type TerminalWaitReason = 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit';
export type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP';
export type TerminalSessionStatus =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null };

export interface TerminalSpawnRequest {
  readonly type: string;
  readonly name?: string;
  readonly cwd?: string;
}

export interface TerminalBackendSpawnSpec extends TerminalSpawnRequest {
  readonly sessionId: TerminalSessionIdValue;
  readonly owner: Agent;
  readonly signal?: AbortSignal;
}

export interface TerminalSendRequest {
  readonly text: string;
  readonly submit: boolean;
  readonly signal?: AbortSignal;
}

export interface TerminalSendRead {
  readonly delta: string;
  readonly truncated: boolean;
}

export interface TerminalSendResult {
  readonly viewport: string;
  readonly waitReason: TerminalWaitReason;
  readonly sessionStatus: TerminalSessionStatus;
  readonly truncated: boolean;
}

export interface TerminalSendOperation {
  readonly done: Promise<TerminalSendResult>;
  readOutput(): TerminalSendRead;
  cancel(): boolean;
}

export interface TerminalReadRequest {
  readonly offset?: number;
  readonly count?: number;
}

export interface TerminalReadResult {
  readonly text: string;
  readonly totalLines: number;
  readonly lineBegin: number;
  readonly lineEnd: number;
  readonly truncated: boolean;
}

export interface TerminalSignalResult {
  readonly delivered: true;
  readonly targetPgid: number;
}

export interface TerminalSessionSnapshot {
  readonly sessionId: TerminalSessionIdValue;
  readonly name?: string;
  readonly type: string;
  readonly pid?: number;
  readonly status: TerminalSessionStatus;
}

export interface TerminalBackendSession {
  readonly motd: string;
  readonly pid?: number;
  startSend(request: TerminalSendRequest): TerminalSendOperation;
  read(request: TerminalReadRequest): TerminalReadResult;
  signal(signal: TerminalSignal): Promise<TerminalSignalResult>;
  status(): TerminalSessionStatus;
  close(reason: string): Promise<void>;
}

export interface TerminalBackend {
  readonly type: string;
  spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession>;
}

export interface TerminalSpawnResult extends TerminalSessionSnapshot {
  readonly motd: string;
}

export interface TerminalSessionService {
  registerBackend(backend: TerminalBackend): () => void;
  listBackends(): string[];
  spawn(owner: Agent, request: TerminalSpawnRequest, signal?: AbortSignal): Promise<TerminalSpawnResult>;
  hasOwnerActivity(owner: Agent): boolean;
  startSend(owner: Agent, id: TerminalSessionId, request: TerminalSendRequest): TerminalSendOperation;
  read(owner: Agent, id: TerminalSessionId, request?: TerminalReadRequest): TerminalReadResult;
  signal(owner: Agent, id: TerminalSessionId, signal: TerminalSignal): Promise<TerminalSignalResult>;
  kill(owner: Agent, id: TerminalSessionId, reason?: string): Promise<boolean>;
  list(owner: Agent): TerminalSessionSnapshot[];
}

// ─── ctx.sessionPersistence ────────────────────────────────────────────────

export type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>;
export function SessionPersistenceRevision(value: string): SessionPersistenceRevision {
  return value as SessionPersistenceRevision;
}

export interface SessionPersistenceSnapshot {
  readonly header: SessionHeader;
  readonly revision: SessionPersistenceRevision;
}

export interface SessionInspection {
  readonly meta: SessionHeader;
  readonly events: readonly SessionEvent[];
}

export interface SessionRawArtifact {
  readonly meta: SessionHeader;
  readonly filename: string;
  readonly content: string;
}

export interface SessionLocation {
  readonly kind: string;
  readonly path: string;
}

export class SessionPersistenceCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionPersistenceCorruptionError';
  }
}

export class SessionFormatUnsupportedError extends Error {
  readonly location?: SessionLocation;

  constructor(message: string, location?: SessionLocation) {
    super(message);
    this.name = 'SessionFormatUnsupportedError';
    this.location = location;
  }
}

export interface SessionPersistence {
  locate(meta: SessionHeader): SessionLocation | undefined;
  readonly supportsRawArtifacts: boolean;
  readRaw(id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined>;
  create(meta: SessionHeader): Promise<void>;
  append(id: SessionId, events: readonly SessionEvent[]): Promise<void>;
  prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>;
  load(id: SessionId): Promise<SessionInspection>;
  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>;
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }>;
  list(signal?: AbortSignal): Promise<SessionHeader[]>;
  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>;
}
