// src/motd.ts 单元测试：文件读写 + 默认回落 + force 落盘（mock FS + fake IDB）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeFS, installFakeIDB } from './helpers/fakes.js';
import type { FileSystemAPI } from '@webcontainer/api';
import { ensureMotd, readMotd, writeMotd, resetMotd, DEFAULT_MOTD, MOTD_FILE } from '../src/motd.js';
import { clearSnapshot } from '../src/persist.js';

const fs = () => new FakeFS() as unknown as FileSystemAPI;

describe('motd', () => {
  const idb = installFakeIDB();

  beforeEach(async () => {
    vi.stubGlobal('indexedDB', idb.indexedDB);
    idb.reset();
    await clearSnapshot();
    return () => vi.unstubAllGlobals();
  });

  it('ensureMotd writes the default when the file is missing', async () => {
    const f = fs();
    await ensureMotd(f);
    expect(await readMotd(f)).toBe(DEFAULT_MOTD);
  });

  it('ensureMotd keeps an existing custom motd untouched', async () => {
    const f = fs();
    await writeMotd(f, 'custom banner');
    await ensureMotd(f);
    expect(await readMotd(f)).toBe('custom banner');
  });

  it('readMotd returns null when the file is missing', async () => {
    expect(await readMotd(fs())).toBeNull();
  });

  it('writeMotd persists content and triggers a force snapshot', async () => {
    const f = fs();
    await writeMotd(f, 'hello from motd');
    expect(await readMotd(f)).toBe('hello from motd');
    // forcePersist 写盘：IDB 里有快照记录
    expect(idb.store.has('current')).toBe(true);
    expect((f as unknown as FakeFS).has(MOTD_FILE)).toBe(true);
  });

  it('resetMotd restores the default', async () => {
    const f = fs();
    await writeMotd(f, 'temporary');
    await resetMotd(f);
    expect(await readMotd(f)).toBe(DEFAULT_MOTD);
  });
});
