// app plugin: xterm terminal surface.
import type { Context } from '@deepseek-ai/cordis';
import { AMBER, RESET } from '../../theme.js';
import { ensureTerminal, getFitAddon, getTerm as getXtermTerm } from '../../app/xterm.js';
import type { AppShell, AppTerminalService } from '../types.js';

export const name = 'succinix-app-terminal';

export function apply(ctx: Context): void {
  let disposeWire: (() => void) | undefined;
  // 预热 xterm 懒加载 chunk；container start 时 await 同一 promise 保证就绪。
  void ensureTerminal();
  const service: AppTerminalService = {
    getTerm: () => getXtermTerm(),
    fit: () => getFitAddon().fit(),
    wire(shell: AppShell) {
      disposeWire?.();
      let current = true;
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
        .then(() => { if (current) ctx.emit('succinix/terminal-open', terminalEvent()); })
        .catch((error) => {
          if (current) shell.term.writeln(`\r\n${AMBER}[terminal]${RESET} transport unavailable: ${String(error)}`);
        });
      const dataListener = shell.term.onData?.((data) => { if (current) void shell.interactive.sendData(data); });
      // Older embedders/tests may expose only xterm's onData surface.  Resize
      // is additive and must not prevent the execution-world shell from booting.
      const resizeListener = shell.term.onResize?.(({ cols, rows }) => { if (current) void shell.interactive.resize(cols, rows); });
      const removeServerReady = shell.wc.on('server-ready', (port, url) => {
        if (!current) return;
        shell.term.writeln(`\r\n${AMBER}[preview]${RESET} Port ${port} ready -> ${url}`);
      });
      disposeWire = () => {
        current = false;
        dataListener?.dispose();
        resizeListener?.dispose();
        removeServerReady();
      };
    },
  };
  ctx.provide('succinix-app-terminal', service);
  ctx.effect(() => () => disposeWire?.());
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
