// src/config.ts 单元测试：KEY=value 解析/序列化 + env/settings 文件读写（mock FS + fake IDB）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeFS, installFakeIDB } from './helpers/fakes.js';
import type { FileSystemAPI } from '@webcontainer/api';
import {
  parseKeyValue,
  serializeKeyValue,
  isValidWorkspaceName,
  validateSetting,
  readEnvFile,
  writeEnvFile,
  setEnvVar,
  getEnvVar,
  unsetEnvVar,
  readSettingsFile,
  writeSettingsFile,
  getSetting,
  setSetting,
  resetSetting,
  listSettings,
  SETTING_KEYS,
} from '../src/config.js';
import { clearSnapshot } from '../src/persist.js';

const fs = () => new FakeFS() as unknown as FileSystemAPI;

describe('config parse/serialize', () => {
  it('parseKeyValue skips blanks and # comments', () => {
    const m = parseKeyValue('# comment\n\nA=1\n\n# another\nB=two=three\n');
    expect([...m.entries()]).toEqual([
      ['A', '1'],
      ['B', 'two=three'],
    ]);
  });

  it('parseKeyValue splits on first = and trims key', () => {
    const m = parseKeyValue('  K  = v = rest\nbadline\n=orphan\n');
    expect(m.get('K')).toBe(' v = rest');
    expect(m.has('badline')).toBe(false);
    expect(m.has('')).toBe(false);
  });

  it('parseKeyValue returns empty map for empty/whitespace input', () => {
    expect(parseKeyValue('').size).toBe(0);
    expect(parseKeyValue('\n\n  \n').size).toBe(0);
  });

  it('serializeKeyValue sorts keys and ends with newline', () => {
    const m = new Map([
      ['zeta', '1'],
      ['alpha', '2'],
    ]);
    expect(serializeKeyValue(m)).toBe('alpha=2\nzeta=1\n');
  });

  it('serializeKeyValue empty map is empty string', () => {
    expect(serializeKeyValue(new Map())).toBe('');
  });

  it('serialize roundtrips through parse', () => {
    const m = new Map([
      ['preview-port', '3001'],
      ['font-size', '14'],
    ]);
    expect(parseKeyValue(serializeKeyValue(m))).toEqual(m);
  });

  it('isValidWorkspaceName rules', () => {
    expect(isValidWorkspaceName('main')).toBe(true);
    expect(isValidWorkspaceName('my_ws-2.1')).toBe(true);
    expect(isValidWorkspaceName('')).toBe(false);
    expect(isValidWorkspaceName('.hidden')).toBe(false);
    expect(isValidWorkspaceName('a/b')).toBe(false);
    expect(isValidWorkspaceName('has space')).toBe(false);
  });

  it('validateSetting accepts valid values and rejects bad ones', () => {
    expect(validateSetting('preview-port', '3001')).toBeNull();
    expect(validateSetting('preview-port', '0')).not.toBeNull();
    expect(validateSetting('preview-port', '70000')).not.toBeNull();
    expect(validateSetting('preview-port', 'abc')).not.toBeNull();
    expect(validateSetting('default-workspace', 'main')).toBeNull();
    expect(validateSetting('default-workspace', 'bad/name')).not.toBeNull();
    expect(validateSetting('font-size', '14')).toBeNull();
    expect(validateSetting('font-size', '7')).not.toBeNull();
    expect(validateSetting('font-size', '73')).not.toBeNull();
    expect(validateSetting('unknown-key', 'x')).not.toBeNull();
  });
});

describe('config env file', () => {
  // persist 的 dbPromise 是模块级缓存，跨测试引用同一个 fake（installFakeIDB 只能调一次），
  // beforeEach 里 reset() 清空 store 与计数。
  const idb = installFakeIDB();

  beforeEach(async () => {
    vi.stubGlobal('indexedDB', idb.indexedDB);
    idb.reset();
    await clearSnapshot();
    return () => vi.unstubAllGlobals();
  });

  it('readEnvFile missing file returns empty map', async () => {
    expect([...await readEnvFile(fs())]).toEqual([]);
  });

  it('writeEnvFile then readEnvFile roundtrips', async () => {
    const f = fs();
    await writeEnvFile(f, new Map([['FOO', 'bar'], ['BAZ', 'qux']]));
    const m = await readEnvFile(f);
    expect(m.get('FOO')).toBe('bar');
    expect(m.get('BAZ')).toBe('qux');
  });

  it('setEnvVar/getEnvVar persist value and force-snapshot', async () => {
    const f = fs();
    await setEnvVar(f, 'PATH_EXTRA', '/custom/bin');
    expect(await getEnvVar(f, 'PATH_EXTRA')).toBe('/custom/bin');
    // forcePersist 写盘：IDB 里有快照记录
    expect(idb.store.has('current')).toBe(true);
  });

  it('unsetEnvVar removes an existing key and reports had=true', async () => {
    const f = fs();
    await setEnvVar(f, 'KEY', 'val');
    expect(await unsetEnvVar(f, 'KEY')).toBe(true);
    expect(await getEnvVar(f, 'KEY')).toBeUndefined();
    expect(await unsetEnvVar(f, 'KEY')).toBe(false);
  });
});

describe('config settings file', () => {
  const idb = installFakeIDB();

  beforeEach(async () => {
    vi.stubGlobal('indexedDB', idb.indexedDB);
    idb.reset();
    await clearSnapshot();
    return () => vi.unstubAllGlobals();
  });

  it('getSetting falls back to defaults when unset', async () => {
    const f = fs();
    expect(await getSetting(f, 'preview-port')).toBe('3001');
    expect(await getSetting(f, 'font-size')).toBe('14');
  });

  it('setSetting writes and getSetting returns the custom value', async () => {
    const f = fs();
    await setSetting(f, 'preview-port', '4000');
    expect(await getSetting(f, 'preview-port')).toBe('4000');
    const raw = await readSettingsFile(f);
    expect(raw.get('preview-port')).toBe('4000');
  });

  it('resetSetting removes stored value back to default', async () => {
    const f = fs();
    await setSetting(f, 'preview-port', '4000');
    expect(await resetSetting(f, 'preview-port')).toBe(true);
    expect(await getSetting(f, 'preview-port')).toBe('3001');
    expect(await resetSetting(f, 'preview-port')).toBe(false);
  });

  it('listSettings returns ordered entries with isDefault flag', async () => {
    const f = fs();
    await setSetting(f, 'font-size', '16');
    const list = await listSettings(f);
    expect(list.map((e) => e.key)).toEqual([...SETTING_KEYS]);
    expect(list.find((e) => e.key === 'font-size')).toMatchObject({ value: '16', isDefault: false });
    expect(list.find((e) => e.key === 'preview-port')).toMatchObject({ value: '3001', isDefault: true });
  });

  it('writeSettingsFile persists to the /etc file with sorted keys', async () => {
    const f = fs();
    await writeSettingsFile(f, new Map([['font-size', '12'], ['preview-port', '3002']]));
    const raw = await readSettingsFile(f);
    expect([...raw.entries()]).toEqual([
      ['font-size', '12'],
      ['preview-port', '3002'],
    ]);
  });
});
