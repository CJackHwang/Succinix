// xterm 装配：全屏暗橙终端（JetBrains Mono，暖色暗调色板）+ FitAddon（O2 拆分）。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';

// ─── xterm：全屏暗橙终端（JetBrains Mono，暖色暗调色板）───
export const term = new Terminal({
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
export const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal')!);
fitAddon.fit();
