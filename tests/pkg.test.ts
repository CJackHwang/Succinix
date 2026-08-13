// src/pkg/index.ts 单元测试：来源判定 / 命令构造 / 列表与搜索渲染（mock 网络 client + mock FS）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeFS, installFakeIDB, FakeClient } from './helpers/fakes.js';
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from '../src/engine/index.js';
import {
  isValidPackageName,
  listPackages,
  formatPackageList,
  searchPackages,
  formatSearchResults,
  installPackage,
  removePackage,
  packageInfo,
  type PkgContext,
} from '../src/pkg/index.js';
import { clearSnapshot } from '../src/persist/index.js';

function makeCtx(fake: FakeClient, f: FakeFS): PkgContext {
  return {
    wc: { fs: f as unknown as WebContainer['fs'] } as unknown as WebContainer,
    client: fake as unknown as TerminalClient,
  };
}

// lifo search 固定宽表行（NAME 30 / VERSION 12 / DESC），与 parseLifoSearch 对齐。
function lifoRow(name: string, version: string, desc = ''): string {
  return `  ${name.padEnd(30)}${version.padEnd(12)}${desc}`;
}
const LIFO_HEADER = 'NAME'.padEnd(30) + 'VERSION'.padEnd(12) + 'DESCRIPTION';
const LIFO_SEP = '---';

// 构造一个按命令分派的 FakeClient：npm/lifo 两通道分别可脚本。
function netClient(opts: {
  lifoList?: string;
  lifoSearch?: (term: string) => { ok: boolean; stdout: string } | { ok: boolean; stdout: string; exitCode?: number };
  npmSearch?: unknown;
  install?: (cmd: string) => unknown;
  view?: unknown;
}): FakeClient {
  const terminal = (cmd: string): unknown => {
    if (cmd === 'lifo list') return { ok: true, stdout: opts.lifoList ?? '' };
    if (cmd.startsWith('lifo search ')) {
      if (opts.lifoSearch) return opts.lifoSearch(cmd.slice('lifo search '.length));
      return { ok: true, stdout: '' };
    }
    if (cmd.startsWith('npm search ')) {
      return { ok: true, stdout: JSON.stringify(opts.npmSearch ?? []) };
    }
    if (cmd.startsWith('npm install ') || cmd.startsWith('lifo install ')) {
      return opts.install ? opts.install(cmd) : { ok: true, stdout: 'installed' };
    }
    if (cmd.startsWith('npm view ')) {
      return opts.view ?? { ok: false, stderr: '404 Not Found' };
    }
    return { ok: true, stdout: '' };
  };
  return new FakeClient({ terminal });
}

beforeEach(async () => {
  vi.stubGlobal('indexedDB', installFakeIDB().indexedDB);
  await clearSnapshot();
  return () => vi.unstubAllGlobals();
});

describe('pkg name validation', () => {
  it('accepts bare and scoped names, rejects whitespace/dash/empty', () => {
    expect(isValidPackageName('git')).toBe(true);
    expect(isValidPackageName('@scope/pkg')).toBe(true);
    expect(isValidPackageName('lodash.throttle')).toBe(true);
    expect(isValidPackageName('')).toBe(false);
    expect(isValidPackageName('has space')).toBe(false);
    expect(isValidPackageName('-leading')).toBe(false);
    expect(isValidPackageName('@bad')).toBe(false);
    expect(isValidPackageName('@bad/')).toBe(false);
  });
});

describe('pkg list rendering', () => {
  it('formatPackageList renders header and rows, empty table keeps header', () => {
    const lines = formatPackageList([
      { name: 'git', source: 'lifo', version: '2.0.0' },
      { name: 'express', source: 'npm', version: '4.0.0' },
    ]);
    expect(lines[0]).toBe('Packages');
    expect(lines[1]).toContain('NAME');
    expect(lines.some((l) => l.includes('git') && l.includes('lifo'))).toBe(true);
    expect(formatPackageList([]).some((l) => l.includes('(none installed)'))).toBe(true);
  });

  it('listPackages merges lifo + npm channels and lifo wins on name conflict', async () => {
    const f = new FakeFS();
    await f.writeFile('/node_modules/express/package.json', JSON.stringify({ name: 'express', version: '4.0.0' }));
    await f.writeFile('/node_modules/git/package.json', JSON.stringify({ name: 'git', version: '9.9.9' }));
    const fake = netClient({ lifoList: '  git@2.0.0  [git]\n  nano@1.1.0  [nano]\n' });
    const entries = await listPackages(makeCtx(fake, f));
    const names = entries.map((e) => e.name);
    expect(names).toContain('express');
    expect(names).toContain('nano');
    // 同名冲突优先 lifo
    const git = entries.find((e) => e.name === 'git');
    expect(git?.source).toBe('lifo');
    expect(git?.version).toBe('2.0.0');
  });

  it('listPackages tolerates a missing node_modules (empty npm channel)', async () => {
    const fake = netClient({ lifoList: '' });
    const entries = await listPackages(makeCtx(fake, new FakeFS()));
    expect(entries).toEqual([]);
  });
});

describe('pkg search', () => {
  it('searchPackages merges both channels and adds availability notes on failure', async () => {
    const fake = netClient({
      lifoSearch: (term) => {
        if (term === '"git"') return { ok: true, stdout: `${LIFO_HEADER}\n${LIFO_SEP}\n${lifoRow('git', '2.0.0', 'git tool')}\n` };
        return { ok: true, stdout: '' };
      },
      npmSearch: [{ name: 'git', version: '9.9.9', description: 'npm git' }],
    });
    const out = await searchPackages(makeCtx(fake, new FakeFS()), 'git');
    const git = out.entries.find((e) => e.name === 'git');
    expect(git?.source).toBe('lifo'); // lifo 优先
    expect(out.entries.some((e) => e.name === 'git' && e.source === 'npm')).toBe(false); // 去重
    expect(out.notes).toEqual([]);
  });

  it('searchPackages records availability notes when a channel is unreachable', async () => {
    const fake = netClient({
      lifoSearch: () => ({ ok: false, stdout: '', exitCode: 1 }),
      npmSearch: [],
    });
    const out = await searchPackages(makeCtx(fake, new FakeFS()), 'git');
    expect(out.entries).toEqual([]);
    expect(out.notes.length).toBeGreaterThanOrEqual(1);
    expect(out.notes.join(' ')).toContain('unavailable');
  });

  it('formatSearchResults truncates long descriptions and renders the header', () => {
    const lines = formatSearchResults('git', [{ name: 'git', version: '2.0.0', description: 'x'.repeat(100), source: 'lifo' }]);
    expect(lines[0]).toBe("Search results for 'git'");
    expect(lines.some((l) => l.includes('...'))).toBe(true);
    expect(formatSearchResults('none', [])[1]).toContain('(no results)');
  });
});

describe('pkg install source detection', () => {
  it('installs via lifo when lifo-pkg exists on npm search', async () => {
    const fake = netClient({
      lifoSearch: (term) =>
        term === '"git"' ? { ok: true, stdout: `${LIFO_HEADER}\n${LIFO_SEP}\n${lifoRow('git', '2.0.0')}\n` } : { ok: true, stdout: '' },
    });
    const res = await installPackage(makeCtx(fake, new FakeFS()), 'git');
    expect(res.ok).toBe(true);
    expect(res.source).toBe('lifo');
    expect(res.message).toContain('source: lifo');
    expect(fake.terminalCalls.some((c) => c.command.startsWith('lifo install'))).toBe(true);
  });

  it('installs via npm when lifo has no such package (no fell-back flag)', async () => {
    const fake = netClient({
      lifoSearch: () => ({ ok: true, stdout: '' }),
    });
    const res = await installPackage(makeCtx(fake, new FakeFS()), 'express');
    expect(res.ok).toBe(true);
    expect(res.source).toBe('npm');
    expect(res.message).not.toContain('fell back');
    expect(fake.terminalCalls.some((c) => c.command.includes('npm install "express"'))).toBe(true);
  });

  it('falls back to npm with a hint when lifo search is unreachable', async () => {
    const fake = netClient({
      lifoSearch: () => ({ ok: false, stdout: '', exitCode: 1 }),
    });
    const res = await installPackage(makeCtx(fake, new FakeFS()), 'express');
    expect(res.ok).toBe(true);
    expect(res.source).toBe('npm');
    expect(res.message).toContain('lifo unavailable — fell back to npm');
  });

  it('rejects invalid package names without running any command', async () => {
    const fake = netClient({});
    const res = await installPackage(makeCtx(fake, new FakeFS()), '--help');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('invalid package name');
    expect(fake.terminalCalls.length).toBe(0);
  });

  it('reports install failure with the real stderr', async () => {
    const fake = netClient({
      lifoSearch: () => ({ ok: true, stdout: '' }),
      install: () => ({ ok: false, stderr: 'EACCES permission denied' }),
    });
    const res = await installPackage(makeCtx(fake, new FakeFS()), 'express');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('install failed');
    expect(res.message).toContain('EACCES');
  });

  it('reports lifo-channel install failure distinctly', async () => {
    const fake = netClient({
      lifoSearch: (term) =>
        term === '"git"' ? { ok: true, stdout: `${LIFO_HEADER}\n${LIFO_SEP}\n${lifoRow('git', '2.0.0')}\n` } : { ok: true, stdout: '' },
      install: () => ({ ok: false, stderr: 'lifo install exploded' }),
    });
    const res = await installPackage(makeCtx(fake, new FakeFS()), 'git');
    expect(res.ok).toBe(false);
    expect(res.source).toBe('lifo');
    expect(res.message).toContain('install failed');
    expect(res.message).toContain('lifo install exploded');
  });
});

describe('pkg remove', () => {
  it('removes via lifo when installed on the lifo channel', async () => {
    const fake = netClient({ lifoList: '  git@2.0.0  [git]\n' });
    const res = await removePackage(makeCtx(fake, new FakeFS()), 'git');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('source: lifo');
    expect(fake.terminalCalls.some((c) => c.command.startsWith('lifo remove'))).toBe(true);
  });

  it('removes via npm when installed in node_modules', async () => {
    const f = new FakeFS();
    await f.writeFile('/node_modules/express/package.json', JSON.stringify({ name: 'express', version: '4' }));
    const fake = netClient({});
    const res = await removePackage(makeCtx(fake, f), 'express');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('source: npm');
    expect(fake.terminalCalls.some((c) => c.command.includes('npm uninstall "express"'))).toBe(true);
  });

  it('reports not installed when neither channel has it', async () => {
    const fake = netClient({});
    const res = await removePackage(makeCtx(fake, new FakeFS()), 'ghost');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not installed');
  });

  it('rejects invalid names and empty names', async () => {
    const fake = netClient({});
    const bad = await removePackage(makeCtx(fake, new FakeFS()), '-x');
    expect(bad.ok).toBe(false);
    const empty = await removePackage(makeCtx(fake, new FakeFS()), '');
    expect(empty.ok).toBe(false);
    expect(empty.message).toContain('required');
  });
});

describe('pkg info', () => {
  it('returns the lifo entry when lifo search hits', async () => {
    const fake = netClient({
      lifoSearch: () => ({ ok: true, stdout: `${LIFO_HEADER}\n${LIFO_SEP}\n${lifoRow('git', '2.0.0', 'git tool')}\n` }),
    });
    const res = await packageInfo(makeCtx(fake, new FakeFS()), 'git');
    expect(res.ok).toBe(true);
    expect(res.entry?.source).toBe('lifo');
    expect(res.entry?.version).toBe('2.0.0');
  });

  it('falls back to npm view when lifo has no hit', async () => {
    const fake = netClient({
      lifoSearch: () => ({ ok: true, stdout: '' }),
      view: { ok: true, stdout: JSON.stringify({ name: 'express', version: '4.0.0', description: 'web' }) },
    });
    const res = await packageInfo(makeCtx(fake, new FakeFS()), 'express');
    expect(res.ok).toBe(true);
    expect(res.entry?.source).toBe('npm');
    expect(res.entry?.description).toBe('web');
  });

  it('reports not found when both channels miss', async () => {
    const fake = netClient({
      lifoSearch: () => ({ ok: true, stdout: '' }),
      view: { ok: false, stderr: '404 Not Found' },
    });
    const res = await packageInfo(makeCtx(fake, new FakeFS()), 'ghost');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not found');
  });

  it('surfaces the lifo-unavailable fallback hint when the lifo probe throws', async () => {
    const fake = netClient({
      lifoSearch: () => {
        throw new Error('registry timeout');
      },
      view: { ok: false, stderr: '404 Not Found' },
    });
    const res = await packageInfo(makeCtx(fake, new FakeFS()), 'ghost');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('lifo unavailable — fell back to npm');
  });

  it('requires a name', async () => {
    const fake = netClient({});
    const res = await packageInfo(makeCtx(fake, new FakeFS()), '');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('required');
  });
});
