// S0.4: dsh ctx.fs provider over the in-memory WebContainer FS.
import { describe, it, expect } from 'vitest';
import type { FileSystemAPI } from '@webcontainer/api';
import { FakeFS } from './helpers/fakes.js';
import {
  FsError,
  FsTargetKey,
  type FsTarget,
  type FsWriteIntent,
  type SandboxExecutionPolicy,
} from '../src/plugin/dsh-types.js';
import { SuccinixFileSystem } from '../src/plugin/fs-service.js';

function serviceFor(fake = new FakeFS(), hostRoot = '/host'): { fs: SuccinixFileSystem; fake: FakeFS } {
  const fs = new SuccinixFileSystem({
    getFs: () => fake as unknown as FileSystemAPI,
    getClient: () => undefined,
    hostRoot,
  });
  return { fs, fake };
}

async function write(fake: FakeFS, path: string, content: string | Uint8Array): Promise<void> {
  await fake.writeFile(path, content);
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof FsError ? error.code : undefined;
  }
}

function policy(mode: SandboxExecutionPolicy['mode'], workspaceRoot = '/workspace'): SandboxExecutionPolicy {
  return { mode, workspaceRoot };
}

describe('ctx.fs resolve/identity', () => {
  it('canonicalizes relative paths, cwd overrides, and dot-dot segments', async () => {
    const { fs } = serviceFor();
    const a = await fs.resolve('a.txt', { cwd: '/workspace/proj' });
    const b = await fs.resolve('/workspace/proj/../proj/./a.txt');
    expect(a.targetKey).toBe(b.targetKey);
    expect(a.displayPath).toBe('/workspace/proj/a.txt');
  });

  it('rejects targets outside the execution workspace', async () => {
    const { fs } = serviceFor();
    expect(await codeOf(fs.resolve('/etc/passwd'))).toBe('FS_PERMISSION_DENIED');
    expect(await codeOf(fs.resolve('/workspace/../../etc/passwd'))).toBe('FS_PERMISSION_DENIED');
  });

  it('keeps processPath, fileUrl, and targetKey separate', async () => {
    const { fs } = serviceFor();
    const target = await fs.resolve('a b.txt');
    expect(fs.processPath(target)).toBe('/host/a b.txt');
    expect(fs.fileUrl(target)).toBe('file:///host/a%20b.txt');
    expect(target.targetKey.startsWith('/workspace/')).toBe(true);
  });

  it('contains is a pure canonical relation', async () => {
    const { fs } = serviceFor();
    const parent = { targetKey: FsTargetKey('/workspace'), displayPath: '/workspace' };
    const child = { targetKey: FsTargetKey('/workspace/a/b'), displayPath: '/workspace/a/b' };
    const sibling = { targetKey: FsTargetKey('/workspace-other'), displayPath: '/workspace-other' };
    const same = { targetKey: FsTargetKey('/workspace'), displayPath: '/workspace' };
    expect(fs.contains(parent, child)).toBe(true);
    expect(fs.contains(parent, sibling)).toBe(false);
    expect(fs.contains(parent, same)).toBe(true);
  });
});

describe('ctx.fs stat/lstat', () => {
  it('returns undefined for missing targets instead of throwing', async () => {
    const { fs } = serviceFor();
    const target = await fs.resolve('/workspace/missing');
    expect(await fs.stat(target)).toBeUndefined();
    expect(await fs.lstat('/workspace/missing')).toBeUndefined();
  });

  it('reports file and directory metadata without content', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.txt', 'hello');
    await fake.mkdir('/dir', { recursive: true });
    const file = await fs.resolve('/workspace/a.txt');
    const dir = await fs.resolve('/workspace/dir');
    const fileInfo = await fs.stat(file);
    const dirInfo = await fs.stat(dir);
    expect(fileInfo?.type).toBe('file');
    expect(fileInfo?.size).toBe(5);
    expect(dirInfo?.type).toBe('directory');
    expect((await fs.lstat('/workspace/a.txt'))?.type).toBe('file');
    expect((await fs.lstat('/workspace/dir'))?.type).toBe('directory');
  });

  it('lstat never reports symlinks in this execution world', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.txt', 'x');
    const info = await fs.lstat('/workspace/a.txt');
    expect(info?.type).not.toBe('symlink');
  });
});

describe('ctx.fs text reads', () => {
  it('readText returns UTF-8 text and rejects NUL/binary with FS_NOT_TEXT', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.txt', 'hello\n');
    const target = await fs.resolve('/workspace/a.txt');
    expect(await fs.readText(target)).toBe('hello\n');
    await write(fake, '/nul.txt', new Uint8Array([0x61, 0, 0x62]));
    expect(await codeOf(fs.readText(await fs.resolve('/workspace/nul.txt')))).toBe('FS_NOT_TEXT');
    await write(fake, '/binary.txt', new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(await codeOf(fs.readText(await fs.resolve('/workspace/binary.txt')))).toBe('FS_NOT_TEXT');
  });

  it('streamText decodes across chunk boundaries and aborts between chunks', async () => {
    const { fs, fake } = serviceFor();
    const text = 'a'.repeat(70_000) + '中文';
    await write(fake, '/big.txt', text);
    const target = await fs.resolve('/workspace/big.txt');
    let streamed = '';
    for await (const chunk of await fs.streamText(target)) streamed += chunk;
    expect(streamed).toBe(text);
    const abort = new AbortController();
    abort.abort();
    expect(await codeOf(fs.streamText(target, abort.signal).then((it) => it[Symbol.asyncIterator]().next()))).toBe('FS_ABORTED');
  });

  it('readBytes is bounded and signal is required at runtime', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.txt', '12345');
    const target = await fs.resolve('/workspace/a.txt');
    const bytes = await fs.readBytes(target, undefined, 5);
    expect(new TextDecoder().decode(bytes)).toBe('12345');
    expect(await codeOf(fs.readBytes(target, undefined, 4))).toBe('FS_TOO_LARGE');
    const fn = fs.readBytes as unknown as (target: FsTarget, maxBytes: number) => Promise<Uint8Array>;
    expect(await codeOf(fn(target, 10))).toBe('FS_ABORTED');
  });
});

describe('ctx.fs listDir', () => {
  it('lists direct children in stable name order with resolved targets', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/b.txt', 'b');
    await write(fake, '/a.txt', 'a');
    await fake.mkdir('/z-dir', { recursive: true });
    const dir = await fs.resolve('/workspace');
    const entries = await fs.listDir(dir);
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'z-dir']);
    expect(entries[2]?.type).toBe('directory');
    expect(entries[2]?.target.displayPath).toBe('/workspace/z-dir');
  });

  it('uses deterministic UTF-16 name ordering instead of collation', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/z.txt', 'z');
    await write(fake, '/É.txt', 'e');
    await write(fake, '/a.txt', 'a');
    await write(fake, '/中.txt', 'c');
    const entries = await fs.listDir(await fs.resolve('/workspace'));
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'z.txt', 'É.txt', '中.txt']);
  });

  it('maps missing and non-directory targets to structured errors', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.txt', 'a');
    const missing = await fs.resolve('/workspace/missing');
    const file = await fs.resolve('/workspace/a.txt');
    expect(await codeOf(fs.listDir(missing))).toBe('FS_NOT_FOUND');
    expect(await codeOf(fs.listDir(file))).toBe('FS_NOT_DIRECTORY');
  });
});

describe('ctx.fs writeText', () => {
  it('creates and updates atomically with LF-normalized outcomes', async () => {
    const { fs } = serviceFor();
    const target = await fs.resolve('/workspace/a.txt');
    const created = await fs.writeText(target, 'one\r\ntwo\r\n');
    expect(created.operation).toBe('create');
    expect(created.before).toBeNull();
    expect(created.after).toBe('one\ntwo\n');
    const updated = await fs.writeText(target, 'three\n');
    expect(updated.operation).toBe('update');
    expect(updated.before).toBe('one\ntwo\n');
    expect(updated.after).toBe('three\n');
    expect((await fs.stat(target))?.version).toBe(updated.version);
    expect(await fs.readText(target)).toBe('three\n');
  });

  it('enforces createIfAbsent and replaceIfVersion guards', async () => {
    const { fs } = serviceFor();
    const target = await fs.resolve('/workspace/a.txt');
    const create = { kind: 'createIfAbsent' } as const satisfies FsWriteIntent;
    expect((await fs.writeText(target, 'first', create)).operation).toBe('create');
    expect(await codeOf(fs.writeText(target, 'second', create))).toBe('FS_NOT_OBSERVED');
    const version = (await fs.stat(target))?.version;
    expect(await codeOf(fs.writeText(target, 'x', { kind: 'replaceIfVersion', version: FsTargetKey('stale') as never }))).toBe('FS_STALE_VERSION');
    await fs.writeText(target, 'guarded', { kind: 'replaceIfVersion', version: version! });
    expect(await fs.readText(target)).toBe('guarded');
  });

  it('overwrites binary content with before null', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.bin', new Uint8Array([0xff, 0xfe]));
    const target = await fs.resolve('/workspace/a.bin');
    const outcome = await fs.writeText(target, 'text');
    expect(outcome.before).toBeNull();
    expect(await fs.readText(target)).toBe('text');
  });

  it('fences mutations by sandbox policy', async () => {
    const { fs } = serviceFor();
    const target = await fs.resolve('/workspace/a.txt');
    const outside = await fs.resolve('/workspace/sub/b.txt');
    expect(await codeOf(fs.writeText(target, 'x', undefined, undefined, policy('read-only')))).toBe('FS_SANDBOX_DENIED');
    expect(await codeOf(fs.writeText(target, 'x', undefined, undefined, policy('workspace-write', '/workspace/sub')))).toBe('FS_SANDBOX_DENIED');
    expect(await codeOf(fs.writeText(outside, 'x', undefined, undefined, policy('workspace-write', '/workspace/sub')))).toBeUndefined();
    expect(await codeOf(fs.writeText(target, 'x', undefined, undefined, policy('danger-full-access')))).toBeUndefined();
  });

  it('rejects NUL content with FS_NOT_TEXT before mutating the target', async () => {
    const { fs, fake } = serviceFor();
    const missing = await fs.resolve('/workspace/new.txt');
    expect(await codeOf(fs.writeText(missing, 'ok\0bad'))).toBe('FS_NOT_TEXT');
    expect(fake.has('/new.txt')).toBe(false);

    await write(fake, '/a.txt', 'keep');
    const target = await fs.resolve('/workspace/a.txt');
    expect(await codeOf(fs.writeText(target, 'over\0write'))).toBe('FS_NOT_TEXT');
    expect(await fs.readText(target)).toBe('keep');
  });

  it('reports missing parents with the display path', async () => {
    const failing = {
      readFile: async () => {
        throw new Error('ENOENT: no such file /demo/missing.txt');
      },
      readdir: async () => {
        throw new Error('ENOENT: no such file /demo');
      },
      writeFile: async () => {
        throw new Error('ENOENT: no such file /demo/missing.txt');
      },
      rename: async () => {
        throw new Error('ENOENT: no such file /demo/missing.txt');
      },
      rm: async () => {},
    };
    const fs = new SuccinixFileSystem({
      getFs: () => failing as unknown as FileSystemAPI,
      getClient: () => undefined,
      hostRoot: '/host',
    });
    const target = await fs.resolve('/workspace/demo/missing.txt');
    await expect(fs.writeText(target, 'x')).rejects.toMatchObject({
      code: 'FS_NOT_FOUND',
      message: 'target not found: /workspace/demo/missing.txt',
    });
  });
});

describe('ctx.fs editText', () => {
  it('requires non-empty oldString and reports missing/ambiguous matches', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.txt', 'one one');
    const target = await fs.resolve('/workspace/a.txt');
    expect(await codeOf(fs.editText(target, { oldString: '', newString: 'x', replaceAll: false }))).toBe('FS_EDIT_NOT_FOUND');
    expect(await codeOf(fs.editText(target, { oldString: 'nope', newString: 'x', replaceAll: false }))).toBe('FS_EDIT_NOT_FOUND');
    expect(await codeOf(fs.editText(target, { oldString: 'one', newString: 'two', replaceAll: false }))).toBe('FS_AMBIGUOUS_EDIT');
  });

  it('applies literal replacement with LF normalization and version guard', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.txt', 'a\r\nb\r\n');
    const target = await fs.resolve('/workspace/a.txt');
    const stale = await codeOf(fs.editText(target, { oldString: 'a\nb', newString: 'x', replaceAll: false }, { version: FsTargetKey('stale') as never }));
    expect(stale).toBe('FS_STALE_VERSION');
    const version = (await fs.stat(target))?.version;
    const outcome = await fs.editText(target, { oldString: 'a\nb', newString: 'x', replaceAll: false }, { version: version! });
    expect(outcome.before).toBe('a\nb\n');
    expect(outcome.after).toBe('x\n');
    expect(await fs.readText(target)).toBe('x\n');
  });

  it('replaceAll edits every occurrence and stays atomic', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.txt', 'x x x');
    const target = await fs.resolve('/workspace/a.txt');
    const outcome = await fs.editText(target, { oldString: 'x', newString: 'y', replaceAll: true });
    expect(outcome.after).toBe('y y y');
    expect(await fs.readText(target)).toBe('y y y');
  });

  it('rejects NUL replacement text without changing the file', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.txt', 'one');
    const target = await fs.resolve('/workspace/a.txt');
    expect(await codeOf(fs.editText(target, { oldString: 'one', newString: 'o\0k', replaceAll: false }))).toBe('FS_NOT_TEXT');
    expect(await fs.readText(target)).toBe('one');
  });
});

describe('ctx.fs abort and concurrency', () => {
  it('throws FS_ABORTED for pre-aborted calls', async () => {
    const { fs, fake } = serviceFor();
    await write(fake, '/a.txt', 'a');
    const target = await fs.resolve('/workspace/a.txt');
    const controller = new AbortController();
    controller.abort();
    expect(await codeOf(fs.readText(target, controller.signal))).toBe('FS_ABORTED');
    expect(await codeOf(fs.writeText(target, 'b', undefined, controller.signal))).toBe('FS_ABORTED');
    expect(await codeOf(fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false }, undefined, controller.signal))).toBe('FS_ABORTED');
  });

  it('serializes mutations per target so guarded writes see fresh versions', async () => {
    const { fs } = serviceFor();
    const target = await fs.resolve('/workspace/a.txt');
    await fs.writeText(target, 'v1');
    const version = (await fs.stat(target))?.version;
    const writes = [0, 1, 2, 3].map((i) =>
      fs.writeText(target, `v${i}`, { kind: 'replaceIfVersion', version: version! })
    );
    const results = await Promise.allSettled(writes);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof FsError && r.reason.code === 'FS_STALE_VERSION').length).toBe(3);
    expect(await fs.readText(target)).toBe(await fs.readText(target));
  });
});
