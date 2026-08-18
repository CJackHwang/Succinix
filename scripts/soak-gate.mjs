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
import { run, sleep, waitForHttp } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const RPC_TOTAL = 10_000;
const INPUT_OUTPUT_PAIRS = 50_000;
const RELEASE_CYCLES = 100;
const INTERACTIVE_CYCLES = 40;

function note(message) {
  console.log(`[soak] ${message}`);
}

function assertion(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`[  OK  ] ${message}`);
}

export function hasCompleteOrderedSequence(markers, total) {
  return markers.length === total && markers.every((marker, index) => marker === index);
}

async function waitForBench(cdp) {
  const deadline = Date.now() + 150_000;
  let last = 'unavailable';
  while (Date.now() < deadline) {
    last = await evalValue(cdp, `JSON.stringify({
      client: !!window.__succinixBench?.client,
      host: !!window.__succinixBench?.host,
      interactive: !!window.__succinixBench?.interactive,
      readyState: document.readyState,
      overlayPresent: !!document.getElementById('boot-overlay'),
      url: location.href,
    })`);
    const ready = JSON.parse(last);
    if (ready.client && ready.host && ready.interactive) return;
    await sleep(250);
  }
  throw new Error(`${last.includes('"overlayPresent":true') && last.includes('"client":false') && last.includes('"host":false') ? 'BENCH_BOOTSTRAP_STALL: ' : ''}bench hook did not become ready: ${last}`);
}

function rpcExpression() {
  return `(async () => {
    const total = ${RPC_TOTAL};
    const batchSize = 80;
    const b = window.__succinixBench;
    const durations = [];
    let completed = 0;
    let respawns = 0;
    let postRespawnPings = 0;
    const within = (promise, timeoutMs, label) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + ' exceeded ' + timeoutMs + 'ms')), timeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
    for (let start = 0; start < total; start += batchSize) {
      const count = Math.min(batchSize, total - start);
      const refresh = (start + count) % 2000 === 0 && start + count < total;
      // Keep the old daemon busy before every refresh. The priority exit must
      // still be acknowledged while this Lifo command owns the normal loop;
      // the ping batch then proves that old-epoch readonly requests recover.
      const blocker = refresh
        ? b.client.exec('run', { command: 'sleep 20' }, 60000).catch(() => null)
        : null;
      if (blocker) await new Promise((resolve) => setTimeout(resolve, 120));
      const pending = Promise.all(Array.from({ length: count }, () => b.client.exec('ping', undefined, 60000)));
      // The respawn must overlap requests that were already accepted by the
      // old host. Restarting only after waiting for pending cannot expose epoch or
      // ACK fencing faults.
      const respawn = refresh ? b.respawn() : null;
      const batchLabel = '10k RPC batch ' + start + '-' + (start + count - 1) + (respawn ? ' during host respawn' : '');
      const results = await within(pending, 75_000, batchLabel);
      if (respawn) {
        await within(respawn, 75_000, batchLabel + ' restart');
        await within(blocker, 75_000, batchLabel + ' priority shutdown');
        respawns += 1;
      }
      for (const result of results) {
        if (!result.ok || result.kind !== 'pong') throw new Error('RPC result was lost or invalid');
        completed += 1;
        if (Number.isFinite(result.timing?.totalMs)) durations.push(result.timing.totalMs);
      }
      if (respawn) {
        const probe = await b.client.exec('ping', undefined, 60000);
        if (!probe.ok || probe.kind !== 'pong') throw new Error('RPC did not recover after host respawn');
        postRespawnPings += 1;
      }
    }
    durations.sort((left, right) => left - right);
    return {
      completed,
      samples: durations.length,
      respawns,
      postRespawnPings,
      p95: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] ?? null,
    };
  })()`;
}

function frameExpression() {
  return `(async () => {
    const total = ${INPUT_OUTPUT_PAIRS};
    const batchSize = 250;
    const b = window.__succinixBench;
    const terminal = b.interactive;
    const initial = { input: terminal.sentInputSequence, output: terminal.receivedOutputSequence };
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const tag = 'frame-soak-' + Date.now().toString(36);
    let output = '';
    const unsubscribe = terminal.onOutput((data) => { output += data; });
    const waitFor = async (targetInput, marker) => {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        if (terminal.sentInputSequence >= targetInput && terminal.receivedOutputSequence > initial.output && output.includes(marker)) return;
        await pause(20);
      }
      throw new Error('terminal input/output frame delivery timed out (input=' + terminal.sentInputSequence + ', output=' + terminal.receivedOutputSequence + ', marker=' + marker + ')');
    };
    try {
      for (let start = 0; start < total; start += batchSize) {
        const count = Math.min(batchSize, total - start);
        const marker = tag + '-' + (start + count - 1);
        // Every sendData call writes one real mailbox input frame. A batch
        // forms one semicolon-delimited shell line, so the profile exercises
        // input frame ordering without relying on Lifo's internal paste queue.
        await Promise.all(Array.from({ length: count }, (_, index) => {
          const sequence = start + index;
          return terminal.sendData("printf '" + tag + "-%d' " + sequence + (index === count - 1 ? '\\r' : ';'));
        }));
        await waitFor(initial.input + start + count, marker);
      }
      const burstBytes = 256 * 1024;
      const burstMarker = tag + '-burst-complete';
      const singleQuote = String.fromCharCode(39);
      const beforeBurstOutputBytes = terminal.receivedOutputByteCount;
      await terminal.sendData('node -e "process.stdout.write(' + singleQuote + 'B' + singleQuote + '.repeat(' + burstBytes + '))"; printf "%s%s" ' + tag + ' "-burst-complete"\\r');
      await waitFor(initial.input + total + 1, burstMarker);
      const markers = Array.from(output.matchAll(new RegExp(tag + '-(\\\\d+)', 'g')), (match) => Number(match[1]));
      const seen = new Set(markers);
      const missing = Array.from({ length: total }, (_, index) => index).filter((index) => !seen.has(index));
      return {
        inputFrames: terminal.sentInputSequence - initial.input,
        outputFrames: terminal.receivedOutputSequence - initial.output,
        completeSequence: markers.length === total && markers.every((marker, index) => marker === index),
        duplicateSequenceCount: markers.length - seen.size,
        outOfOrder: markers.some((marker, index) => marker !== index),
        markerCount: markers.length,
        outputMarkers: seen.size,
        missingSequenceCount: missing.length,
        burstBytes: terminal.receivedOutputByteCount - beforeBurstOutputBytes,
        requiredBurstBytes: burstBytes,
      };
    } finally {
      unsubscribe();
    }
  })()`;
}

function interactiveExpression() {
  return `(async () => {
    const b = window.__succinixBench;
    const terminal = b.interactive;
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let output = '';
    const unsubscribe = terminal.onOutput((data) => { output += data; });
    const waitFor = async (marker) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (output.includes(marker)) return;
        await pause(20);
      }
      throw new Error('interactive terminal did not return after ' + marker + ' (input=' + terminal.sentInputSequence + ', output=' + terminal.receivedOutputSequence + ')');
    };
    const initialInput = terminal.sentInputSequence;
    const initialOutput = terminal.receivedOutputSequence;
    const tag = 'interactive-soak-' + Date.now().toString(36);
    try {
      for (let index = 0; index < ${INTERACTIVE_CYCLES}; index += 1) {
        b.term.resize(80 + index % 7, 24 + index % 5);
        const marker = tag + '-paste-' + index;
        await terminal.sendData('printf ' + marker + '\\r');
        await waitFor(marker);
        if (index % 5 === 4) {
          await terminal.sendData('sleep 20\\r');
          await pause(60);
          await terminal.sendData('\\u0003');
          // Ctrl+C must reach the shell before the next line is submitted.
          await pause(150);
          const resumed = tag + '-interrupt-' + index;
          await terminal.sendData('printf ' + resumed + '\\r');
          await waitFor(resumed);
        }
      }
      await pause(100);
      return {
        inputFrames: terminal.sentInputSequence - initialInput,
        outputFrames: terminal.receivedOutputSequence - initialOutput,
        bufferedBytes: terminal.bufferedBytes,
        backpressured: terminal.backpressured,
      };
    } finally {
      unsubscribe();
    }
  })()`;
}

function lifecycleExpression() {
  return `(async () => {
    const b = window.__succinixBench;
    const tag = 'soak-' + Date.now().toString(36);
    const snapshotPath = '/' + tag + '-snapshot.txt';
    await b.wc.fs.writeFile(snapshotPath, 'before');
    const saved = await b.saveSnapshot(true);
    await b.wc.fs.writeFile(snapshotPath, 'after');
    await b.restoreSnapshot();
    const restored = await b.wc.fs.readFile(snapshotPath, 'utf8');
    let released = 0;
    for (let index = 0; index < ${RELEASE_CYCLES}; index += 1) {
      const instanceId = tag + '-instance-' + index;
      const instance = await b.host.ensureInstance(instanceId, {
        home: '/workspace/' + instanceId,
        persistence: { dbName: 'succinix-soak', storeKey: instanceId },
        executor: {},
      });
      const result = await instance.executor.exec('echo ' + instanceId, { timeoutMs: 30000 });
      if (!result.ok || !String(result.stdout ?? '').includes(instanceId)) throw new Error('instance command failed');
      const terminal = await b.host.terminal.open({ instanceId, cols: 80, rows: 24 });
      await terminal.send('echo terminal-' + index + '\\r');
      await terminal.close();
      await b.host.releaseInstance(instanceId);
      if (b.host.getInstance(instanceId) !== undefined) throw new Error('released instance remained reachable');
      released += 1;
    }
    // WebContainer's server-ready event is outside the host process registry.
    // It remains observable after host respawn, so it can expose a real child
    // or service that survived after the new host cleared its own ps projection.
    const port = 34000 + Math.floor(Math.random() * 2000);
    const serverEvents = [];
    b.wc.on('server-ready', (readyPort, url) => serverEvents.push({ port: readyPort, url }));
    const childScript = "require('node:http').createServer((_, response) => response.end('soak')).listen(" + port + ')';
    const child = await b.client.spawn('node -e ' + JSON.stringify(childScript), undefined, 30000);
    if (!child.ok || !Number.isInteger(child.pid)) throw new Error('host respawn fixture did not start');
    const deadline = Date.now() + 30_000;
    let url = '';
    while (Date.now() < deadline && !url) {
      url = String(serverEvents.find((event) => event.port === port)?.url ?? '');
      if (!url) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!url) throw new Error('independent WebContainer port was not observed before host respawn');
    // WebContainer 预览 URL 受跨源代理边界保护，页面不能读取响应内容。
    // 保留 server-ready 作为独立观察源，再从同一执行世界验证真实子进程响应。
    const probePort = async (timeoutMs) => {
      const script = 'fetch(' + JSON.stringify('http://127.0.0.1:' + port) + ', { signal: AbortSignal.timeout(' + timeoutMs + ') })' +
        '.then(async (response) => { if (!response.ok) { process.exitCode = 1; return; } process.stdout.write(await response.text()); })' +
        '.catch(() => { process.exitCode = 1; })';
      return b.client.exec('run', { command: 'node -e ' + JSON.stringify(script) }, timeoutMs + 10_000);
    };
    const before = await probePort(5_000);
    if (!before.ok || String(before.stdout ?? '').trim() !== 'soak') throw new Error('independent port did not serve the child response before host respawn');
    await b.respawn();
    const ping = await b.client.exec('ping', undefined, 60000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await probePort(3_000).catch(() => null);
    const portOpenAfterRespawn = after?.ok === true && String(after.stdout ?? '').trim() === 'soak';
    return {
      snapshotRestored: restored === 'before' && saved?.skipped !== true,
      released,
      recovered: ping.ok && ping.kind === 'pong',
      independentPortClosed: !portOpenAfterRespawn,
      fixture: { pid: child.pid, port, url },
    };
  })()`;
}

async function runProfile(cdp, profile) {
  if (profile === '10k') {
    const result = await evalValue(cdp, rpcExpression());
    assertion(result.completed === RPC_TOTAL && result.samples === RPC_TOTAL, `${RPC_TOTAL} independent batch RPC results completed`);
    assertion(result.respawns > 0 && result.postRespawnPings === result.respawns, 'every in-flight host respawn restored an active-epoch batch RPC endpoint');
    return;
  }
  if (profile === '100k') {
    const result = await evalValue(cdp, frameExpression());
    assertion(result.inputFrames === INPUT_OUTPUT_PAIRS + 1, `${INPUT_OUTPUT_PAIRS} real terminal input frames were delivered`);
    assertion(result.outputMarkers === INPUT_OUTPUT_PAIRS && result.markerCount === INPUT_OUTPUT_PAIRS, `${INPUT_OUTPUT_PAIRS} real terminal output markers were delivered exactly once`);
    assertion(result.completeSequence && result.missingSequenceCount === 0 && result.duplicateSequenceCount === 0 && result.outOfOrder === false, 'all terminal output markers arrived in order without a sequence gap or duplicate');
    assertion(result.burstBytes >= result.requiredBurstBytes, `${result.requiredBurstBytes} byte terminal output burst was not truncated (received ${result.burstBytes})`);
    return;
  }
  if (profile === 'interactive') {
    const result = await evalValue(cdp, interactiveExpression());
    assertion(result.inputFrames > 0 && result.outputFrames > 0, 'interactive resize, paste, and Ctrl+C produced mailbox frames');
    assertion(result.bufferedBytes === 0 && result.backpressured === false, 'interactive terminal drained without backpressure');
    return;
  }
  if (profile === '100-release') {
    const result = await evalValue(cdp, lifecycleExpression());
    assertion(result.snapshotRestored, 'binary snapshot restores the exact saved content');
    assertion(result.released === RELEASE_CYCLES, `${RELEASE_CYCLES} instance create/release cycles completed`);
    assertion(result.recovered, 'host respawn recovers the current batch RPC endpoint');
    assertion(result.independentPortClosed, `host respawn closes independent child port ${result.fixture.port} (pid ${result.fixture.pid})`);
    return;
  }
  throw new Error(`unknown soak profile: ${profile}`);
}

export async function runSoakGate({ profile, skipBuild, port }) {
  if (!['all', '10k', '100k', 'interactive', '100-release'].includes(profile)) throw new Error(`unknown --soak profile: ${profile}`);
  if (!skipBuild) await run('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('dist/index.html is missing');
  if (!findChrome()) throw new Error('headless Chrome not found');

  const { previewPort, debugPort } = await allocateBrowserPorts(port ?? 0);
  const base = `http://127.0.0.1:${previewPort}`;
  note(`using isolated preview/debug ports ${previewPort}/${debugPort}`);
  const preview = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(previewPort), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  let chromeRun;
  let cdp;
  let pageDiagnostics;
  let failure;
  try {
    await waitForHttp(base, 20_000);
    chromeRun = launchChrome(debugPort, `soak-${process.pid}`);
    cdp = await connectPageCDP(debugPort);
    await cdp.send('Log.enable');
    pageDiagnostics = attachPageDiagnostics(cdp);
    await cdp.send('Page.navigate', { url: `${base}/?bench=1` });
    await waitForBench(cdp);
    for (const current of profile === 'all' ? ['10k', '100k', 'interactive', '100-release'] : [profile]) {
      note(`running ${current} profile`);
      await runProfile(cdp, current);
    }
  } catch (error) {
    failure = error;
    const diagnostics = await writeBrowserFailureDiagnostics({
      label: `soak-${process.pid}`,
      error,
      cdp,
      pageDiagnostics,
      chromeRun,
      previewPort,
      debugPort,
    });
    console.error(`[soak] failure diagnostics: ${diagnostics.reportPath}`);
    throw error;
  } finally {
    pageDiagnostics?.dispose();
    cdp?.close();
    const cleanup = await cleanupChrome(chromeRun?.chrome, chromeRun?.profileDir);
    if (!cleanup.exited || cleanup.descendantsAfter.length > 0 || !cleanup.profileRemoved) {
      console.error(`[soak] cleanup diagnostic: ${JSON.stringify(cleanup)}`);
    }
    await stopPreview(preview);
    if (failure) note('failure diagnostics were retained in the temporary directory above');
  }
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
