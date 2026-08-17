// D4/D5：同页多实例快照内容隔离 —— scopeRoot 只遍历实例 scope（/workspace），
// instanceScope 排除其他实例的 .succinix-* 状态根 / 其他用户的 home；
// tinbase 目录保留在各自实例的快照内容中，不再被基础 exclusions 误伤。
// 覆盖：① 共享 FS 上 A 的快照不收录 B 的状态根/home/tinbase，也不收录 /workspace 外
// 系统目录；② 自己的状态根/home/共享工作区文件照常收录；③ 无 scope 上下文（默认实例 /
// 自定义 key）行为不变；④ 实例 scope 无 home 时不收录任何 users/*。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeFS, installFakeIDB } from './helpers/fakes.js';
import type { FileSystemAPI } from '@webcontainer/api';
import { createPersist, isExcludedPath } from '../src/persist/index.js';

const idb = installFakeIDB();

beforeEach(async () => {
  vi.stubGlobal('indexedDB', idb.indexedDB);
  idb.reset();
  return () => vi.unstubAllGlobals();
});

// 共享 FS：A/B 两个实例的状态根 + 两个用户 home + 共享工作区文件 + 各自 tinbase + 系统目录。
async function makeSharedFs(): Promise<FakeFS> {
  const fs = new FakeFS();
  await fs.writeFile('/workspace/shared.txt', 'shared');
  await fs.writeFile('/workspace/.succinix-a/etc/succinix.env', 'A_ENV=1');
  await fs.writeFile('/workspace/.succinix-b/etc/succinix.env', 'B_ENV=1');
  await fs.writeFile('/workspace/users/alice/notes.txt', 'alice');
  await fs.writeFile('/workspace/users/bob/notes.txt', 'bob');
  await fs.writeFile('/workspace/.succinix-a/tinbase/db', 'x');
  await fs.writeFile('/workspace/.succinix-b/tinbase/db', 'y');
  await fs.writeFile('/etc/system.conf', 'system');
  await fs.writeFile('/var/log/succinix.log', 'log');
  return fs;
}

describe('persist instance scope (D4/D5)', () => {
  it('instance-scoped snapshot keeps own roots + shared workspace, drops other instances', async () => {
    const fs = await makeSharedFs();
    const a = createPersist({
      storeKey: 'instance:a',
      scopeRoot: '/workspace',
      instanceScope: { stateRoot: '/workspace/.succinix-a', home: '/workspace/users/alice' },
    });
    const res = await a.save(fs as unknown as FileSystemAPI, true);
    expect(res.reason).toBe('force');
    expect(res.meta.fileCount).toBe(4); // shared.txt + own env + own notes + own tinbase

    const dst = new FakeFS();
    await a.load(dst as unknown as FileSystemAPI);
    expect(dst.raw('/workspace/shared.txt')).toBe('shared');
    expect(dst.raw('/workspace/.succinix-a/etc/succinix.env')).toBe('A_ENV=1');
    expect(dst.raw('/workspace/users/alice/notes.txt')).toBe('alice');
    expect(dst.has('/workspace/.succinix-b/etc/succinix.env')).toBe(false);
    expect(dst.has('/workspace/users/bob/notes.txt')).toBe(false);
    expect(dst.raw('/workspace/.succinix-a/tinbase/db')).toBe('x');
    expect(dst.has('/workspace/.succinix-b/tinbase/db')).toBe(false);
    expect(dst.has('/etc/system.conf')).toBe(false);
    expect(dst.has('/var/log/succinix.log')).toBe(false);
  });

  it('instance scope without home excludes all user homes', async () => {
    const fs = await makeSharedFs();
    const inst = createPersist({
      storeKey: 'instance:c',
      scopeRoot: '/workspace',
      instanceScope: { stateRoot: '/workspace/.succinix-c' },
    });
    await inst.save(fs as unknown as FileSystemAPI, true);
    const dst = new FakeFS();
    await inst.load(dst as unknown as FileSystemAPI);
    expect(dst.has('/workspace/users/alice/notes.txt')).toBe(false);
    expect(dst.has('/workspace/users/bob/notes.txt')).toBe(false);
  });

  it('default context keeps whole-FS snapshot (unchanged)', async () => {
    const fs = await makeSharedFs();
    const d = createPersist({});
    await d.save(fs as unknown as FileSystemAPI, true);
    const dst = new FakeFS();
    await d.load(dst as unknown as FileSystemAPI);
    expect(dst.raw('/etc/system.conf')).toBe('system');
    expect(dst.raw('/var/log/succinix.log')).toBe('log');
    expect(dst.raw('/workspace/shared.txt')).toBe('shared');
    expect(dst.raw('/workspace/.succinix-b/etc/succinix.env')).toBe('B_ENV=1');
    expect(dst.has('/workspace/.succinix-a/tinbase/db')).toBe(true);
  });

  it('D5: instance tinbase dirs are kept with their owning instance state', () => {
    expect(isExcludedPath('/workspace/.succinix-c-1/tinbase')).toBe(false);
    expect(isExcludedPath('/workspace/.succinix-c-1/tinbase/db')).toBe(false);
    expect(isExcludedPath('/workspace/.succinix-c-1/etc/succinix.env')).toBe(false);
    expect(isExcludedPath('/workspace/.tinbase/data')).toBe(false);
  });
});
