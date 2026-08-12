// TerminalOutput / Terminal shim：xterm 只在应用层，SDK 契约走薄适配（O2 拆分）。
import type { TerminalOutput } from '@succinix/engine';
import type { Terminal } from '@xterm/xterm';
import { term } from './xterm.js';

// ─── TerminalOutput 适配（SDK 契约 ≤10 行；xterm 只在应用层）───
export const output: TerminalOutput = {
  write: (d) => term.write(d),
  clear: () => term.clear(),
};

export function termShimFor(out: TerminalOutput): Terminal {
  return {
    writeln: (l: unknown) => out.write(String(l) + '\r\n'),
    write: (d: unknown) => out.write(String(d)),
    clear: () => out.clear(),
  } as unknown as Terminal;
}
