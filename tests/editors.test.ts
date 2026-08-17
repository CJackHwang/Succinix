import { describe, expect, it } from 'vitest';
import { VFS } from '@lifo-sh/core';
import { nanoCommand, viCommand } from '../src/engine/host/editors.js';

function context(args: string[], chunks: string[], initial?: string) {
  const vfs = new VFS();
  vfs.mkdir('/workspace', { recursive: true });
  if (initial !== undefined) vfs.writeFile('/workspace/file.txt', initial);
  const output: string[] = [];
  const errors: string[] = [];
  const modes: boolean[] = [];
  let index = 0;
  const stdin = { read: async () => chunks[index++] ?? null, readAll: async () => chunks.slice(index).join('') };
  return {
    ctx: { args, env: { LINES: '12', COLUMNS: '80' }, cwd: '/workspace', vfs, stdout: { write: (s: string) => output.push(s) }, stderr: { write: (s: string) => errors.push(s) }, signal: new AbortController().signal, stdin, setRawMode: (enabled: boolean) => modes.push(enabled) },
    vfs, output, errors, modes,
  } as const;
}

describe('Lifo-native interactive editors', () => {
  it('vi inserts Unicode and saves with :wq through raw stdin', async () => {
    const f = context(['file.txt'], ['iHello 世界\x1b:wq\r']);
    const code = await viCommand(f.ctx as never);
    expect(code).toBe(0);
    expect(f.vfs.readFileString('/workspace/file.txt')).toBe('Hello 世界');
    expect(f.modes).toEqual([true, false]);
    expect(f.output.some((x) => x.includes('\x1b[2J'))).toBe(true);
  });

  it('vi searches with slash and repeats the match with n', async () => {
    const f = context(['file.txt'], ['/beta\rn:q'], 'alpha beta beta');
    const code = await viCommand(f.ctx as never);
    expect(code).toBe(0);
    expect(f.output.some((x) => x.includes('/beta'))).toBe(true);
  });

  it('nano searches, saves, and exits without browser-side state', async () => {
    const f = context(['file.txt'], ['alpha beta\x17beta\r\x0f\x18']);
    const code = await nanoCommand(f.ctx as never);
    expect(code).toBe(0);
    expect(f.vfs.readFileString('/workspace/file.txt')).toBe('alpha beta');
    expect(f.output.some((x) => x.includes('Search: beta'))).toBe(true);
  });

  it('Ctrl+C aborts without saving and always leaves raw mode', async () => {
    const f = context(['file.txt'], ['ichanged\x03'], 'original');
    const code = await viCommand(f.ctx as never);
    expect(code).toBe(130);
    expect(f.vfs.readFileString('/workspace/file.txt')).toBe('original');
    expect(f.modes).toEqual([true, false]);
  });
});
