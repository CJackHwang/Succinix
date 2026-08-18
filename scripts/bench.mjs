#!/usr/bin/env node
// Succinix TASK18 性能基准：headless Chrome + CDP，零新依赖（仿 verify-deploy.mjs 的 CDP 模式）。
// 测量并输出 JSON：boot 耗时、命令往返（Lifo echo hi / Node node -e 1）、快照开销（N=200/1000）、
// xterm 大输出（seq 1 5000）。
//
// 用法：
//   node scripts/bench.mjs [--skip-build] [--port 7894]
//   （默认先 npm run build 再用 vite preview 托管 dist/；--skip-build 要求 dist/ 已是最新。）
// 输出：JSON 单行到 stdout（CI 可复用）；进度日志走 stderr。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allocateBrowserPorts,
  attachPageDiagnostics,
  cleanupChrome,
  launchChrome,
  writeBrowserFailureDiagnostics,
} from './lib/chrome.mjs';
import { connectPageCDP, evalValue } from './lib/cdp.mjs';
import { run, waitForHttp, sleep } from './lib/harness.mjs';

const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const portIdx = args.indexOf('--port');
const REQUESTED_PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 0;
const COMMAND_SAMPLE_COUNT = 30;
const XTERM_BIG_SAMPLE_COUNT = 20;
const INTERACTIVE_SAMPLE_COUNT = 100;
const SESSION_APPEND_SAMPLE_COUNT = 10_000;

function note(msg) {
  console.error(`[bench] ${msg}`);
}
function warn(msg) {
  console.error(`[bench] WARN: ${msg}`);
}

// ─── 注入脚本：记录 boot 时间戳（覆盖层移除 / 提示符由 main.ts 的 bench 钩子记录）───
// window.__bootTimes = { start, overlayRemoved, prompt, phases? }；全部用 performance.now()。
const INJECT_SCRIPT = `(() => {
  if (window.__benchInjected) return;
  window.__benchInjected = true;
  window.__bootTimes = { start: performance.now(), overlayRemoved: null, prompt: null, phases: {} };
  const obs = new MutationObserver(() => {
    if (!document.getElementById('boot-overlay') && window.__bootTimes.overlayRemoved === null) {
      window.__bootTimes.overlayRemoved = performance.now();
      obs.disconnect();
    }
  });
  const arm = () => obs.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm);
  else arm();
})();`;

// 页面内统计助手：p50 / p95（样本就地排序，n 小直接取索引）。
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

function summarizeSamples(values, includeSamples = true) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    mean: Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100,
    sampleCount: sorted.length,
    ...(includeSamples ? { samples: sorted.map((x) => Math.round(x * 100) / 100) } : {}),
  };
}

// 等页面暴露 __succinixBench（boot 完成 + 提示符出现）。
async function waitForBenchHook(cdp, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  let lastState;
  while (Date.now() < deadline) {
    try {
      const v = await evalValue(cdp, `JSON.stringify({
        hook: !!window.__succinixBench,
        prompt: window.__bootTimes?.prompt ?? null,
        overlayPresent: !!document.getElementById('boot-overlay'),
        readyState: document.readyState,
        url: location.href,
        bodyText: String(document.body?.innerText ?? '').trim().slice(-500),
      })`);
      const st = JSON.parse(v);
      if (st.hook && st.prompt !== null) return;
      lastState = st;
      lastErr = new Error(`hook not ready: ${v}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(400);
  }
  if (
    lastState?.overlayPresent
    && lastState.readyState === 'complete'
    && lastState.bodyText === 'Starting system services...'
  ) {
    throw new Error(`BENCH_BOOTSTRAP_STALL: ${JSON.stringify(lastState)}`);
  }
  throw lastErr ?? new Error('bench hook did not appear within timeout');
}

// ─── 各项测量 ───

async function measureBoot(cdp) {
  const raw = await evalValue(cdp, `JSON.stringify({ ...window.__bootTimes, phases: { ...window.__bootTimes.phases } })`);
  const t = JSON.parse(raw);
  const phases = {};
  for (const [k, v] of Object.entries(t.phases ?? {})) {
    phases[k] = Math.round((v - t.start) * 100) / 100;
  }
  return {
    overlayRemoved: t.overlayRemoved === null ? null : Math.round((t.overlayRemoved - t.start) * 100) / 100,
    prompt: t.prompt === null ? null : Math.round((t.prompt - t.start) * 100) / 100,
    phases,
  };
}

async function measureCommands(cdp) {
  const res = await evalValue(cdp, `(async () => {
    const b = window.__succinixBench;
    const out = { lifo: [], node: [] };
    for (let i = 0; i < ${COMMAND_SAMPLE_COUNT}; i++) {
      const t0 = performance.now();
      const result = await b.client.terminal('echo hi');
      if (!result.ok || String(result.stdout ?? '').trim() !== 'hi') throw new Error('Lifo command sample failed');
      out.lifo.push(performance.now() - t0);
    }
    for (let i = 0; i < ${COMMAND_SAMPLE_COUNT}; i++) {
      const t0 = performance.now();
      const result = await b.client.terminal('node -e 1');
      if (!result.ok) throw new Error('Node command sample failed');
      out.node.push(performance.now() - t0);
    }
    return out;
  })()`);
  return { lifo: summarizeSamples(res.lifo), node: summarizeSamples(res.node) };
}

// 构造 N 文件目录 → saveSnapshot(force) 计时。创建与快照分开计时，便于定位成本。
async function measureSnapshot(cdp, n, dir) {
  return evalValue(cdp, `(async () => {
    const b = window.__succinixBench;
    const fs = b.wc.fs;
    const t0 = performance.now();
    await fs.mkdir('${dir}', { recursive: true });
    for (let i = 0; i < ${n}; i++) {
      await fs.writeFile('${dir}/f' + i + '.txt', 'bench content ' + i + ' padding padding padding\\n');
    }
    const createMs = performance.now() - t0;
    const s0 = performance.now();
    const r = await b.saveSnapshot(fs, true);
    const snapshotMs = performance.now() - s0;
    if (!r || r.skipped === true || !r.meta) throw new Error('forced snapshot did not produce a generation');
    return { createMs, snapshotMs, fileCount: r.meta.fileCount, skipped: r.skipped };
  })()`);
}

async function measureXtermBig(cdp) {
  // 优先 seq（Lifo 原生）；若内核无 seq，回落 node 子进程生成 5000 行。
  const probe = await evalValue(cdp, `(async () => {
    const b = window.__succinixBench;
    const r = await b.client.terminal('seq 1 3');
    return { ok: r.ok, out: String(r.stdout ?? '').trim() };
  })()`);
  const cmd = probe.ok && probe.out === '1\n2\n3' ? 'seq 1 5000' : 'node -e "for(let i=1;i<=5000;i++)console.log(i)"';
  if (cmd !== 'seq 1 5000') warn('Lifo seq unavailable; falling back to node loop for xterm big-output');
  const runs = await evalValue(cdp, `(async () => {
    const b = window.__succinixBench;
    const out = [];
    for (let i = 0; i < ${XTERM_BIG_SAMPLE_COUNT}; i++) {
      const t0 = performance.now();
      const res = await b.client.terminal(${JSON.stringify(cmd)});
      const ms = performance.now() - t0;
      const stdout = String(res.stdout ?? '');
      const lines = stdout.trim() ? stdout.split('\\n').length : 0;
      if (!res.ok || lines < 5000 || !stdout.includes('1\\n') || !stdout.includes('5000')) {
        throw new Error('large-output command failed (ok=' + String(res.ok) + ', lines=' + lines + ', bytes=' + stdout.length + ')');
      }
      // xterm 的 write callback 表示解析队列已清空；再等一帧，确保采样覆盖浏览器渲染调度。
      const rt0 = performance.now();
      await new Promise((resolve, reject) => {
        try { b.term.write(stdout, resolve); } catch (error) { reject(error); }
      });
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const renderMs = performance.now() - rt0;
      out.push({ ms, bytes: stdout.length, lines, ok: true, renderMs, runtime: res.runtime });
    }
    return out;
  })()`);
  const ms = summarizeSamples(runs.map((run) => run.ms));
  const render = summarizeSamples(runs.map((run) => run.renderMs));
  const last = runs.at(-1) ?? {};
  return {
    cmd,
    ms: ms.p50,
    p95: ms.p95,
    samples: ms.samples,
    bytes: last.bytes ?? 0,
    lines: last.lines ?? 0,
    ok: runs.every((run) => run.ok),
    renderMs: render.p50,
    renderP95: render.p95,
    renderSamples: render.samples,
    runtime: last.runtime,
  };
}

async function measureInteractiveKeyToFrame(cdp) {
  const samples = await evalValue(cdp, `(async () => {
    const terminal = window.__succinixBench.interactive;
    const samples = [];
    let buffered = '';
    let target = '';
    let notify = null;
    const unsubscribe = terminal.onOutput((data) => {
      buffered += data;
      if (notify && buffered.includes(target)) notify();
    });
    const waitForTarget = () => new Promise((resolve, reject) => {
      if (buffered.includes(target)) return resolve();
      const timer = setTimeout(() => reject(new Error('interactive output frame timed out')), 30_000);
      notify = () => { clearTimeout(timer); notify = null; resolve(); };
    });
    try {
      for (let index = 0; index < ${INTERACTIVE_SAMPLE_COUNT}; index++) {
        target = 'bench-key-' + Date.now().toString(36) + '-' + index;
        buffered = '';
        const started = performance.now();
        await terminal.sendData('printf ' + target + '\\r');
        await waitForTarget();
        samples.push(performance.now() - started);
      }
      return samples;
    } finally {
      unsubscribe();
    }
  })()`);
  return summarizeSamples(samples, false);
}

async function measureSessionAppend(cdp) {
  const samples = await evalValue(cdp, `(async () => {
    const store = window.__succinixBench.host.sessionPersistence;
    const id = 'bench-session-' + Date.now().toString(36);
    const segmentRoot = '/.succinix/sessions/segments';
    await store.create({ version: 0, id, createdAt: Date.now() });
    const samples = [];
    try {
      for (let seq = 0; seq < ${SESSION_APPEND_SAMPLE_COUNT}; seq++) {
        const started = performance.now();
        await store.append(id, [{ type: 'assistant/chunk', seq, time: Date.now(), data: { seq } }]);
        samples.push(performance.now() - started);
      }
      const last = await store.readFrom(id, ${SESSION_APPEND_SAMPLE_COUNT - 1});
      if (last.events.length !== 1 || last.events[0].seq !== ${SESSION_APPEND_SAMPLE_COUNT - 1}) {
        throw new Error('session append verification failed');
      }
      return samples;
    } finally {
      // session service keeps no browser-owned registry; deleting the temporary
      // manifest/segments before its debounced flush prevents benchmark residue.
      try {
        const entries = await window.__succinixBench.wc.fs.readdir(segmentRoot, { withFileTypes: true });
        const prefix = encodeURIComponent(id) + '.';
        for (const entry of entries) {
          if (String(entry.name).startsWith(prefix)) await window.__succinixBench.wc.fs.rm(segmentRoot + '/' + entry.name);
        }
      } catch {
        // A fresh benchmark preview is isolated; cleanup failure is non-fatal.
      }
    }
  })()`);
  return summarizeSamples(samples, false);
}

async function browserEnvironment(cdp) {
  let chrome;
  try {
    const version = await cdp.send('Browser.getVersion');
    chrome = { product: version.product ?? null, revision: version.revision ?? null, userAgent: version.userAgent ?? null };
  } catch (error) {
    chrome = { error: error instanceof Error ? error.message : String(error) };
  }
  return { node: process.version, platform: process.platform, arch: process.arch, chrome };
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

// ─── 主流程 ───
async function main() {
  note('Succinix performance benchmark (TASK18)');

  // 1) 构建
  if (SKIP_BUILD) {
    note('skipping build (--skip-build), using existing dist/');
  } else {
    note('building...');
    await run('npm', ['run', 'build']);
    note('build ok');
  }
  if (!existsSync(join(process.cwd(), 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run npm run build first');
  }

  // Each invocation uses unique ports and an isolated Chrome profile. A caller
  // may request a preview port, but it is still checked before Vite starts.
  const { previewPort, debugPort } = await allocateBrowserPorts(REQUESTED_PORT);
  const base = `http://127.0.0.1:${previewPort}`;
  note(`starting Vite preview on :${previewPort}; Chrome DevTools on :${debugPort}`);
  const preview = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(previewPort), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  let chromeRun = null;
  let cdp = null;
  let pageDiagnostics = null;
  let failure = null;
  try {
    await waitForHttp(base, 20000);
    note(`preview reachable at ${base}`);

    chromeRun = launchChrome(debugPort, `bench-${process.pid}`);
    cdp = await connectPageCDP(debugPort);
    await cdp.send('Log.enable');
    pageDiagnostics = attachPageDiagnostics(cdp);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SCRIPT });
    await cdp.send('Page.navigate', { url: `${base}/?bench=1` });

    note('waiting for boot + prompt...');
    await waitForBenchHook(cdp);

    const boot = await measureBoot(cdp);
    note(`boot: overlay=${boot.overlayRemoved}ms prompt=${boot.prompt}ms`);

    note(`measuring command round-trip (echo hi x${COMMAND_SAMPLE_COUNT}, node -e 1 x${COMMAND_SAMPLE_COUNT})...`);
    const commands = await measureCommands(cdp);
    note(`  lifo p50=${commands.lifo.p50}ms p95=${commands.lifo.p95}ms; node p50=${commands.node.p50}ms p95=${commands.node.p95}ms`);

    note('measuring snapshot N=200...');
    const snap200 = await measureSnapshot(cdp, 200, '/bench-200');
    note(`  create=${Math.round(snap200.createMs)}ms snapshot=${Math.round(snap200.snapshotMs)}ms`);

    note('measuring snapshot N=1000 (stress)...');
    const snap1000 = await measureSnapshot(cdp, 1000, '/bench-1000');
    note(`  create=${Math.round(snap1000.createMs)}ms snapshot=${Math.round(snap1000.snapshotMs)}ms`);

    note(`measuring xterm big output (seq 1 5000 x${XTERM_BIG_SAMPLE_COUNT})...`);
    const xtermBig = await measureXtermBig(cdp);
    note(`  cmd=${xtermBig.cmd} rtt=${Math.round(xtermBig.ms)}ms bytes=${xtermBig.bytes} lines=${xtermBig.lines} render=${Math.round(xtermBig.renderMs)}ms runtime=${xtermBig.runtime}`);

    note(`measuring interactive key-to-frame (${INTERACTIVE_SAMPLE_COUNT} samples)...`);
    const interactive = await measureInteractiveKeyToFrame(cdp);
    note(`  p50=${interactive.p50}ms p95=${interactive.p95}ms`);

    note(`measuring session append (${SESSION_APPEND_SAMPLE_COUNT} individual appends)...`);
    const sessionAppend = await measureSessionAppend(cdp);
    note(`  p50=${sessionAppend.p50}ms p95=${sessionAppend.p95}ms`);

    const result = {
      version: PKG_VERSION,
      timestamp: new Date().toISOString(),
      environment: await browserEnvironment(cdp),
      boot_ms: boot,
      cmd_lifo_ms: commands.lifo,
      cmd_node_ms: commands.node,
      snapshot200: snap200,
      snapshot1000: snap1000,
      xterm_big: xtermBig,
      interactive_key_to_frame_ms: interactive,
      session_append_ms: sessionAppend,
    };
    console.log(JSON.stringify(result, null, 2));
    note('bench complete');
  } catch (error) {
    failure = error;
    const diagnostics = await writeBrowserFailureDiagnostics({
      label: `bench-${process.pid}`,
      error,
      cdp,
      pageDiagnostics,
      chromeRun,
      previewPort,
      debugPort,
    });
    console.error(`[bench] failure diagnostics: ${diagnostics.reportPath}`);
    throw error;
  } finally {
    pageDiagnostics?.dispose();
    cdp?.close();
    const cleanup = await cleanupChrome(chromeRun?.chrome, chromeRun?.profileDir);
    if (!cleanup.exited || cleanup.descendantsAfter.length > 0 || !cleanup.profileRemoved) {
      console.error(`[bench] cleanup diagnostic: ${JSON.stringify(cleanup)}`);
    }
    await stopPreview(preview);
    if (failure) note('failure diagnostics were retained in the temporary directory above');
  }
}

main().catch((e) => {
  console.error(`[bench] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
