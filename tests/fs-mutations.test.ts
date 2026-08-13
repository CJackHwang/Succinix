// S0.4: per-target mutation lock, atomic temp+rename writes, and version hashing.
import { describe, it, expect } from 'vitest';
import type { FileSystemAPI } from '@webcontainer/api';
import { FakeFS } from './helpers/fakes.js';
import {
  atomicWrite,
  hashBytes,
  isWithin,
  normalizeLf,
  TargetMutationLock,
  versionFor,
} from '../src/plugin/fs-mutations.js';
import { FsError } from '../src/plugin/dsh-types.js';

describe('normalizeLf and version hashing', () => {
  it('normalizes CRLF and lone CR to LF', () => {
    expect(normalizeLf('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('produces stable content- and identity-sensitive versions', () => {
    expect(versionFor('/workspace/a', 'x')).toBe(versionFor('/workspace/a', 'x'));
    expect(versionFor('/workspace/a', 'x')).not.toBe(versionFor('/workspace/a', 'y'));
    expect(versionFor('/workspace/a', 'x')).not.toBe(versionFor('/workspace/b', 'x'));
    expect(hashBytes(['a', 'b'])).toBe(hashBytes(['a', 'b']));
  });
});

describe('TargetMutationLock', () => {
  it('serializes operations per key and allows different keys in parallel', async () => {
    const lock = new TargetMutationLock();
    const order: string[] = [];
    const make = (key: string, label: string, delay: number) => () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          order.push(`${key}:${label}`);
          resolve();
        }, delay);
      });
    const first = lock.run('a', make('a', 'first', 20));
    const second = lock.run('a', make('a', 'second', 0));
    const other = lock.run('b', make('b', 'other', 0));
    await Promise.all([first, second, other]);
    expect(order.indexOf('a:first')).toBeLessThan(order.indexOf('a:second'));
    expect(order).toContain('b:other');
  });

  it('does not poison the chain when one operation fails', async () => {
    const lock = new TargetMutationLock();
    await expect(lock.run('a', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    await expect(lock.run('a', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('atomicWrite', () => {
  it('creates and replaces files with no visible temp artifact', async () => {
    const fake = new FakeFS();
    const fs = fake as unknown as FileSystemAPI;
    await atomicWrite(fs, '/workspace/a.txt', 'first');
    expect(fake.raw('/workspace/a.txt')).toBe('first');
    await atomicWrite(fs, '/workspace/a.txt', 'second');
    expect(fake.raw('/workspace/a.txt')).toBe('second');
    const names = await fake.readdir('/workspace');
    expect(names.map((entry) => entry.name)).not.toContain(expect.stringContaining('.succinix-tmp-'));
  });

  it('maps write failures to structured fs errors', async () => {
    const failing = {
      writeFile: async () => {
        throw new Error('ENOENT: no such file /workspace/missing/a.txt');
      },
      rename: async () => {},
      rm: async () => {},
    };
    await expect(atomicWrite(failing as unknown as FileSystemAPI, '/workspace/missing/a.txt', 'x', '/workspace/demo/missing.txt')).rejects.toMatchObject({
      code: 'FS_NOT_FOUND',
      message: 'target not found: /workspace/demo/missing.txt',
    });
    const directory = {
      writeFile: async () => {
        throw new Error('EISDIR: illegal operation on a directory /workspace');
      },
      rename: async () => {},
      rm: async () => {},
    };
    await expect(atomicWrite(directory as unknown as FileSystemAPI, '/workspace', 'x')).rejects.toMatchObject({
      code: 'FS_NOT_REGULAR_FILE',
    });
    const io = {
      writeFile: async () => {
        throw new Error('boom');
      },
      rename: async () => {},
      rm: async () => {},
    };
    const err = await atomicWrite(io as unknown as FileSystemAPI, '/workspace/a.txt', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FsError);
    expect((err as FsError).code).toBe('FS_IO_ERROR');
  });
});

describe('isWithin', () => {
  it('tests canonical containment without treating prefixes as parents', () => {
    expect(isWithin('/workspace', '/workspace')).toBe(true);
    expect(isWithin('/workspace', '/workspace/a')).toBe(true);
    expect(isWithin('/workspace', '/workspace-other')).toBe(false);
    expect(isWithin('/workspace/sub', '/workspace/sub/a')).toBe(true);
    expect(isWithin('/workspace/sub', '/workspace/sub-other')).toBe(false);
  });
});
