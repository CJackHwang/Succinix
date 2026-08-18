#!/usr/bin/env node
// 浏览器真实终端门禁：只通过 CDP 操作 xterm textarea，验证 Lifo Shell 交互路径。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  allocateBrowserPorts,
  attachPageDiagnostics,
  cleanupChrome,
  findChrome,
  launchChrome,
  writeBrowserFailureDiagnostics,
} from './lib/chrome.mjs';
import { connectPageCDP, evalValue } from './lib/cdp.mjs';
import { verifyEditorUnicodeResizeAndLargeFile } from './lib/terminal-editor-e2e.mjs';
import { run, sleep, waitForHttp } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const portIndex = args.indexOf('--port');
const REQUESTED_PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;
const SHELL_PROMPT = 'guest@succinix:/workspace$';
let failures = 0;
const failedChecks = [];

function check(condition, message, details) {
  if (condition) console.log(`  [  OK  ] ${message}`);
  else {
    failures++;
    failedChecks.push(`${message}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
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

function percentile(samples, ratio) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function waitForOccurrences(cdp, marker, minimum, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (occurrences(await terminalText(cdp), marker) >= minimum) return true;
    await sleep(150);
  }
  return false;
}

async function waitForValue(cdp, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalValue(cdp, expression)) return true;
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
  const promptCount = occurrences(await terminalText(cdp), SHELL_PROMPT);
  await focus(cdp);
  await insert(cdp, text);
  await enter(cdp);
  if (!marker) {
    const returned = await waitForOccurrences(cdp, SHELL_PROMPT, promptCount + 1, timeoutMs);
    if (returned) await sleep(200);
    return returned;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = await terminalText(cdp);
    const markerAt = output.lastIndexOf(marker);
    if (markerAt >= 0 && output.indexOf(SHELL_PROMPT, markerAt + marker.length) >= 0) {
      // The prompt is rendered before the host scheduler releases its
      // interactive lock; let the completion microtask settle before the
      // next CDP input frame is submitted.
      await sleep(200);
      return true;
    }
    await sleep(150);
  }
  return false;
}

async function exitRawProgram(cdp, action, timeoutMs = 30000) {
  const promptCount = occurrences(await terminalText(cdp), SHELL_PROMPT);
  await action();
  await sleep(150);
  return waitForOccurrences(cdp, SHELL_PROMPT, promptCount + 1, timeoutMs);
}

async function waitForTerminal(cdp, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evalValue(cdp, `(() => {
      const bench = window.__succinixBench;
      return !!bench?.term && !!bench?.interactive && !bench.interactive.isFenced && !!document.querySelector('textarea.xterm-helper-textarea');
    })()`);
    if (ready && (await terminalText(cdp)).includes(SHELL_PROMPT)) return true;
    await sleep(250);
  }
  return false;
}

async function openAuxiliaryTerminal(cdp, key, instanceId) {
  return evalValue(cdp, `(async () => {
    const bench = window.__succinixBench;
    await bench.host.ensureInstance(${JSON.stringify(instanceId)});
    const session = await bench.host.terminal.open({ instanceId: ${JSON.stringify(instanceId)}, cols: 80, rows: 24 });
    const sessions = window.__succinixTerminalE2E ??= {};
    const state = { session, output: [] };
    state.unsubscribe = session.onData((data) => state.output.push(data));
    sessions[${JSON.stringify(key)}] = state;
    return { id: session.id };
  })()`);
}

async function sendAuxiliaryTerminal(cdp, key, data) {
  return evalValue(cdp, `(async () => {
    const state = window.__succinixTerminalE2E?.[${JSON.stringify(key)}];
    if (!state) return false;
    await state.session.send(${JSON.stringify(data)});
    return true;
  })()`);
}

async function waitForAuxiliaryText(cdp, key, marker, timeoutMs = 30000) {
  return waitForValue(cdp, `String(window.__succinixTerminalE2E?.[${JSON.stringify(key)}]?.output?.join('') ?? '').includes(${JSON.stringify(marker)})`, timeoutMs);
}

async function closeAuxiliaryTerminal(cdp, key, instanceId) {
  return evalValue(cdp, `(async () => {
    const sessions = window.__succinixTerminalE2E ?? {};
    const state = sessions[${JSON.stringify(key)}];
    if (state) {
      state.unsubscribe?.();
      await state.session.close();
      delete sessions[${JSON.stringify(key)}];
    }
    await window.__succinixBench.host.releaseInstance(${JSON.stringify(instanceId)});
    return window.__succinixBench.host.getInstance(${JSON.stringify(instanceId)}) === undefined;
  })()`);
}

async function openDirtyNano(cdp, path) {
  await focus(cdp);
  await insert(cdp, `nano ${path}`);
  await enter(cdp);
  await sleep(100);
  const opened = await waitForText(cdp, `nano: /workspace/${path}`);
  await insert(cdp, 'changed-');
  await sleep(100);
  await key(cdp, 'x', 'KeyX', 2, 88);
  await sleep(100);
  const prompted = await waitForText(cdp, 'Save modified buffer?');
  return { opened, prompted };
}

async function verifyNanoDiscard(cdp, path) {
  const opened = await openDirtyNano(cdp, path);
  const exited = await exitRawProgram(cdp, () => key(cdp, 'n', 'KeyN', 0, 78));
  const preserved = exited && await command(cdp, `cat ${path}`, 'original');
  return { ...opened, exited, preserved };
}

async function verifyNanoCancelAndSave(cdp, path) {
  const opened = await openDirtyNano(cdp, path);
  await key(cdp, 'c', 'KeyC', 0, 67);
  await sleep(100);
  const cancelled = await waitForText(cdp, '^O Write Out');
  await key(cdp, 'o', 'KeyO', 2, 79);
  await sleep(100);
  const exited = await exitRawProgram(cdp, () => key(cdp, 'x', 'KeyX', 2, 88));
  const saved = exited && await command(cdp, `cat ${path}`, 'changed-original');
  return { ...opened, cancelled, exited, saved };
}

async function verifyNanoDirtyQuit(cdp, tag) {
  const discardPath = `${tag}-nano-discard.txt`;
  const cancelPath = `${tag}-nano-cancel.txt`;
  const discardFixture = await command(cdp, `printf original > ${discardPath}; echo ${tag}-discard-ready`, `${tag}-discard-ready`);
  const discard = await verifyNanoDiscard(cdp, discardPath);
  const cancelFixture = await command(cdp, `printf original > ${cancelPath}; echo ${tag}-cancel-ready`, `${tag}-cancel-ready`);
  const cancel = await verifyNanoCancelAndSave(cdp, cancelPath);
  return {
    discard: discardFixture && discard.opened && discard.prompted && discard.exited && discard.preserved,
    cancel: cancelFixture && cancel.opened && cancel.prompted && cancel.cancelled && cancel.exited && cancel.saved,
    discardFixture,
    discardDetail: discard,
    cancelFixture,
    cancelDetail: cancel,
  };
}

function editorDriver(cdp) {
  return {
    focus: () => focus(cdp),
    insert: (text) => insert(cdp, text),
    enter: () => enter(cdp),
    key: (keyName, code, modifiers, virtualKeyCode) => key(cdp, keyName, code, modifiers, virtualKeyCode),
    sleep,
    waitForText: (marker, timeoutMs) => waitForText(cdp, marker, timeoutMs),
    exitRawProgram: (action, timeoutMs) => exitRawProgram(cdp, action, timeoutMs),
    command: (text, marker, timeoutMs) => command(cdp, text, marker, timeoutMs),
    evalValue: (expression) => evalValue(cdp, expression),
  };
}

async function verifyAuxiliaryTerminalLifecycle(cdp, tag) {
  const instanceId = `${tag}-aux`;
  const first = await openAuxiliaryTerminal(cdp, 'first', instanceId);
  const firstSent = await sendAuxiliaryTerminal(cdp, 'first', `echo ${tag}-aux-first\\r`);
  const firstOutput = await waitForAuxiliaryText(cdp, 'first', `${tag}-aux-first`);
  const firstState = await evalValue(cdp, `window.__succinixBench.host.getInstance(${JSON.stringify(instanceId)})?.instanceId === ${JSON.stringify(instanceId)}`);
  await evalValue(cdp, `(async () => {
    const state = window.__succinixTerminalE2E?.first;
    state?.unsubscribe?.();
    await state?.session.close();
    delete window.__succinixTerminalE2E?.first;
  })()`);

  const second = await openAuxiliaryTerminal(cdp, 'second', instanceId);
  const secondSent = await sendAuxiliaryTerminal(cdp, 'second', `echo ${tag}-aux-second\\r`);
  const secondOutput = await waitForAuxiliaryText(cdp, 'second', `${tag}-aux-second`);
  const released = await closeAuxiliaryTerminal(cdp, 'second', instanceId);
  return {
    isolated: first.id !== second.id && firstSent && firstOutput && firstState,
    reconnected: secondSent && secondOutput && released,
  };
}

async function openTerminalBackpressure(cdp, tag) {
  return evalValue(cdp, `(async () => {
    const bench = window.__succinixBench;
    const instanceId = ${JSON.stringify(String(tag) + '-backpressure')};
    await bench.host.ensureInstance(instanceId);
    const base = bench.wc.fs;
    const observations = { controls: [], outputBytes: 0, events: [] };
    const fs = {
      readFile: (path, encoding) => base.readFile(path, encoding),
      writeFile: (path, content) => base.writeFile(path, content),
      readdir: async (path) => (await base.readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })),
      mkdir: (path, options) => base.mkdir(path, options),
      rm: (path, options) => base.rm(path, options),
      rename: async (from, to) => {
        if (!String(to).endsWith('/ack.json')) await base.rename(from, to);
      },
    };
    const stop = bench.host.on('succinix/terminal-backpressure', (event) => observations.events.push(event));
    const terminal = new bench.interactive.constructor({
      fs,
      identity: {
        protocolVersion: 1,
        instanceId,
        sessionId: ${JSON.stringify(String(tag) + '-backpressure-session')},
        bootNonce: ${JSON.stringify(String(tag) + '-backpressure-nonce')},
      },
      cols: 80,
      rows: 24,
      onOutput: (data) => { observations.outputBytes += new TextEncoder().encode(data).byteLength; },
      onControl: (control, frame) => observations.controls.push({ control, bufferedBytes: frame.bufferedBytes, seq: frame.seq }),
    });
    window.__succinixTerminalE2E ??= {};
    window.__succinixTerminalE2E.backpressure = { instanceId, observations, stop, terminal };
    await terminal.open();
    return true;
  })()`);
}

async function observeTerminalBackpressure(cdp) {
  return evalValue(cdp, `(async () => {
    const state = window.__succinixTerminalE2E?.backpressure;
    if (!state) return { rejected: false, bufferedBytes: 0, controls: [], events: [], outputBytes: 0 };
    let rejected = false;
    try { await state.terminal.sendData('界'.repeat(350000)); } catch (error) { rejected = /backpressure/.test(String(error)); }
    await state.terminal.sendData('node -e "process.stdout.write(\\'B\\'.repeat(1200000))"\\r');
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !state.observations.controls.some((entry) => entry.control === 'backpressure')) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      rejected,
      bufferedBytes: state.terminal.bufferedBytes,
      controls: state.observations.controls,
      events: state.observations.events,
      outputBytes: state.observations.outputBytes,
      sentInputSequence: state.terminal.sentInputSequence,
      receivedOutputSequence: state.terminal.receivedOutputSequence,
    };
  })()`);
}

async function closeTerminalBackpressure(cdp) {
  return evalValue(cdp, `(async () => {
    const state = window.__succinixTerminalE2E?.backpressure;
    if (!state) return true;
    state.stop();
    await state.terminal.dispose();
    await window.__succinixBench.host.releaseInstance(state.instanceId);
    delete window.__succinixTerminalE2E.backpressure;
    return true;
  })()`);
}

async function verifyTerminalBackpressure(cdp, tag) {
  const opened = await openTerminalBackpressure(cdp, tag);
  try {
    return opened ? await observeTerminalBackpressure(cdp) : {
      rejected: false, bufferedBytes: 0, controls: [], events: [], outputBytes: 0, sentInputSequence: 0, receivedOutputSequence: 0,
    };
  } finally {
    await closeTerminalBackpressure(cdp);
  }
}

async function verifyAnsiBurst(cdp, tag) {
  const marker = `${tag}-ansi-burst`;
  const program = `node -e "process.stdout.write('\\x1b[31m' + 'A'.repeat(32768) + '\\x1b[0m ${marker}')"`;
  return command(cdp, program, marker, 60000);
}

async function measureTerminalOutputP95(cdp, tag) {
  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    const marker = `${tag}-p95-${index}`;
    const started = performance.now();
    if (!await command(cdp, `echo ${marker}`, marker, 10000)) return { samples, p95: null };
    samples.push(performance.now() - started);
  }
  return { samples, p95: percentile(samples, 0.95) };
}

async function verifySnapshotRefresh(cdp, tag) {
  const path = `${tag}-lkg.txt`;
  const seeded = await command(cdp, `printf known-good > ${path}; echo ${tag}-lkg-seeded`, `${tag}-lkg-seeded`);
  const saved = seeded && await evalValue(cdp, 'window.__succinixBench.saveSnapshot(true).then((result) => result?.skipped !== true)');
  const mutated = saved && await command(cdp, `printf mutated > ${path}; echo ${tag}-lkg-mutated`, `${tag}-lkg-mutated`);
  if (mutated) await evalValue(cdp, 'window.__succinixBench.restoreSnapshot()');
  const restored = mutated && await command(cdp, `cat ${path}`, 'known-good');
  await cdp.send('Page.reload', { ignoreCache: true });
  const ready = await waitForTerminal(cdp);
  const refreshedBytes = ready && await evalValue(cdp, `window.__succinixBench.wc.fs.readFile(${JSON.stringify(`/${path}`)}, 'utf8').catch((error) => String(error))`);
  const afterRefresh = ready && await command(cdp, `cat ${path}`, 'known-good');
  return { seeded, saved, mutated, restored, refreshedBytes, refreshed: afterRefresh === true };
}

async function verifyStaleTerminalFrame(cdp, tag) {
  const oldIdentity = await evalValue(cdp, `(() => {
    const terminal = window.__succinixBench.interactive;
    return { instanceId: terminal.instanceId, sessionId: terminal.sessionId, bootNonce: terminal.bootNonce };
  })()`);
  await evalValue(cdp, 'window.__succinixBench.respawn().then(() => true)');
  const reconnected = await waitForTerminal(cdp, 60000);
  const injected = await evalValue(cdp, `(async () => {
    const bench = window.__succinixBench;
    const terminal = bench.interactive;
    const dir = '/.succinix-terminal/' + encodeURIComponent(${JSON.stringify(oldIdentity.instanceId)}) + '/' + encodeURIComponent(${JSON.stringify(oldIdentity.sessionId)});
    const name = 'in-999999999999.json';
    await bench.wc.fs.mkdir(dir, { recursive: true });
    await bench.wc.fs.writeFile(dir + '/' + name, JSON.stringify({
      protocolVersion: 1,
      instanceId: ${JSON.stringify(oldIdentity.instanceId)},
      sessionId: ${JSON.stringify(oldIdentity.sessionId)},
      bootNonce: ${JSON.stringify(oldIdentity.bootNonce)},
      type: 'input',
      seq: 999999999999,
      data: 'echo ${tag}-stale-frame\\r',
    }));
    return { dir, name, nonceChanged: terminal.bootNonce !== ${JSON.stringify(oldIdentity.bootNonce)} };
  })()`);
  const removed = await waitForValue(cdp, `window.__succinixBench.wc.fs.readFile(${JSON.stringify(`${injected.dir}/${injected.name}`)}, 'utf8').then(() => false).catch(() => true)`, 10000);
  const staleExecuted = (await terminalText(cdp)).includes(`${tag}-stale-frame`);
  const currentWorks = await command(cdp, `echo ${tag}-active-frame`, `${tag}-active-frame`, 60000);
  return { reconnected, nonceChanged: injected.nonceChanged, removed, staleExecuted, currentWorks };
}

async function verifyOrphanMailboxTtl(cdp, tag) {
  const orphan = await evalValue(cdp, `(async () => {
    const sessionId = ${JSON.stringify(`${tag}-orphan`)};
    const dir = '/.succinix-terminal/default/' + encodeURIComponent(sessionId);
    const frame = dir + '/in-000000000001.json';
    await window.__succinixBench.wc.fs.mkdir(dir, { recursive: true });
    await window.__succinixBench.wc.fs.writeFile(frame, JSON.stringify({ type: 'input', data: 'stale' }));
    return { dir, frame };
  })()`);
  const created = await waitForValue(cdp, `window.__succinixBench.wc.fs.readFile(${JSON.stringify(orphan.frame)}, 'utf8').then(() => true).catch(() => false)`, 5000);
  await sleep(31000);
  const removed = await waitForValue(cdp, `window.__succinixBench.wc.fs.readFile(${JSON.stringify(orphan.frame)}, 'utf8').then(() => false).catch(() => true)`, 10000);
  const active = await command(cdp, `echo ${tag}-orphan-active`, `${tag}-orphan-active`);
  return { created, removed, active };
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

  const nanoDirtyQuit = await verifyNanoDirtyQuit(cdp, tag);
  check(nanoDirtyQuit.discard, 'nano dirty quit can discard without overwriting the workspace file', nanoDirtyQuit);
  check(nanoDirtyQuit.cancel, 'nano dirty quit can cancel and continue editing before save', nanoDirtyQuit);

  const editorCoverage = await verifyEditorUnicodeResizeAndLargeFile(editorDriver(cdp), tag);
  check(editorCoverage.unicode, 'vi saves astral and wide Unicode through real xterm input', editorCoverage);
  check(editorCoverage.resize, 'editor redraw observes live xterm resize and column clipping', editorCoverage);
  check(editorCoverage.large, 'editor opens and saves a multi-thousand-line workspace file', editorCoverage);

  const auxiliary = await verifyAuxiliaryTerminalLifecycle(cdp, tag);
  check(auxiliary.isolated, 'a second instance owns an independent interactive terminal session', auxiliary);
  check(auxiliary.reconnected, 'disposed auxiliary terminal reconnects as a fresh session and is released', auxiliary);

  const backpressure = await verifyTerminalBackpressure(cdp, tag);
  const hostBackpressure = backpressure.controls.some((entry) => entry.control === 'backpressure') || backpressure.events.length > 0;
  const orderedControlFrames = backpressure.controls.every((entry, index, frames) => index === 0 || entry.seq > frames[index - 1].seq);
  check(backpressure.rejected && backpressure.bufferedBytes <= 1024 * 1024, 'Unicode input above the terminal byte bound is rejected without queue growth', backpressure);
  check(hostBackpressure && backpressure.outputBytes > 0 && backpressure.bufferedBytes <= 1024 * 1024 && orderedControlFrames && backpressure.receivedOutputSequence > 0, 'unacknowledged output burst emits bounded terminal backpressure with ordered frames', backpressure);

  check(await verifyAnsiBurst(cdp, tag), 'a 32 KiB ANSI output burst reaches xterm without corrupting the interactive session');
  const outputP95 = await measureTerminalOutputP95(cdp, tag);
  console.log(`  [ INFO ] xterm command-to-output p95=${outputP95.p95 === null ? 'unavailable' : `${Math.round(outputP95.p95)}ms`}`);
  check(outputP95.p95 !== null && outputP95.p95 <= 1000, 'xterm command-to-output p95 stays within the browser gate budget', outputP95);

  const snapshot = await verifySnapshotRefresh(cdp, tag);
  check(snapshot.restored, 'LKG restore replaces a mutated workspace file with the saved bytes', snapshot);
  check(snapshot.refreshed, 'LKG snapshot remains exact after a real page refresh', snapshot);

  const staleFrame = await verifyStaleTerminalFrame(cdp, tag);
  check(staleFrame.reconnected && staleFrame.nonceChanged, 'host respawn rotates the xterm terminal nonce', staleFrame);
  check(staleFrame.removed && !staleFrame.staleExecuted && staleFrame.currentWorks, 'stale terminal frame is removed without execution while the active epoch remains usable', staleFrame);

  const orphan = await verifyOrphanMailboxTtl(cdp, tag);
  check(orphan.created && orphan.removed && orphan.active, 'orphaned terminal mailbox is pruned after its 30-second TTL without disrupting the active session', orphan);
  await command(cdp, `rm -f ${tag}-vi.txt ${tag}-nano.txt ${tag}-nano-discard.txt ${tag}-nano-cancel.txt ${tag}-unicode.txt ${tag}-large.txt ${tag}-lkg.txt`, '', 5000);
  if (failures > 0) console.error(`[terminal-e2e] terminal tail:\n${(await terminalText(cdp)).slice(-2400)}`);
}

async function main() {
  console.log('[terminal-e2e] Chrome xterm to Lifo interactive gate');
  if (!SKIP_BUILD) await run('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('dist/index.html is missing');
  if (!findChrome()) throw new Error('headless Chrome not found');

  const { previewPort, debugPort } = await allocateBrowserPorts(REQUESTED_PORT);
  const base = `http://127.0.0.1:${previewPort}`;
  console.log(`[terminal-e2e] using isolated preview/debug ports ${previewPort}/${debugPort}`);
  const preview = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(previewPort), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  let chromeRun;
  let cdp;
  let pageDiagnostics;
  let failure;
  try {
    await waitForHttp(base, 20000);
    chromeRun = launchChrome(debugPort, `terminal-e2e-${process.pid}`);
    cdp = await connectPageCDP(debugPort);
    await cdp.send('Log.enable');
    pageDiagnostics = attachPageDiagnostics(cdp);
    await cdp.send('Page.navigate', { url: `${base}/?bench=1` });
    const ready = await waitForTerminal(cdp);
    check(ready, 'xterm device and interactive terminal are ready');
    if (ready) await runInteractiveChecks(cdp);
    if (failures > 0) {
      failure = new Error(`${failures} interactive terminal assertions failed: ${failedChecks.join('; ')}`);
      const diagnostics = await writeBrowserFailureDiagnostics({
        label: `terminal-e2e-${process.pid}`,
        error: failure,
        cdp,
        pageDiagnostics,
        chromeRun,
        previewPort,
        debugPort,
      });
      console.error(`[terminal-e2e] failure diagnostics: ${diagnostics.reportPath}`);
    }
  } catch (error) {
    failure = error;
    const diagnostics = await writeBrowserFailureDiagnostics({
      label: `terminal-e2e-${process.pid}`,
      error,
      cdp,
      pageDiagnostics,
      chromeRun,
      previewPort,
      debugPort,
    });
    console.error(`[terminal-e2e] failure diagnostics: ${diagnostics.reportPath}`);
    throw error;
  } finally {
    pageDiagnostics?.dispose();
    cdp?.close();
    const cleanup = await cleanupChrome(chromeRun?.chrome, chromeRun?.profileDir);
    if (!cleanup.exited || cleanup.descendantsAfter.length > 0 || !cleanup.profileRemoved) {
      console.error(`[terminal-e2e] cleanup diagnostic: ${JSON.stringify(cleanup)}`);
    }
    await stopPreview(preview);
    if (failure) console.error('[terminal-e2e] failure diagnostics were retained in the temporary directory above');
  }
  console.log(`[terminal-e2e] RESULT: ${failures === 0 ? 'PASSED' : 'FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function stopPreview(preview) {
  if (!preview || preview.exitCode !== null || preview.signalCode !== null) return;
  preview.kill('SIGTERM');
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    preview.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  if (!exited && preview.exitCode === null && preview.signalCode === null) preview.kill('SIGKILL');
}

main().catch((error) => {
  console.error(`[terminal-e2e] FATAL: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
