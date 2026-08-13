// M1：persist persistenceKey 注入 —— 多实例（不同 storeKey）快照隔离。
// 覆盖：① 两实例写入互不覆盖、各自恢复；② 交错 save 独立去重、无跨实例污染；
// ③ A clear 不影响 B 后续保存；④ 默认 createPersist({}) 与模块级默认导出同 key。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeFS, installFakeIDB } from './helpers/fakes.js';
import type { FileSystemAPI } from '@webcontainer/api';
import { createPersist, saveSnapshot, loadSnapshot } from '../src/persist/index.js';

const idb = installFakeIDB();

beforeEach(async () => {
  vi.stubGlobal('indexedDB', idb.indexedDB);
  idb.reset();
  return () => vi.unstubAllGlobals();
});

describe('persist per-instance isolation (M1)', () => {
  it('two instances with different keys save and restore independently', async () => {
    const a = createPersist({ storeKey: 'instance-a' });
    const b = createPersist({ storeKey: 'instance-b' });

    const fsA = new FakeFS();
    await fsA.writeFile('/etc/a.txt', 'A');
    await a.save(fsA as unknown as FileSystemAPI, true);

    const fsB = new FakeFS();
    await fsB.writeFile('/etc/b.txt', 'B');
    await b.save(fsB as unknown as FileSystemAPI, true);

    const dstA = new FakeFS();
    await a.load(dstA as unknown as FileSystemAPI);
    expect(dstA.raw('/etc/a.txt')).toBe('A');
    expect(dstA.has('/etc/b.txt')).toBe(false);

    const dstB = new FakeFS();
    await b.load(dstB as unknown as FileSystemAPI);
    expect(dstB.raw('/etc/b.txt')).toBe('B');
    expect(dstB.has('/etc/a.txt')).toBe(false);
  });

  it('interleaved saves dedup independently without cross-instance pollution', async () => {
    const a = createPersist({ storeKey: 'instance-a' });
    const b = createPersist({ storeKey: 'instance-b' });

    const fsA = new FakeFS();
    await fsA.writeFile('/etc/a.txt', '1');
    const resA1 = await a.save(fsA as unknown as FileSystemAPI, true);
    expect(resA1.reason).toBe('force');

    const fsB = new FakeFS();
    await fsB.writeFile('/etc/b.txt', '2');
    const resB1 = await b.save(fsB as unknown as FileSystemAPI, true);
    expect(resB1.reason).toBe('force');

    // A 再存（内容未变）→ dedup，且不触碰 B 的快照。
    const putsBefore = idb.puts;
    const resA2 = await a.save(fsA as unknown as FileSystemAPI, false);
    expect(resA2.reason).toBe('dedup');
    expect(idb.puts).toBe(putsBefore);

    // B 快照仍可恢复（未被 A 的 dedup 覆盖）。
    const dstB = new FakeFS();
    await b.load(dstB as unknown as FileSystemAPI);
    expect(dstB.raw('/etc/b.txt')).toBe('2');

    // B 修改后保存 → 只影响 B；A 快照保持原样。
    await fsB.writeFile('/etc/b.txt', '2b');
    await b.save(fsB as unknown as FileSystemAPI, false);

    const dstA = new FakeFS();
    await a.load(dstA as unknown as FileSystemAPI);
    expect(dstA.raw('/etc/a.txt')).toBe('1');
  });

  it('clearing instance A does not block instance B saves', async () => {
    const a = createPersist({ storeKey: 'instance-a' });
    const b = createPersist({ storeKey: 'instance-b' });

    const fsA = new FakeFS();
    await fsA.writeFile('/etc/a.txt', 'A');
    await a.save(fsA as unknown as FileSystemAPI, true);

    const fsB = new FakeFS();
    await fsB.writeFile('/etc/b.txt', 'B');
    await b.save(fsB as unknown as FileSystemAPI, true);

    await a.clear();

    // B 清除后仍可正常保存并恢复。
    await fsB.writeFile('/etc/b.txt', 'B2');
    // 内容级修改由 force 保存收录（与既有 H1 语义一致：非 force 只跟踪结构变化）。
    const resB2 = await b.save(fsB as unknown as FileSystemAPI, true);
    expect(resB2.reason).toBe('force');

    const dstB = new FakeFS();
    await b.load(dstB as unknown as FileSystemAPI);
    expect(dstB.raw('/etc/b.txt')).toBe('B2');

    // A 已清除 → 恢复为空。
    const dstA = new FakeFS();
    await a.load(dstA as unknown as FileSystemAPI);
    expect(dstA.has('/etc/a.txt')).toBe(false);
  });

  it('default createPersist() shares the key with module-level default exports', async () => {
    const def = createPersist();
    const fs = new FakeFS();
    await fs.writeFile('/etc/x.txt', 'X');
    await saveSnapshot(fs as unknown as FileSystemAPI, true);

    const meta = await def.meta();
    expect(meta).not.toBeNull();
    expect(meta?.fileCount).toBeGreaterThan(0);

    // 默认上下文读取到同一份快照；模块级 load 也一致。
    const dst = new FakeFS();
    await loadSnapshot(dst as unknown as FileSystemAPI);
    expect(dst.raw('/etc/x.txt')).toBe('X');
  });
});
