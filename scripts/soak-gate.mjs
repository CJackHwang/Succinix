import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupChrome, findChrome, launchChrome } from './lib/chrome.mjs';
import { connectPageCDP, evalValue } from './lib/cdp.mjs';
import { run, sleep, waitForHttp } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const RPC_TOTAL = 10_000;
const FRAME_PAIRS = 50_000;
const RELEASE_CYCLES = 100;
const INTERACTIVE_CYCLES = 40;

function note(message) {
  console.log(`[soak] ${message}`);
}

function assertion(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`[  OK  ] ${message}`);
}

async function waitForBench(cdp) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const ready = await evalValue(cdp, '!!window.__succinixBench?.client && !!window.__succinixBench?.host && !!window.__succinixBench?.interactive');
    if (ready) return;
    await sleep(250);
  }
  throw new Error('bench hook did not become ready');
}

function rpcExpression() {
  return `(async () => {
    const total = ${RPC_TOTAL};
    const batchSize = 80;
    const b = window.__succinixBench;
    const durations = [];
    let completed = 0;
    for (let start = 0; start < total; start += batchSize) {
      const count = Math.min(batchSize, total - start);
      const results = await Promise.all(Array.from({ length: count }, () => b.client.exec('ping', undefined, 60000)));
      for (const result of results) {
        if (!result.ok || result.kind !== 'pong') throw new Error('RPC result was lost or invalid');
        completed += 1;
        if (Number.isFinite(result.timing?.totalMs)) durations.push(result.timing.totalMs);
      }
      if ((start + count) % 2000 === 0 && start + count < total) {
        await b.respawn();
        const probe = await b.client.exec('ping', undefined, 60000);
        if (!probe.ok || probe.kind !== 'pong') throw new Error('RPC did not recover after host respawn');
      }
    }
    durations.sort((left, right) => left - right);
    return { completed, samples: durations.length, p95: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] ?? null };
  })()`;
}

function frameExpression() {
  return `(async () => {
    const total = ${FRAME_PAIRS};
    const batchSize = 500;
    const b = window.__succinixBench;
    const terminal = b.interactive;
    const initial = { input: terminal.sentInputSequence, output: terminal.receivedOutputSequence };
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (targetInput, targetOutput) => {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        if (terminal.sentInputSequence >= targetInput && terminal.receivedOutputSequence >= targetOutput) return;
        await pause(20);
      }
      throw new Error('terminal frame delivery timed out');
    };
    for (let start = 0; start < total; start += batchSize) {
      const count = Math.min(batchSize, total - start);
      for (let index = 0; index < count; index += 1) {
        const sequence = start + index;
        terminal.resize(80 + sequence % 7, 24 + sequence % 5);
      }
      await waitFor(initial.input + start + count, initial.output + start + count);
    }
    return {
      inputFrames: terminal.sentInputSequence - initial.input,
      outputFrames: terminal.receivedOutputSequence - initial.output,
    };
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
    const child = await b.client.spawn('node -e "setInterval(() => {}, 1000)"', undefined, 30000);
    if (!child.ok || !Number.isInteger(child.pid)) throw new Error('host respawn fixture did not start');
    await b.respawn();
    const ping = await b.client.exec('ping', undefined, 60000);
    const ps = await b.client.exec('ps', undefined, 60000);
    const orphaned = Array.isArray(ps.processes) && ps.processes.some((process) => process.pid === child.pid);
    return { snapshotRestored: restored === 'before' && saved?.skipped !== true, released, recovered: ping.ok && ping.kind === 'pong', orphaned };
  })()`;
}

async function runProfile(cdp, profile) {
  if (profile === '10k') {
    const result = await evalValue(cdp, rpcExpression());
    assertion(result.completed === RPC_TOTAL && result.samples === RPC_TOTAL, `${RPC_TOTAL} independent batch RPC results completed`);
    return;
  }
  if (profile === '100k') {
    const result = await evalValue(cdp, frameExpression());
    assertion(result.inputFrames === FRAME_PAIRS && result.outputFrames === FRAME_PAIRS, `${FRAME_PAIRS * 2} terminal input/output frames stayed ordered`);
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
    assertion(result.recovered && !result.orphaned, 'host respawn recovers RPC without an orphan process');
    return;
  }
  throw new Error(`unknown soak profile: ${profile}`);
}

export async function runSoakGate({ profile, skipBuild, port }) {
  if (!['all', '10k', '100k', 'interactive', '100-release'].includes(profile)) throw new Error(`unknown --soak profile: ${profile}`);
  if (!skipBuild) await run('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('dist/index.html is missing');
  if (!findChrome()) throw new Error('headless Chrome not found');

  const base = `http://127.0.0.1:${port}`;
  const preview = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  let chrome;
  let profileDir;
  let cdp;
  try {
    await waitForHttp(base, 20_000);
    ({ chrome, profileDir } = launchChrome(port + 1, 'soak-gate'));
    cdp = await connectPageCDP(port + 1);
    await cdp.send('Page.navigate', { url: `${base}/?bench=1` });
    await waitForBench(cdp);
    for (const current of profile === 'all' ? ['10k', '100k', 'interactive', '100-release'] : [profile]) {
      note(`running ${current} profile`);
      await runProfile(cdp, current);
    }
  } finally {
    cdp?.close();
    cleanupChrome(chrome, profileDir);
    preview.kill('SIGTERM');
  }
}
