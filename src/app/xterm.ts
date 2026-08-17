// xterm 装配：全屏暗橙终端（JetBrains Mono，暖色暗调色板）+ FitAddon（O2 拆分）。
// bundle budget：xterm 是主 bundle 最大单体依赖（未压缩约 337 KB）。保持类型导入，
// 运行时经动态 import() 懒加载，主入口不静态携带 xterm（check:bundle-budget 400 KiB 预算）。
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';

let termInstance: Terminal | null = null;
let fitAddonInstance: FitAddon | null = null;
let termPromise: Promise<Terminal> | null = null;

// 初始化（幂等）：动态加载 xterm 与 FitAddon，绑定 #terminal 并完成首次 fit。
// 在终端插件 apply 阶段预热、container start 时 await，保证任何写入前已就绪。
export function ensureTerminal(): Promise<Terminal> {
  if (!termPromise) {
    termPromise = (async () => {
      const [{ Terminal: XtermTerminal }, { FitAddon: XtermFitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      const terminal = new XtermTerminal({
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 14,
        lineHeight: 1.15,
        cursorBlink: true,
        convertEol: true,
        scrollback: 3000,
        theme: {
          background: '#0a0a0a',
          foreground: '#d6cfc4',
          cursor: '#c2702a',
          cursorAccent: '#0a0a0a',
          selectionBackground: '#3a2a1a',
          selectionForeground: '#ffffff',
          black: '#1a1816',
          red: '#c0543a',
          green: '#7a8a5a',
          yellow: '#c98a2e',
          blue: '#7a8a9a',
          magenta: '#a06f9a',
          cyan: '#6f9a8a',
          white: '#d6cfc4',
          brightBlack: '#6b6560',
          brightRed: '#d96a4e',
          brightGreen: '#9aab72',
          brightYellow: '#dba04a',
          brightBlue: '#8aa0ae',
          brightMagenta: '#b887b0',
          brightCyan: '#86aea0',
          brightWhite: '#efe8dc',
        },
      });
      const fit = new XtermFitAddon();
      terminal.loadAddon(fit);
      terminal.open(document.getElementById('terminal')!);
      fit.fit();
      termInstance = terminal;
      fitAddonInstance = fit;
      return terminal;
    })().catch((error) => {
      termPromise = null;
      throw error;
    });
  }
  return termPromise;
}

// 同步取终端实例：调用方必须先 await ensureTerminal()（boot 流程保证）。
export function getTerm(): Terminal {
  if (!termInstance) {
    throw new Error('terminal not initialized; await ensureTerminal() first');
  }
  return termInstance;
}

export function getFitAddon(): FitAddon {
  if (!fitAddonInstance) {
    throw new Error('terminal not initialized; await ensureTerminal() first');
  }
  return fitAddonInstance;
}
