// app plugin: xterm terminal surface.
import type { Context } from '@deepseek-ai/cordis';
import { AMBER, RESET } from '../../theme.js';
import { ensureTerminal, getFitAddon, getTerm as getXtermTerm } from '../../app/xterm.js';
import type { AppShell, AppTerminalService } from '../types.js';

export const name = 'succinix-app-terminal';

export function apply(ctx: Context): void {
  // 预热 xterm 懒加载 chunk；container start 时 await 同一 promise 保证就绪。
  void ensureTerminal();
  const service: AppTerminalService = {
    getTerm: () => getXtermTerm(),
    fit: () => getFitAddon().fit(),
    wire(shell: AppShell) {
      // xterm is only the device plane.  The Lifo Shell (inside WebContainer)
      // owns line editing, history, completion, raw mode, and job control;
      // this bridge forwards bytes and live dimensions without interpreting
      // command text in the browser.
      const terminalEvent = () => ({
        instanceId: shell.instanceId,
        sessionId: shell.interactive.sessionId,
        bootNonce: shell.interactive.bootNonce,
      });
      void shell.interactive.open()
        .then(() => ctx.emit('succinix/terminal-open', terminalEvent()))
        .catch((error) => {
          shell.term.writeln(`\r\n${AMBER}[terminal]${RESET} transport unavailable: ${String(error)}`);
        });
      shell.term.onData?.((data) => { void shell.interactive.sendData(data); });
      // Older embedders/tests may expose only xterm's onData surface.  Resize
      // is additive and must not prevent the execution-world shell from booting.
      shell.term.onResize?.(({ cols, rows }) => { void shell.interactive.resize(cols, rows); });
      shell.wc.on('server-ready', (port, url) => {
        shell.term.writeln(`\r\n${AMBER}[preview]${RESET} Port ${port} ready -> ${url}`);
      });
    },
  };
  ctx.provide('succinix-app-terminal', service);
  if (typeof window !== 'undefined') {
    const onResize = () => {
      try { service.fit(); } catch { /* 终端尚未完成挂载时无需处理 */ }
    };
    window.addEventListener('resize', onResize);
    ctx.effect(() => () => window.removeEventListener('resize', onResize));
  }
}

const plugin = { name, apply };
export default plugin;
