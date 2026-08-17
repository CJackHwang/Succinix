// src/persist/index.ts 单元测试：排除规则 / 签名门控 / force 语义 / 空目录去重（N2）（mock FS + fake IDB）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeFS, installFakeIDB } from './helpers/fakes.js';
import type { FileSystemAPI } from '@webcontainer/api';
import {
  createPersist,
  saveSnapshot,
  loadSnapshot,
  clearSnapshot,
  getSnapshotMeta,
  isAgeForced,
  AUTO_SNAPSHOT_FORCE_INTERVAL_MS,
} from '../src/persist/index.js';

// persist 的 dbPromise 是模块级缓存，跨测试引用同一个 fake；beforeEach 用 reset() 清状态。
const idb = installFakeIDB();

beforeEach(async () => {
  vi.stubGlobal('indexedDB', idb.indexedDB);
  idb.reset();
  await clearSnapshot();
  return () => vi.unstubAllGlobals();
});

describe('persist exclusion rules', () => {
  it('excludes node_modules/dist/.git and runtime transport dirs', async () => {
    const src = new FakeFS();
    await src.writeFile('/keep.txt', 'keep me');
    await src.writeFile('/node_modules/lodash/index.js', 'nope');
    await src.writeFile('/dist/bundle.js', 'nope');
    await src.writeFile('/.git/config', 'nope');
    await src.writeFile('/.tinbase/db', 'nope');
    await src.writeFile('/host.js', 'nope');
    await src.writeFile('/lifo-core.js', 'nope');
    await src.writeFile('/cmd.json', 'nope');
    await src.writeFile('/result-42.json', 'nope');
    await src.writeFile('/.succinix-control/request-control-test.json', 'nope');
    await src.writeFile('/.succinix-terminal/default/session/open.json', 'nope');

    const res = await saveSnapshot(src as unknown as FileSystemAPI, true);
    expect(res.skipped).toBe(false);

    const dst = new FakeFS();
    await loadSnapshot(dst as unknown as FileSystemAPI);
    expect(dst.raw('/keep.txt')).toBe('keep me');
    expect(dst.has('/node_modules')).toBe(false);
    expect(dst.has('/dist')).toBe(false);
    expect(dst.has('/.git')).toBe(false);
    expect(dst.has('/.tinbase')).toBe(true);
    expect(dst.has('/host.js')).toBe(false);
    expect(dst.has('/lifo-core.js')).toBe(false);
    expect(dst.has('/cmd.json')).toBe(false);
    expect(dst.has('/result-42.json')).toBe(false);
    expect(dst.has('/.succinix-control')).toBe(false);
    expect(dst.has('/.succinix-terminal')).toBe(false);
  });

  it('keeps .git only when explicitly configured', async () => {
    const src = new FakeFS();
    await src.writeFile('/project/.git/config', 'remote=origin');
    const persist = createPersist({ dbName: `persist-git-${Math.random()}`, includeGit: true });
    await persist.save(src as unknown as FileSystemAPI, true);

    const dst = new FakeFS();
    await persist.load(dst as unknown as FileSystemAPI);
    expect(dst.raw('/project/.git/config')).toBe('remote=origin');
  });
});

describe('persist roundtrip + empty dirs', () => {
  it('saves files and restores them into a fresh filesystem', async () => {
    const src = new FakeFS();
    await src.writeFile('/workspace/main/hello.txt', 'hello');
    await src.writeFile('/etc/succinix.env', 'A=1');
    const res = await saveSnapshot(src as unknown as FileSystemAPI, true);
    expect(res.skipped).toBe(false);

    const dst = new FakeFS();
    await loadSnapshot(dst as unknown as FileSystemAPI);
    expect(dst.raw('/workspace/main/hello.txt')).toBe('hello');
    expect(dst.raw('/etc/succinix.env')).toBe('A=1');
  });

  it('persists empty directories (TASK19) and restores them', async () => {
    const src = new FakeFS();
    await src.writeFile('/work/a.txt', 'A');
    await src.mkdir('/empty-dir', { recursive: true });
    await saveSnapshot(src as unknown as FileSystemAPI, true);

    const dst = new FakeFS();
    await loadSnapshot(dst as unknown as FileSystemAPI);
    expect(dst.has('/empty-dir')).toBe(true);
    expect(dst.raw('/work/a.txt')).toBe('A');
  });

  it('getSnapshotMeta is null before any save and populated after', async () => {
    expect(await getSnapshotMeta()).toBeNull();
    const src = new FakeFS();
    await src.writeFile('/f.txt', 'x');
    await saveSnapshot(src as unknown as FileSystemAPI, true);
    const meta = await getSnapshotMeta();
    expect(meta).not.toBeNull();
    expect(meta?.fileCount).toBe(1);
  });

  it('loadSnapshot returns null when no snapshot exists', async () => {
    expect(await loadSnapshot(new FakeFS() as unknown as FileSystemAPI)).toBeNull();
  });
});

describe('persist dedup + signature gating', () => {
  it('unchanged content skips the second write (dedup)', async () => {
    const src = new FakeFS();
    await src.writeFile('/a.txt', 'same');
    await saveSnapshot(src as unknown as FileSystemAPI, false);
    const putsAfterFirst = idb.puts;
    const res = await saveSnapshot(src as unknown as FileSystemAPI, false);
    expect(res.skipped).toBe(false);
    expect(idb.puts).toBe(putsAfterFirst); // 内容未变：不再 put
  });

  it('new file changes the listing signature and triggers a write', async () => {
    const src = new FakeFS();
    await src.writeFile('/a.txt', 'same');
    await saveSnapshot(src as unknown as FileSystemAPI, false);
    const putsAfterFirst = idb.puts;
    await src.writeFile('/b.txt', 'new file');
    await saveSnapshot(src as unknown as FileSystemAPI, false);
    expect(idb.puts).toBe(putsAfterFirst + 1);
  });

  it('content-only change of the same-size file is skipped by non-force, captured by force (H1)', async () => {
    const src = new FakeFS();
    await src.writeFile('/a.txt', 'AAAA');
    await saveSnapshot(src as unknown as FileSystemAPI, true);
    // 等长内容修改：readdir 签名不变（无 size），非 force 复用旧结果 → 跳过写。
    await src.writeFile('/a.txt', 'BBBB');
    await saveSnapshot(src as unknown as FileSystemAPI, false);
    expect(idb.store.get('current')).toBeDefined();
    const record = idb.store.get('current') as { files: Array<{ path: string; content: string }> };
    expect(record.files.find((f) => f.path === '/a.txt')?.content).toBe('AAAA');
    // force 全量遍历 → 新内容入库。
    await saveSnapshot(src as unknown as FileSystemAPI, true);
    const record2 = idb.store.get('current') as { files: Array<{ path: string; content: string }> };
    expect(record2.files.find((f) => f.path === '/a.txt')?.content).toBe('BBBB');
  });

  it('N2: empty-dirs-only change is not dedup-skipped (signature includes emptyDirs)', async () => {
    const src = new FakeFS();
    await src.writeFile('/work/a.txt', 'A');
    await saveSnapshot(src as unknown as FileSystemAPI, false);
    const putsAfterFirst = idb.puts;
    // 仅新增一个空目录：文件数/总字节不变，但 emptyDirs 变 → 必须写 IDB（N2 回归）。
    await src.mkdir('/work/empty1', { recursive: true });
    await saveSnapshot(src as unknown as FileSystemAPI, false);
    expect(idb.puts).toBe(putsAfterFirst + 1);
    const record = idb.store.get('current') as { emptyDirs?: string[] };
    expect(record.emptyDirs).toContain('/work/empty1');
  });
});

describe('persist force semantics + size guard', () => {
  it('force=true always writes even when content is unchanged', async () => {
    const src = new FakeFS();
    await src.writeFile('/a.txt', 'x');
    await saveSnapshot(src as unknown as FileSystemAPI, false);
    const putsAfterFirst = idb.puts;
    await saveSnapshot(src as unknown as FileSystemAPI, true);
    expect(idb.puts).toBe(putsAfterFirst + 1);
  });

  it('oversize snapshot is skipped (over 50MB) without writing', async () => {
    const src = new FakeFS();
    await src.writeFile('/big.bin', 'x'.repeat(51 * 1024 * 1024));
    const res = await saveSnapshot(src as unknown as FileSystemAPI, true);
    expect(res.skipped).toBe(true);
    expect(idb.puts).toBe(0);
  });

  it('warns once across consecutive over-limit saves (overLimitWarned latch)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const src = new FakeFS();
    await src.writeFile('/big.bin', 'x'.repeat(51 * 1024 * 1024));
    expect((await saveSnapshot(src as unknown as FileSystemAPI, true)).skipped).toBe(true);
    expect((await saveSnapshot(src as unknown as FileSystemAPI, true)).skipped).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('exceeds')).length).toBe(1);
    warn.mockRestore();
  });

  it('counts and reports skipped binary/unreadable files in the save log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const src = new FakeFS();
    await src.writeFile('/ok.txt', 'fine');
    await src.writeFile('/bin.dat', 'a�b'); // U+FFFD 启发式判定二进制 → 跳过
    const res = await saveSnapshot(src as unknown as FileSystemAPI, true);
    expect(res.skipped).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('skipped 1 binary/unreadable'))).toBe(true);
    const record = idb.store.get('current') as { files: Array<{ path: string; content: string }> };
    expect(record.files.some((f) => f.path === '/ok.txt')).toBe(true);
    expect(record.files.some((f) => f.path === '/bin.dat')).toBe(false);
    warn.mockRestore();
  });

  it('clearSnapshot deletes the record; a later save writes a fresh snapshot', async () => {
    const src = new FakeFS();
    await src.writeFile('/a.txt', 'x');
    await saveSnapshot(src as unknown as FileSystemAPI, true);
    expect(idb.store.has('current')).toBe(true);
    await clearSnapshot();
    expect(idb.store.has('current')).toBe(false);
    expect(await getSnapshotMeta()).toBeNull();
    // 清除完成后保存是允许的（cleared 标志只挡清除期间在途的 put，结束后已复位）。
    const res = await saveSnapshot(src as unknown as FileSystemAPI, false);
    expect(res.skipped).toBe(false);
    expect(idb.store.has('current')).toBe(true);
  });

  it('loadSnapshot after clearSnapshot returns null (fresh system)', async () => {
    const src = new FakeFS();
    await src.writeFile('/a.txt', 'x');
    await saveSnapshot(src as unknown as FileSystemAPI, true);
    await clearSnapshot();
    expect(await loadSnapshot(new FakeFS() as unknown as FileSystemAPI)).toBeNull();
  });
});

describe('persist 最大年龄强制（P0-1）', () => {
  it('isAgeForced 纯决策：未保存过不强制；未超间隔不强制；超间隔强制', () => {
    expect(isAgeForced(0, 100000)).toBe(false); // lastFullSaveAt=0（未保存过）
    expect(isAgeForced(1000, 1000 + AUTO_SNAPSHOT_FORCE_INTERVAL_MS - 1)).toBe(false);
    expect(isAgeForced(1000, 1000 + AUTO_SNAPSHOT_FORCE_INTERVAL_MS)).toBe(true);
    expect(isAgeForced(1000, 1000 + AUTO_SNAPSHOT_FORCE_INTERVAL_MS + 5000)).toBe(true);
  });

  it('自定义间隔可注入', () => {
    expect(isAgeForced(1000, 1000 + 100, 100)).toBe(true);
    expect(isAgeForced(1000, 1000 + 99, 100)).toBe(false);
  });

  it('等长编辑在最大年龄间隔后被抓取（age 强制写，reason=age）', async () => {
    vi.useFakeTimers();
    try {
      const src = new FakeFS();
      await src.writeFile('/a.txt', 'AAAA');
      // 首次保存：lastFullSaveAt 记录为当前（假）时间。
      const first = await saveSnapshot(src as unknown as FileSystemAPI, false);
      expect(first.reason).toBe('changed');
      const putsAfterFirst = idb.puts;

      // 等长编辑：目录签名与内容签名都不变 → 非 force 且未超年龄间隔时跳过写。
      await src.writeFile('/a.txt', 'BBBB');
      const dedup = await saveSnapshot(src as unknown as FileSystemAPI, false);
      expect(dedup.reason).toBe('dedup');
      expect(idb.puts).toBe(putsAfterFirst);
      let rec = idb.store.get('current') as { files: Array<{ path: string; content: string }> };
      expect(rec.files.find((f) => f.path === '/a.txt')?.content).toBe('AAAA'); // 旧内容仍在

      // 越过最大年龄间隔 → 下一次自动快照强制全量收集 + 写盘，抓到等长编辑。
      vi.advanceTimersByTime(AUTO_SNAPSHOT_FORCE_INTERVAL_MS);
      const age = await saveSnapshot(src as unknown as FileSystemAPI, false);
      expect(age.reason).toBe('age');
      expect(idb.puts).toBe(putsAfterFirst + 1);
      rec = idb.store.get('current') as { files: Array<{ path: string; content: string }> };
      expect(rec.files.find((f) => f.path === '/a.txt')?.content).toBe('BBBB'); // 新内容入库
    } finally {
      vi.useRealTimers();
    }
  });

  it('刷新恢复快照后年龄强制仍生效（回归：lastFullSaveAt 恢复时初始化）', async () => {
    vi.useFakeTimers();
    try {
      // 模拟「上一次会话留下的快照」：直接种子进 IDB（绕过 saveSnapshot —— 否则本会话
      // lastFullSaveAt 会被首次保存置为非零，掩盖「刷新后它为 0」的缺陷）。
      idb.store.set('current', {
        meta: { version: 1, savedAt: 1000, fileCount: 1, totalBytes: 4, sigFileCount: 1, sigTotalBytes: 4 },
        files: [{ path: '/a.txt', content: 'AAAA' }],
      });

      // 模拟刷新：全新 FS 恢复快照。模块级 lastFullSaveAt 此刻仍为 0（beforeEach 已 clear）。
      const dst = new FakeFS();
      await loadSnapshot(dst as unknown as FileSystemAPI);
      await dst.writeFile('/a.txt', 'BBBB'); // 恢复后等长编辑

      // 未超间隔：仍 dedup（不写）。
      const dedup = await saveSnapshot(dst as unknown as FileSystemAPI, false);
      expect(dedup.reason).toBe('dedup');

      // 越过最大年龄间隔 → 年龄强制抓取等长编辑。
      // 修复前：lastFullSaveAt=0 恒不触发（reason=dedup），等长编辑丢失窗口无界；
      // 修复后：loadSnapshot 把 lastFullSaveAt 归零到当前时间，30s 后触发 age 强制写。
      vi.advanceTimersByTime(AUTO_SNAPSHOT_FORCE_INTERVAL_MS);
      const age = await saveSnapshot(dst as unknown as FileSystemAPI, false);
      expect(age.reason).toBe('age');
      const rec = idb.store.get('current') as { files: Array<{ path: string; content: string }> };
      expect(rec.files.find((f) => f.path === '/a.txt')?.content).toBe('BBBB'); // 等长编辑已入库
    } finally {
      vi.useRealTimers();
    }
  });
});
