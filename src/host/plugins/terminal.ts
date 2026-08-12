// app plugin: xterm terminal surface.
import type { Context } from 'cordis';
import { AMBER, RESET } from '../../theme.js';
import { term, fitAddon } from '../../app/xterm.js';
import { output } from '../../app/output.js';
import type { AppShell, AppTerminalService } from '../types.js';

export const name = 'succinix-app-terminal';

export function apply(ctx: Context): void {
  const service: AppTerminalService = {
    getTerm: () => term,
    getOutput: () => output,
    fit: () => fitAddon.fit(),
    wire(shell: AppShell) {
      shell.term.onData((data) => shell.instance.terminal.handleData(data));
      shell.wc.on('server-ready', (port, url) => {
        shell.term.writeln(`\r\n${AMBER}[preview]${RESET} Port ${port} ready -> ${url}`);
      });
    },
  };
  ctx.provide('succinix-app-terminal', service);
}

const plugin = { name, apply };
export default plugin;
