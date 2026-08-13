// invariant: per-target mutation locking, atomic temp+rename writes, and
// LF-normalized fs version hashing for the dsh ctx.fs provider.
import type { FileSystemAPI } from '@webcontainer/api';
import { FsError, FsVersion } from './dsh-types.js';

const encoder = new TextEncoder();

export function normalizeLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function hashBytes(parts: readonly string[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const part of parts) {
    for (const byte of encoder.encode(part)) {
      hash ^= BigInt(byte);
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

export function versionFor(targetKey: string, content: string): FsVersion {
  return FsVersion(hashBytes([targetKey, '\0', normalizeLf(content)]));
}

export function versionForBytes(targetKey: string, bytes: Uint8Array): FsVersion {
  let hash = 0xcbf29ce484222325n;
  for (const part of [targetKey, '\0']) {
    for (const byte of encoder.encode(part)) {
      hash ^= BigInt(byte);
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
  }
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return FsVersion(hash.toString(16).padStart(16, '0'));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNotFoundError(error: unknown): boolean {
  return /ENOENT|not found|no such file/i.test(describeError(error));
}

export function isDirectoryError(error: unknown): boolean {
  return /EISDIR|illegal operation on a directory/i.test(describeError(error));
}

export function isNotDirectoryError(error: unknown): boolean {
  return /ENOTDIR|not a directory/i.test(describeError(error));
}

export async function readRaw(fs: FileSystemAPI, path: string): Promise<Uint8Array> {
  const value = await fs.readFile(path);
  if (value instanceof Uint8Array) return value;
  return encoder.encode(String(value));
}

export function throwIfAborted(signal: AbortSignal | undefined, phase = 'operation'): void {
  if (signal?.aborted) throw new FsError(`${phase} aborted`, 'FS_ABORTED', { cause: signal.reason });
}

export class TargetMutationLock {
  private readonly tail = new Map<string, Promise<unknown>>();

  async run<T>(targetKey: string, fn: () => Promise<T>): Promise<T> {
    const key = targetKey;
    const previous = this.tail.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(() => gate);
    this.tail.set(key, next);
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.tail.get(key) === next) this.tail.delete(key);
    }
  }
}

export async function atomicWrite(fs: FileSystemAPI, path: string, content: string, displayPath = path): Promise<void> {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const temp = `${path}.succinix-tmp-${suffix}`;
  try {
    await fs.writeFile(temp, content);
    try {
      await fs.rename(temp, path);
    } catch (error) {
      try {
        await fs.rm(temp);
      } catch {
        /* temp cleanup is best effort */
      }
      throw error;
    }
  } catch (error) {
    if (isDirectoryError(error) || isNotDirectoryError(error)) {
      throw new FsError(`target is not a regular file: ${displayPath}`, 'FS_NOT_REGULAR_FILE', { cause: error });
    }
    if (isNotFoundError(error)) {
      throw new FsError(`target not found: ${displayPath}`, 'FS_NOT_FOUND', { cause: error });
    }
    throw new FsError(`file write failed: ${displayPath} (${describeError(error)})`, 'FS_IO_ERROR', { cause: error });
  }
}

export async function statBrowserPath(
  fs: FileSystemAPI,
  path: string
): Promise<{ type: 'file' | 'directory' | 'other'; size?: number } | undefined> {
  try {
    const bytes = await readRaw(fs, path);
    return { type: 'file', size: bytes.length };
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    if (isDirectoryError(error)) return { type: 'directory' };
    try {
      await fs.readdir(path);
      return { type: 'directory' };
    } catch (dirError) {
      if (isNotFoundError(dirError)) return undefined;
      return { type: 'other' };
    }
  }
}

export function decodeText(bytes: Uint8Array, path: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new FsError(`target is not valid UTF-8 text: ${path}`, 'FS_NOT_TEXT', { cause: error });
  }
  if (text.includes('\0')) {
    throw new FsError(`target is binary or contains NUL: ${path}`, 'FS_NOT_TEXT');
  }
  return text;
}

export function decodeTextOrNull(bytes: Uint8Array, path: string): string | null {
  try {
    return decodeText(bytes, path);
  } catch (error) {
    if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null;
    throw error;
  }
}

export function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}
