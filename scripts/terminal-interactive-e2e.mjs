#!/usr/bin/env node
// 浏览器真实终端门禁：只通过 CDP 操作 xterm textarea，验证 Lifo Shell 交互路径。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome, launchChrome, cleanupChrome } from './lib/chrome.mjs';
import { connectPageCDP, evalValue } from './lib/cdp.mjs';
import { run, sleep, waitForHttp } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const portIndex = args.indexOf('--port');
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 7904;
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1;
let failures = 0;

function check(condition, message) {
  if (condition) console.log(`  [  OK  ] ${message}`);
  else {
    failures++;
    console.error(`  [ FAIL ] ${message}`);
  }
}

async function terminalText(cdp) {
  return evalValue(cdp, `(() => {
    const term = window.__succinixBench?.term;
    const buffer = term?.buffer?.active;
    if (!buffer) return '';
    const lines = [];
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\\n');
  })()`);
}

async function waitForText(cdp, marker, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await terminalText(cdp)).includes(marker)) return true;
    await sleep(150);
  }
  return false;
}

function occurrences(text, marker) {
  return text.split(marker).length - 1;
}

async function waitForOccurrences(cdp, marker, minimum, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (occurrences(await terminalText(cdp), marker) >= minimum) return true;
    await sleep(150);
  }
  return false;
}

async function focus(cdp) {
  await evalValue(cdp, `(() => {
    const textarea = document.querySelector('textarea.xterm-helper-textarea');
    textarea?.focus();
    return document.activeElement === textarea;
  })()`);
}

async function insert(cdp, text) {
  await cdp.send('Input.insertText', { text });
}

async function key(cdp, keyName, code, modifiers = 0, virtualKeyCode = 0) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: keyName, code, modifiers, windowsVirtualKeyCode: virtualKeyCode,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: keyName, code, modifiers, windowsVirtualKeyCode: virtualKeyCode,
  });
}

async function enter(cdp) {
  await key(cdp, 'Enter', 'Enter', 0, 13);
}

async function captureXtermInput(cdp, action) {
  await evalValue(cdp, `(() => {
    const term = window.__succinixBench?.term;
    const probe = { data: [], dispose: null };
    probe.dispose = term?.onData((data) => probe.data.push(data)) ?? null;
    window.__succinixTerminalInputProbe = probe;
  })()`);
  await action();
  return evalValue(cdp, `(() => {
    const probe = window.__succinixTerminalInputProbe;
    probe?.dispose?.dispose();
    delete window.__succinixTerminalInputProbe;
    return probe?.data ?? [];
  })()`);
}

async function command(cdp, text, marker, timeoutMs = 30000) {
  await focus(cdp);
  await insert(cdp, text);
  await enter(cdp);
  return waitForText(cdp, marker, timeoutMs);
}

async function waitForTerminal(cdp) {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const ready = await evalValue(cdp, '!!window.__succinixBench?.term && !!document.querySelector("textarea.xterm-helper-textarea")');
    if (ready) return true;
    await sleep(250);
  }
  return false;
}

async function runInteractiveChecks(cdp) {
  const tag = `interactive-${Date.now().toString(36)}`;
  check(await command(cdp, `echo ${tag}-input`, `${tag}-input`), 'xterm keystrokes reach the Lifo shell');

  // CDP Input.insertText models browser text insertion (IME/paste), not a shell shortcut.
  check(await command(cdp, `echo ${tag}-paste`, `${tag}-paste`), 'xterm text insertion reaches the Lifo shell');

  await focus(cdp);
  const historyCount = occurrences(await terminalText(cdp), `${tag}-paste`);
  await key(cdp, 'ArrowUp', 'ArrowUp', 0, 38);
  await enter(cdp);
  const afterHistory = await waitForOccurrences(cdp, `${tag}-paste`, historyCount + 2);
  const historyText = await terminalText(cdp);
  check(afterHistory && occurrences(historyText, `${tag}-paste`) >= historyCount + 2, 'Lifo shell history repeats the prior command');

  await focus(cdp);
  await insert(cdp, 'ech');
  await key(cdp, 'Tab', 'Tab', 0, 9);
  await insert(cdp, ` ${tag}-tab`);
  await enter(cdp);
  check(await waitForText(cdp, `${tag}-tab`), 'Lifo shell completion accepts Tab input');

  await focus(cdp);
  await insert(cdp, 'sleep 20');
  await enter(cdp);
  await sleep(500);
  const ctrlCInput = await captureXtermInput(cdp, () => key(cdp, 'c', 'KeyC', 2, 67));
  // Browser onData dispatch is intentionally fire-and-forget. Give the mailbox
  // one input cycle before submitting the next shell command.
  await sleep(150);
  const interrupted = await command(cdp, `echo ${tag}-interrupt`, `${tag}-interrupt`, 10000);
  check(ctrlCInput.includes('\u0003'), 'Ctrl+C emits ETX from xterm');
  check(interrupted, 'Ctrl+C interrupts the foreground Lifo command');

  const before = await evalValue(cdp, '({ cols: window.__succinixBench.term.cols, rows: window.__succinixBench.term.rows })');
  const resized = await evalValue(cdp, `(() => {
    const term = window.__succinixBench.term;
    term.resize(${Number(before.cols) + 5}, ${Number(before.rows) + 3});
    return { cols: term.cols, rows: term.rows };
  })()`);
  const dimensions = `${resized.cols}:${resized.rows}`;
  const resizedOutput = await command(cdp, 'echo "$COLUMNS:$LINES"', dimensions);
  check(resized.cols !== before.cols && resized.rows !== before.rows && resizedOutput, 'xterm resize updates Lifo COLUMNS and LINES');

  check(await command(cdp, `printf 'alpha beta beta\\n' > ${tag}-vi.txt; echo ${tag}-vi-ready`, `${tag}-vi-ready`), 'Lifo shell prepares the vi fixture');
  await focus(cdp);
  await insert(cdp, `vi ${tag}-vi.txt`);
  await enter(cdp);
  const viOpened = await waitForText(cdp, `vi: /workspace/${tag}-vi.txt`);
  await insert(cdp, '/beta');
  await enter(cdp);
  await sleep(100);
  await insert(cdp, 'n');
  await sleep(100);
  await insert(cdp, 'i');
  await sleep(100);
  await insert(cdp, 'V7');
  await sleep(100);
  await key(cdp, 'Escape', 'Escape', 0, 27);
  await sleep(100);
  await insert(cdp, ':wq');
  await enter(cdp);
  await sleep(150);
  const viSaved = await command(cdp, `cat ${tag}-vi.txt`, 'V7');
  check(viOpened && viSaved, 'vi raw mode supports search, repeat, edit, and save');

  await sleep(150);
  await focus(cdp);
  await insert(cdp, `nano ${tag}-nano.txt`);
  await enter(cdp);
  const nanoOpened = await waitForText(cdp, `nano: /workspace/${tag}-nano.txt`);
  await sleep(100);
  await insert(cdp, 'nano-search-text');
  await sleep(100);
  await key(cdp, 'w', 'KeyW', 2, 87);
  await sleep(100);
  await insert(cdp, 'search');
  await enter(cdp);
  await sleep(100);
  await key(cdp, 'o', 'KeyO', 2, 79);
  await sleep(100);
  await key(cdp, 'x', 'KeyX', 2, 88);
  await sleep(150);
  const nanoSaved = await command(cdp, `cat ${tag}-nano.txt`, 'nano-search-text');
  check(nanoOpened && nanoSaved, 'nano raw mode supports search, save, and exit');

  await evalValue(cdp, 'window.__succinixBench.respawn().then(() => true)');
  check(await command(cdp, `echo ${tag}-respawn`, `${tag}-respawn`, 60000), 'host respawn reconnects the same xterm session');
  await command(cdp, `rm -f ${tag}-vi.txt ${tag}-nano.txt`, '', 5000);
  if (failures > 0) console.error(`[terminal-e2e] terminal tail:\n${(await terminalText(cdp)).slice(-2400)}`);
}

async function main() {
  console.log('[terminal-e2e] Chrome xterm to Lifo interactive gate');
  if (!SKIP_BUILD) await run('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('dist/index.html is missing');
  if (!findChrome()) throw new Error('headless Chrome not found');

  const preview = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  let chrome;
  let profileDir;
  let cdp;
  try {
    await waitForHttp(BASE, 20000);
    ({ chrome, profileDir } = launchChrome(DEBUG_PORT, 'terminal-e2e'));
    cdp = await connectPageCDP(DEBUG_PORT);
    await cdp.send('Page.navigate', { url: `${BASE}/?bench=1` });
    const ready = await waitForTerminal(cdp);
    check(ready, 'xterm device and interactive terminal are ready');
    if (ready) await runInteractiveChecks(cdp);
  } finally {
    cdp?.close();
    cleanupChrome(chrome, profileDir);
    preview.kill('SIGTERM');
  }
  console.log(`[terminal-e2e] RESULT: ${failures === 0 ? 'PASSED' : 'FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`[terminal-e2e] FATAL: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
