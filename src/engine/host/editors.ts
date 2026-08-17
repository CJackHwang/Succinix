import type { Command, CommandContext } from '@lifo-sh/core';

/**
 * Small, honest Lifo-native editors.  They intentionally use only the public
 * CommandContext stdin/setRawMode seam and VFS; there is no browser editor or
 * second document model.  The implementation is deliberately conservative,
 * but supports the workflows needed by an interactive userland package:
 * open/create, insert, Unicode, save, search, resize redraw, and abort.
 */
export const viCommand: Command = (ctx) => edit(ctx, 'vi');
export const nanoCommand: Command = (ctx) => edit(ctx, 'nano');

type EditorKind = 'vi' | 'nano';
interface BufferState { lines: string[]; row: number; col: number; path: string; dirty: boolean; }

async function edit(ctx: CommandContext, kind: EditorKind): Promise<number> {
  const path = resolvePath(ctx.cwd, ctx.args[0] ?? (kind === 'vi' ? 'untitled' : ''));
  if (!path) {
    ctx.stderr.write(`${kind}: missing file operand\n`);
    return 2;
  }
  let lines: string[];
  try { lines = ctx.vfs.exists(path) ? ctx.vfs.readFileString(path).split('\n') : ['']; } catch { lines = ['']; }
  if (lines.length === 0) lines = [''];
  const state: BufferState = { lines, row: 0, col: 0, path, dirty: false };
  const stdin = ctx.stdin;
  if (!stdin || !ctx.setRawMode) {
    ctx.stderr.write(`${kind}: interactive terminal input is unavailable\n`);
    return 69;
  }
  ctx.setRawMode(true);
  try {
    render(ctx, state, kind, kind === 'vi' ? 'NORMAL' : '^O Write Out  ^X Exit  ^W Where Is');
    return kind === 'vi' ? await runVi(ctx, state, stdin) : await runNano(ctx, state, stdin);
  } finally {
    ctx.setRawMode(false);
    // Leave a clean prompt below the editor without retaining browser-side
    // screen state.  ANSI is emitted through Lifo stdout like any command.
    ctx.stdout.write('\x1b[0m\r\n');
  }
}

async function runVi(ctx: CommandContext, state: BufferState, stdin: NonNullable<CommandContext['stdin']>): Promise<number> {
  let mode: 'normal' | 'insert' | 'command' | 'search' = 'normal';
  let command = '';
  let query = '';
  let lastQuery = '';
  for (;;) {
    const input = await stdin.read();
    if (input === null) return 0;
    for (const key of splitKeys(input)) {
      if (key === '\u0003') return 130;
      if (mode === 'command') {
        if (key === '\r' || key === '\n') {
          const result = command.trim(); command = '';
          if (result === 'q' || result === 'q!') return result === 'q' && state.dirty ? 1 : 0;
          if (result === 'w' || result === 'wq' || result === 'x') {
            if (!save(ctx, state)) return 1;
            if (result !== 'w') return 0;
          }
          mode = 'normal';
        } else if (key === '\u007f' || key === '\b') command = command.slice(0, -1);
        else if (key.length === 1 && key >= ' ') command += key;
        render(ctx, state, 'vi', `:${command}`);
        continue;
      }
      if (mode === 'search') {
        if (key === '\r' || key === '\n') {
          lastQuery = query;
          moveToMatch(state, query);
          query = '';
          mode = 'normal';
        } else if (key === '\u001b') {
          query = '';
          mode = 'normal';
        } else if (key === '\u007f' || key === '\b') query = query.slice(0, -1);
        else if (key.length === 1 && key >= ' ') query += key;
        render(ctx, state, 'vi', `/${query}`);
        continue;
      }
      if (mode === 'insert') {
        if (key === '\u001b') mode = 'normal';
        else if (key === '\u0013') { if (!save(ctx, state)) return 1; }
        else editKey(state, key);
        render(ctx, state, 'vi', 'INSERT');
        continue;
      }
      if (key === 'i' || key === 'a') { if (key === 'a') state.col++; mode = 'insert'; }
      else if (key === ':') mode = 'command';
      else if (key === '/') { query = ''; mode = 'search'; }
      else if (key === 'n') moveToMatch(state, lastQuery);
      else if (key === 'x') removeChar(state);
      else if (key === '\u0013') { if (!save(ctx, state)) return 1; }
      else moveKey(state, key);
      render(ctx, state, 'vi', mode === 'command' ? `:${command}` : mode === 'search' ? `/${query}` : 'NORMAL');
    }
  }
}

async function runNano(ctx: CommandContext, state: BufferState, stdin: NonNullable<CommandContext['stdin']>): Promise<number> {
  let search = false;
  let query = '';
  for (;;) {
    const input = await stdin.read();
    if (input === null) return 0;
    for (const key of splitKeys(input)) {
      if (key === '\u0003') return 130;
      if (search) {
        if (key === '\r' || key === '\n') {
          const hit = find(state, query); if (hit) { state.row = hit.row; state.col = hit.col; }
          search = false; query = '';
        } else if (key === '\u007f' || key === '\b') query = query.slice(0, -1);
        else if (key.length === 1 && key >= ' ') query += key;
        render(ctx, state, 'nano', `Search: ${query}`);
        continue;
      }
      if (key === '\u0018') return 0; // Ctrl-X: exit, preserving file as-is.
      if (key === '\u000f') { if (!save(ctx, state)) return 1; } // Ctrl-O
      else if (key === '\u0017') { search = true; } // Ctrl-W
      else if (key === '\u0013') { if (!save(ctx, state)) return 1; } // Ctrl-S
      else editKey(state, key);
      render(ctx, state, 'nano', search ? `Search: ${query}` : '^O Write Out  ^X Exit  ^W Where Is');
    }
  }
}

function save(ctx: CommandContext, state: BufferState): boolean {
  try { ctx.vfs.writeFile(state.path, state.lines.join('\n')); state.dirty = false; return true; }
  catch (error) { ctx.stderr.write(`editor: cannot save ${state.path}: ${String(error)}\n`); return false; }
}

function editKey(state: BufferState, key: string): void {
  if (key === '\r' || key === '\n') {
    const tail = state.lines[state.row]!.slice(state.col);
    state.lines[state.row] = state.lines[state.row]!.slice(0, state.col);
    state.lines.splice(state.row + 1, 0, tail); state.row++; state.col = 0; state.dirty = true; return;
  }
  if (key === '\u007f' || key === '\b') {
    if (state.col > 0) { const line = state.lines[state.row]!; state.lines[state.row] = line.slice(0, state.col - 1) + line.slice(state.col); state.col--; state.dirty = true; }
    else if (state.row > 0) { const previous = state.lines[state.row - 1]!; state.col = previous.length; state.lines[state.row - 1] = previous + state.lines[state.row]!; state.lines.splice(state.row, 1); state.row--; state.dirty = true; }
    return;
  }
  if (key.length === 1 && key >= ' ') { const line = state.lines[state.row]!; state.lines[state.row] = line.slice(0, state.col) + key + line.slice(state.col); state.col++; state.dirty = true; }
}

function moveKey(state: BufferState, key: string): void {
  if (key === '\x1b[D') state.col = Math.max(0, state.col - 1);
  else if (key === '\x1b[C') state.col = Math.min(state.lines[state.row]!.length, state.col + 1);
  else if (key === '\x1b[A') state.row = Math.max(0, state.row - 1);
  else if (key === '\x1b[B') state.row = Math.min(state.lines.length - 1, state.row + 1);
  state.col = Math.min(state.col, state.lines[state.row]!.length);
}
function removeChar(state: BufferState): void { const line = state.lines[state.row]!; if (state.col < line.length) { state.lines[state.row] = line.slice(0, state.col) + line.slice(state.col + 1); state.dirty = true; } }
function find(state: BufferState, query: string, afterCurrent = false): { row: number; col: number } | null {
  if (!query) return null;
  for (let row = state.row; row < state.lines.length; row++) {
    const offset = row === state.row ? state.col + (afterCurrent ? 1 : 0) : 0;
    const col = state.lines[row]!.indexOf(query, offset);
    if (col >= 0) return { row, col };
  }
  return null;
}
function moveToMatch(state: BufferState, query: string): void {
  const hit = find(state, query, true) ?? find({ ...state, row: 0, col: 0 }, query);
  if (hit) { state.row = hit.row; state.col = hit.col; }
}

function render(ctx: CommandContext, state: BufferState, kind: EditorKind, status: string): void {
  const rows = Math.max(4, Number(ctx.env.LINES ?? 24));
  const visible = Math.max(1, rows - 2);
  const start = Math.min(state.row, Math.max(0, state.lines.length - visible));
  const body = state.lines.slice(start, start + visible).map((line, i) => `${kind === 'vi' ? '~' : String(start + i + 1).padStart(4, ' ')} ${line}`).join('\r\n');
  ctx.stdout.write(`\x1b[2J\x1b[H\x1b[1m${kind === 'vi' ? 'vi' : 'nano'}: ${state.path}${state.dirty ? ' [+]' : ''}\x1b[0m\r\n${body}\r\n\x1b[7m${status}\x1b[0m`);
}

function splitKeys(input: string): string[] { const out: string[] = []; for (let i = 0; i < input.length;) { if (input.startsWith('\x1b[', i) && i + 2 < input.length) { const end = input.indexOf('~', i + 2); const letter = input[i + 2]; if (letter && 'ABCD'.includes(letter)) { out.push(input.slice(i, i + 3)); i += 3; continue; } if (end >= 0) { out.push(input.slice(i, end + 1)); i = end + 1; continue; } } const cp = input.codePointAt(i)!; const char = String.fromCodePoint(cp); out.push(char); i += char.length; } return out; }
function resolvePath(cwd: string, path: string): string { if (!path) return ''; if (path.startsWith('/')) return path; return `${cwd.replace(/\/$/, '')}/${path}`; }
