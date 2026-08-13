// invariant: dsh ctx.fs provider over the WebContainer/Lifo execution world.
// Paths are canonicalized in Lifo space (/workspace maps to the container root);
// mutations are atomic and policy-fenced, and fs/* events are left to consumers.
import type { FileSystemAPI } from '@webcontainer/api';
import type { TerminalClient } from '../engine/index.js';
import { vfsToReal } from '../engine/host-route.js';
import {
  FsError,
  FsTargetKey,
  FsVersion,
  type FileSystem,
  type FsDirEntry as FsDirEntryType,
  type FsEditOutcome,
  type FsEditRequest,
  type FsInfo,
  type FsPathInfo,
  type FsTarget as FsTargetType,
  type FsWriteIntent,
  type FsWriteOutcome,
  type SandboxExecutionPolicy,
} from './dsh-types.js';
import {
  atomicWrite,
  decodeText,
  decodeTextOrNull,
  hashBytes,
  isNotDirectoryError,
  isNotFoundError,
  isWithin,
  normalizeLf,
  readRaw,
  TargetMutationLock,
  throwIfAborted,
  versionFor,
  versionForBytes,
} from './fs-mutations.js';

export interface FileSystemServiceDeps {
  getFs(): FileSystemAPI | undefined;
  getClient(): TerminalClient | undefined;
  workspaceRoot?: string;
  hostRoot?: string;
}

function joinExecutionPath(base: string, path: string): string {
  if (path.startsWith('/')) return path;
  return base.endsWith('/') ? base + path : `${base}/${path}`;
}

export function canonicalExecutionPath(path: string, cwd = '/workspace'): string {
  const joined = joinExecutionPath(cwd, path);
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return '/' + parts.join('/');
}

export function browserPathFor(executionPath: string): string {
  if (executionPath === '/workspace') return '/';
  if (executionPath.startsWith('/workspace/')) return executionPath.slice('/workspace'.length);
  return executionPath;
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class SuccinixFileSystem implements FileSystem {
  private readonly lock = new TargetMutationLock();
  private hostRootPromise: Promise<string> | null = null;
  private hostRootValue: string;
  readonly workspaceRoot: string;

  constructor(private readonly deps: FileSystemServiceDeps) {
    this.workspaceRoot = canonicalExecutionPath(deps.workspaceRoot ?? '/workspace');
    this.hostRootValue = deps.hostRoot ?? '/workspace';
  }

  get sandboxMode(): 'workspace-write' {
    return 'workspace-write';
  }

  private requireFs(): FileSystemAPI {
    const fs = this.deps.getFs();
    if (!fs) throw new FsError('execution world is not ready', 'FS_IO_ERROR');
    return fs;
  }

  private async ensureHostRoot(): Promise<string> {
    if (this.hostRootPromise) return this.hostRootPromise;
    const client = this.deps.getClient();
    if (!client) return this.hostRootValue;
    this.hostRootPromise = (async () => {
      try {
        const result = await client.exec('cwd');
        const hostRoot = result.hostRoot;
        if (typeof hostRoot === 'string' && hostRoot.length > 0) this.hostRootValue = hostRoot;
      } catch {
        /* fall back to the constructor value */
      }
      return this.hostRootValue;
    })();
    return this.hostRootPromise;
  }

  private assertWorkspace(canonical: string): FsTargetType {
    if (!isWithin('/workspace', canonical)) {
      throw new FsError(`target is outside the execution workspace: ${canonical}`, 'FS_PERMISSION_DENIED');
    }
    return { targetKey: FsTargetKey(canonical), displayPath: canonical };
  }

  private assertMutationPolicy(target: FsTargetType, policy?: SandboxExecutionPolicy): void {
    const mode = policy?.mode ?? this.sandboxMode;
    if (mode === 'read-only') {
      throw new FsError('sandbox policy denies file mutation', 'FS_SANDBOX_DENIED');
    }
    if (mode === 'workspace-write') {
      const root = canonicalExecutionPath(policy?.workspaceRoot ?? this.workspaceRoot);
      if (!isWithin(root, target.targetKey)) {
        throw new FsError('sandbox policy denies write outside workspace root', 'FS_SANDBOX_DENIED');
      }
    }
  }

  private assertTextContent(content: string, displayPath: string): void {
    if (content.includes('\0')) {
      throw new FsError(`target content is binary or contains NUL: ${displayPath}`, 'FS_NOT_TEXT');
    }
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetType> {
    throwIfAborted(opts?.signal, 'resolve');
    const target = this.assertWorkspace(canonicalExecutionPath(path, opts?.cwd ?? '/workspace'));
    await this.ensureHostRoot();
    return target;
  }

  processPath(target: FsTargetType): string {
    return vfsToReal(target.targetKey, this.hostRootValue);
  }

  fileUrl(target: FsTargetType): string {
    const processPath = this.processPath(target);
    return 'file://' + processPath.split('/').map((part) => encodeURIComponent(part)).join('/');
  }

  contains(parent: FsTargetType, child: FsTargetType): boolean {
    return isWithin(parent.targetKey, child.targetKey);
  }

  private async infoFor(canonical: string): Promise<{ info: FsInfo | undefined; bytes?: Uint8Array }> {
    const fs = this.requireFs();
    const path = browserPathFor(canonical);
    try {
      const bytes = await readRaw(fs, path);
      return { info: { version: versionForBytes(canonical, bytes), type: 'file', size: bytes.length }, bytes };
    } catch (error) {
      if (isNotFoundError(error)) return { info: undefined };
      try {
        const entries = await fs.readdir(path) as unknown as Array<string | { name: string }>;
        const names = entries.map((entry) => typeof entry === 'string' ? entry : entry.name).sort(compareNames);
        return {
          info: { version: FsVersion(hashBytes([canonical, '\0', names.join('\0')])), type: 'directory' },
        };
      } catch (dirError) {
        if (isNotFoundError(dirError)) return { info: undefined };
        if (isNotDirectoryError(dirError)) return { info: { version: FsVersion(hashBytes([canonical, '\0'])), type: 'other' } };
        throw new FsError(`stat failed for ${canonical}`, 'FS_IO_ERROR', { cause: dirError });
      }
    }
  }

  async stat(target: FsTargetType, signal?: AbortSignal): Promise<FsInfo | undefined> {
    throwIfAborted(signal, 'stat');
    return (await this.infoFor(target.targetKey)).info;
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    throwIfAborted(signal, 'lstat');
    const canonical = this.assertWorkspace(canonicalExecutionPath(path, opts?.cwd ?? '/workspace')).targetKey;
    const { info } = await this.infoFor(canonical);
    if (!info) return undefined;
    return { version: info.version, type: info.type === 'file' ? 'file' : info.type === 'directory' ? 'directory' : 'other', size: info.size };
  }

  async readText(target: FsTargetType, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal, 'readText');
    const { info, bytes } = await this.infoFor(target.targetKey);
    if (!info) throw new FsError(`target not found: ${target.displayPath}`, 'FS_NOT_FOUND');
    if (info.type !== 'file') throw new FsError(`target is not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE');
    return decodeText(bytes ?? new Uint8Array(), target.displayPath);
  }

  async streamText(target: FsTargetType, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    throwIfAborted(signal, 'streamText');
    const text = await this.readText(target, signal);
    const decoder = new TextDecoder('utf-8');
    return (async function* () {
      const bytes = new TextEncoder().encode(text);
      if (bytes.length === 0) {
        throwIfAborted(signal, 'streamText');
        yield decoder.decode();
        return;
      }
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        throwIfAborted(signal, 'streamText');
        yield decoder.decode(bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length)), { stream: true });
      }
      yield decoder.decode();
    })();
  }

  async readBytes(target: FsTargetType, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (arguments.length < 3) throw new FsError('readBytes requires signal and maxBytes', 'FS_ABORTED');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new FsError('maxBytes must be a non-negative safe integer', 'FS_TOO_LARGE');
    throwIfAborted(signal, 'readBytes');
    const fs = this.requireFs();
    const path = browserPathFor(target.targetKey);
    let bytes: Uint8Array;
    try {
      bytes = await readRaw(fs, path);
    } catch (error) {
      if (isNotFoundError(error)) throw new FsError(`target not found: ${target.displayPath}`, 'FS_NOT_FOUND', { cause: error });
      throw new FsError(`read failed for ${target.displayPath}`, 'FS_IO_ERROR', { cause: error });
    }
    if (bytes.length > maxBytes) throw new FsError(`target exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE');
    return bytes;
  }

  async listDir(target: FsTargetType, signal?: AbortSignal): Promise<FsDirEntryType[]> {
    throwIfAborted(signal, 'listDir');
    const fs = this.requireFs();
    const path = browserPathFor(target.targetKey);
    let entries: Awaited<ReturnType<FileSystemAPI['readdir']>>;
    try {
      entries = await fs.readdir(path, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) throw new FsError(`target not found: ${target.displayPath}`, 'FS_NOT_FOUND', { cause: error });
      if (isNotDirectoryError(error)) throw new FsError(`target is not a directory: ${target.displayPath}`, 'FS_NOT_DIRECTORY', { cause: error });
      throw new FsError(`list failed for ${target.displayPath}`, 'FS_IO_ERROR', { cause: error });
    }
    return [...entries]
      .map((entry) => {
        const name = String(entry.name);
        const childKey = `${target.targetKey}${target.targetKey.endsWith('/') ? '' : '/'}${name}`;
        const type = typeof entry.isDirectory === 'function' && entry.isDirectory() ? 'directory' : typeof entry.isFile === 'function' && entry.isFile() ? 'file' : 'other';
        return {
          name,
          type,
          target: { targetKey: FsTargetKey(childKey), displayPath: childKey },
        } satisfies FsDirEntryType;
      })
      .sort((a, b) => compareNames(a.name, b.name));
  }

  async writeText(
    target: FsTargetType,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy
  ): Promise<FsWriteOutcome> {
    throwIfAborted(signal, 'writeText');
    this.assertMutationPolicy(target, sandboxPolicy);
    this.assertTextContent(content, target.displayPath);
    return this.lock.run(target.targetKey, async () => {
      throwIfAborted(signal, 'writeText');
      const fs = this.requireFs();
      const path = browserPathFor(target.targetKey);
      const { info, bytes } = await this.infoFor(target.targetKey);
      if (info && info.type !== 'file') {
        throw new FsError(`target is not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE');
      }
      if (expected?.kind === 'createIfAbsent' && info) {
        throw new FsError(`target already exists: ${target.displayPath}`, 'FS_NOT_OBSERVED');
      }
      if (expected?.kind === 'replaceIfVersion') {
        const current = info?.version;
        if (!current || current !== expected.version) {
          throw new FsError(`target version is stale: ${target.displayPath}`, 'FS_STALE_VERSION');
        }
      }
      const beforeText = info ? decodeTextOrNull(bytes ?? new Uint8Array(), target.displayPath) : null;
      const before = beforeText === null ? null : normalizeLf(beforeText);
      const after = normalizeLf(content);
      await atomicWrite(fs, path, after, target.displayPath);
      return { operation: before === null ? 'create' : 'update', version: versionFor(target.targetKey, after), before, after };
    });
  }

  async editText(
    target: FsTargetType,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy
  ): Promise<FsEditOutcome> {
    throwIfAborted(signal, 'editText');
    if (edit.oldString.length === 0) throw new FsError('edit oldString must be non-empty', 'FS_EDIT_NOT_FOUND');
    this.assertMutationPolicy(target, sandboxPolicy);
    this.assertTextContent(edit.newString, target.displayPath);
    return this.lock.run(target.targetKey, async () => {
      throwIfAborted(signal, 'editText');
      const { info, bytes } = await this.infoFor(target.targetKey);
      if (expected && (!info || info.version !== expected.version)) {
        throw new FsError(`target version is stale: ${target.displayPath}`, 'FS_STALE_VERSION');
      }
      if (!info) throw new FsError(`target not found: ${target.displayPath}`, 'FS_NOT_FOUND');
      if (info.type !== 'file') throw new FsError(`target is not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE');
      const before = normalizeLf(decodeText(bytes ?? new Uint8Array(), target.displayPath));
      const needle = normalizeLf(edit.oldString);
      let count = 0;
      for (let index = before.indexOf(needle); index !== -1; index = before.indexOf(needle, index + needle.length)) count++;
      if (count === 0) throw new FsError(`edit target text not found: ${target.displayPath}`, 'FS_EDIT_NOT_FOUND');
      if (!edit.replaceAll && count > 1) throw new FsError(`edit target text is ambiguous: ${target.displayPath}`, 'FS_AMBIGUOUS_EDIT');
      const after = normalizeLf(edit.replaceAll ? before.split(needle).join(edit.newString) : before.replace(needle, edit.newString));
      await atomicWrite(this.requireFs(), browserPathFor(target.targetKey), after, target.displayPath);
      return { version: versionFor(target.targetKey, after), before, after };
    });
  }
}
