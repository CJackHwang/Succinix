import { describe, expect, it } from 'vitest';
import { VFS } from '@lifo-sh/core';
import { nanoCommand, viCommand } from '../src/engine/host/editors.js';
import { clearTerminalDimensions, setTerminalDimensions } from '../src/engine/host/terminal-dimensions.js';

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

  it('asks whether to save a dirty nano buffer and preserves data after discard', async () => {
    const f = context(['file.txt'], ['changed\x18n'], 'original');
    const code = await nanoCommand(f.ctx as never);
    expect(code).toBe(0);
    expect(f.vfs.readFileString('/workspace/file.txt')).toBe('original');
    expect(f.output.some((x) => x.includes('Save modified buffer?'))).toBe(true);
  });

  it('cancels dirty nano quit until the user explicitly saves', async () => {
    const f = context(['file.txt'], ['changed\x18c\x0f\x18y'], 'original');
    const code = await nanoCommand(f.ctx as never);
    expect(code).toBe(0);
    expect(f.vfs.readFileString('/workspace/file.txt')).toBe('changedoriginal');
  });

  it('edits astral Unicode at whole code-point boundaries', async () => {
    const f = context(['file.txt'], ['i😀\x1b:wq\r']);
    const code = await viCommand(f.ctx as never);
    expect(code).toBe(0);
    expect(f.vfs.readFileString('/workspace/file.txt')).toBe('😀');
  });

  it('truncates wide text to the terminal column budget on redraw', async () => {
    const f = context(['file.txt'], [':q'], '中文中文中文中文中文中文');
    (f.ctx.env as Record<string, string>).COLUMNS = '20';
    await viCommand(f.ctx as never);
    expect(f.output.some((x) => x.includes('...'))).toBe(true);
    expect(f.output.every((x) => !x.includes('中文中文中文中文中文中文'))).toBe(true);
  });

  it('uses the current mailbox dimensions instead of the command-start environment', async () => {
    const f = context(['file.txt'], [':q'], '中文中文中文中文中文中文');
    (f.ctx.env as Record<string, string>).SUCCINIX_INSTANCE_ID = 'editor-resize';
    setTerminalDimensions('editor-resize', 20, 12);
    try {
      await viCommand(f.ctx as never);
      expect(f.output.some((x) => x.includes('...'))).toBe(true);
      expect(f.output.every((x) => !x.includes('中文中文中文中文中文中文'))).toBe(true);
    } finally {
      clearTerminalDimensions('editor-resize');
    }
  });

  it('redraws an active raw editor when the mailbox dimensions change', async () => {
    const f = context(['file.txt'], [], '中文中文中文中文中文中文');
    const instanceId = 'editor-live-resize';
    (f.ctx.env as Record<string, string>).SUCCINIX_INSTANCE_ID = instanceId;
    let finish!: (value: string | null) => void;
    let markFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => { markFirstRead = resolve; });
    let first = true;
    (f.ctx.stdin as { read: () => Promise<string | null> }).read = () => {
      if (!first) return Promise.resolve(null);
      first = false;
      markFirstRead();
      return new Promise((resolve) => { finish = resolve; });
    };
    const running = viCommand(f.ctx as never);
    await firstRead;
    await new Promise((resolve) => setTimeout(resolve, 0));
    setTerminalDimensions(instanceId, 20, 12);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish(':q');
    try {
      await running;
      expect(f.output.filter((entry) => entry.includes('\x1b[2J')).length).toBeGreaterThanOrEqual(2);
      expect(f.output.some((entry) => entry.includes('...'))).toBe(true);
    } finally {
      clearTerminalDimensions(instanceId);
    }
  });

  it('Ctrl+C aborts without saving and always leaves raw mode', async () => {
    const f = context(['file.txt'], ['ichanged\x03'], 'original');
    const code = await viCommand(f.ctx as never);
    expect(code).toBe(130);
    expect(f.vfs.readFileString('/workspace/file.txt')).toBe('original');
    expect(f.modes).toEqual([true, false]);
  });
});
