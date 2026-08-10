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
import { launchChrome, cleanupChrome } from './lib/chrome.mjs';
import { connectPageCDP, evalValue } from './lib/cdp.mjs';
import { run, waitForHttp, sleep } from './lib/harness.mjs';

const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 7894;
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1; // Chrome DevTools 调试端口

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
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return Math.round(sorted[idx] * 100) / 100;
}

// 等页面暴露 __succinixBench（boot 完成 + 提示符出现）。
async function waitForBenchHook(cdp, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await evalValue(cdp, `JSON.stringify({ hook: !!window.__succinixBench, prompt: window.__bootTimes && window.__bootTimes.prompt })`);
      const st = JSON.parse(v);
      if (st.hook && st.prompt !== null) return;
      lastErr = new Error(`hook not ready: ${v}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(400);
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
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await b.client.terminal('echo hi');
      out.lifo.push(performance.now() - t0);
    }
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await b.client.terminal('node -e 1');
      out.node.push(performance.now() - t0);
    }
    return out;
  })()`);
  const summarize = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), samples: sorted.map((x) => Math.round(x * 100) / 100) };
  };
  return { lifo: summarize(res.lifo), node: summarize(res.node) };
}

// 构造 N 文件目录 → saveSnapshot(force) 计时。创建与快照分开计时，便于定位成本。
async function measureSnapshot(cdp, n, dir) {
  return evalValue(cdp, `(async () => {
    const b = window.__succinixBench;
    const fs = b.wc.fs;
    let createMs = 0, snapshotMs = 0, files = 0;
    try {
      const t0 = performance.now();
      await fs.mkdir('${dir}', { recursive: true });
      for (let i = 0; i < ${n}; i++) {
        await fs.writeFile('${dir}/f' + i + '.txt', 'bench content ' + i + ' padding padding padding\\n');
      }
      createMs = performance.now() - t0;
      files = ${n};
      const s0 = performance.now();
      const r = await b.saveSnapshot(fs, true);
      snapshotMs = performance.now() - s0;
      return { createMs, snapshotMs, fileCount: r.meta.fileCount, skipped: r.skipped };
    } catch (e) {
      return { createMs, snapshotMs, error: String(e).slice(0, 200) };
    }
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
  return evalValue(cdp, `(async () => {
    const b = window.__succinixBench;
    const t0 = performance.now();
    const res = await b.client.terminal(${JSON.stringify(cmd)});
    const ms = performance.now() - t0;
    const stdout = String(res.stdout ?? '');
    const lines = stdout.trim() ? stdout.split('\\n').length : 0;
    // 渲染侧：把 stdout 推给 xterm，计时其同步开销（排除 RPC）。
    let renderMs = 0;
    try {
      const rt0 = performance.now();
      b.term.write(stdout);
      renderMs = performance.now() - rt0;
    } catch (e) { renderMs = -1; }
    return { cmd: ${JSON.stringify(cmd)}, ms, bytes: stdout.length, lines, ok: res.ok, renderMs, runtime: res.runtime };
  })()`);
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

  // 2) vite preview
  note(`starting vite preview on :${PORT}...`);
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  let chrome = null;
  let cdp = null;
  try {
    await waitForHttp(BASE, 20000);
    note(`preview reachable at ${BASE}`);

    chrome = launchChrome(DEBUG_PORT, 'bench');
    cdp = await connectPageCDP(DEBUG_PORT);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SCRIPT });
    await cdp.send('Page.navigate', { url: `${BASE}/?bench=1` });

    note('waiting for boot + prompt...');
    await waitForBenchHook(cdp);

    const boot = await measureBoot(cdp);
    note(`boot: overlay=${boot.overlayRemoved}ms prompt=${boot.prompt}ms`);

    note('measuring command round-trip (echo hi x10, node -e 1 x10)...');
    const commands = await measureCommands(cdp);
    note(`  lifo p50=${commands.lifo.p50}ms p95=${commands.lifo.p95}ms; node p50=${commands.node.p50}ms p95=${commands.node.p95}ms`);

    note('measuring snapshot N=200...');
    const snap200 = await measureSnapshot(cdp, 200, '/bench-200');
    note(`  create=${Math.round(snap200.createMs)}ms snapshot=${Math.round(snap200.snapshotMs)}ms${snap200.error ? ' error=' + snap200.error : ''}`);
    if (snap200.error) warn(`snapshot N=200 failed: ${snap200.error}`);

    note('measuring snapshot N=1000 (stress)...');
    const snap1000 = await measureSnapshot(cdp, 1000, '/bench-1000');
    note(`  create=${Math.round(snap1000.createMs)}ms snapshot=${Math.round(snap1000.snapshotMs)}ms${snap1000.error ? ' error=' + snap1000.error : ''}`);
    if (snap1000.error) warn(`snapshot N=1000 failed: ${snap1000.error}`);

    note('measuring xterm big output (seq 1 5000)...');
    const xtermBig = await measureXtermBig(cdp);
    note(`  cmd=${xtermBig.cmd} rtt=${Math.round(xtermBig.ms)}ms bytes=${xtermBig.bytes} lines=${xtermBig.lines} render=${Math.round(xtermBig.renderMs)}ms runtime=${xtermBig.runtime}`);

    const result = {
      version: PKG_VERSION,
      timestamp: new Date().toISOString(),
      platform: process.platform,
      boot_ms: boot,
      cmd_lifo_ms: commands.lifo,
      cmd_node_ms: commands.node,
      snapshot200: snap200,
      snapshot1000: snap1000,
      xterm_big: xtermBig,
    };
    console.log(JSON.stringify(result, null, 2));
    note('bench complete');
  } finally {
    cdp?.close();
    cleanupChrome(chrome?.chrome, chrome?.profileDir);
    preview.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(`[bench] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
