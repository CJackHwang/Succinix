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

  it('ensureMotd refreshes a stale default banner to the current version', async () => {
    const f = fs();
    const stale = "Welcome to Succinix 0.4.0 — browser-native Linux. Type 'help' for commands.";
    await f.writeFile(MOTD_FILE, stale);
    await ensureMotd(f);
    expect((f as unknown as FakeFS).raw(MOTD_FILE)).toBe(DEFAULT_MOTD);
    expect(await readMotd(f)).toBe(DEFAULT_MOTD);
  });

  it('ensureMotd refreshes a pre-branding WebUnix default banner', async () => {
    const f = fs();
    const stale = "Welcome to WebUnix 0.1.0 — browser-native Linux. Type 'help' for commands.";
    await f.writeFile(MOTD_FILE, stale);
    await ensureMotd(f);
    expect((f as unknown as FakeFS).raw(MOTD_FILE)).toBe(DEFAULT_MOTD);
  });

  it('ensureMotd keeps a custom banner that only looks like the default', async () => {
    const f = fs();
    const custom = "Welcome to Succinix 0.4.0 — browser-native Linux. Type 'help' for commands. Keep me.";
    await f.writeFile(MOTD_FILE, custom);
    await ensureMotd(f);
    expect((f as unknown as FakeFS).raw(MOTD_FILE)).toBe(custom);
  });

  it('readMotd returns null when the file is missing', async () => {
    expect(await readMotd(fs())).toBeNull();
  });

  it('readMotd renders the current version for a stale stored default', async () => {
    const f = fs();
    const stale = "Welcome to Succinix 0.4.0 — browser-native Linux. Type 'help' for commands.";
    await f.writeFile(MOTD_FILE, stale);
    expect(await readMotd(f)).toBe(DEFAULT_MOTD);
    // 文件本身未被改写：只负责显示当前版本。
    expect((f as unknown as FakeFS).raw(MOTD_FILE)).toBe(stale);
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
