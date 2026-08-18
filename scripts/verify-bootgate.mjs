#!/usr/bin/env node
// TASK-BOOTGATE 浏览器实测（非提交脚本，仅供质量门禁人工/CI 验证）：
//   1. boot 期间输入完全无效（连敲命令无回显无执行）
//   2. boot 日志每行带 N/M 步骤计数，逐步递增到 M/M
//   3. boot 完成提示符出现后可正常执行命令
// 复用 verify-deploy 的 CDP 最小客户端 + vite preview（COOP/COEP 头来自 vite.config.ts）。
// 用法：node scripts/verify-bootgate.mjs [--port 7893] [--skip-build]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome, launchChrome, cleanupChrome } from './lib/chrome.mjs';
import { connectPageCDP } from './lib/cdp.mjs';
import { run, sleep } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const pIdx = args.indexOf('--port');
const PORT = pIdx >= 0 ? Number(args[pIdx + 1]) : 7893;
const DEBUG_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function ok(msg) { console.log(`  [  OK  ] ${msg}`); }
function fail(msg) { failures++; console.error(`  [ FAIL ] ${msg}`); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }
function note(msg) { console.log(`[bootgate] ${msg}`); }

// 读 xterm 终端缓冲区全文（bench 模式暴露 window.__succinixBench.term）。
// 返回 JSON 字符串（避免 Runtime.evaluate 对象被 String() 打回 [object Object]）。
const READ_TERM = `
  (() => {
    const b = window.__succinixBench && window.__succinixBench.term;
    if (!b || !b.buffer || !b.buffer.active) return JSON.stringify({ ok: false, text: '' });
    const buf = b.buffer.active;
    const lines = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (line) lines.push(line.translateToString(true));
    }
    return JSON.stringify({ ok: true, text: lines.join('\\n') });
  })()
`;

// bench 模式的时间戳 shim（bench.mjs 的 CDP 注入脚本；页面本身不创建 __bootTimes）。
// 注入后再导航，main.ts 的 benchMarkPrompt/bootPhase 才会记录 prompt/phases 打点。
const BOOTTIMES_SHIM = `
  window.__bootTimes = { start: performance.now(), overlayRemoved: null, prompt: null, phases: {} };
  if (!document.getElementById('boot-overlay') && window.__bootTimes.overlayRemoved === null) {
    window.__bootTimes.overlayRemoved = performance.now();
  }
`;

async function readTerm(cdp) {
  const res = await cdp.send('Runtime.evaluate', { expression: READ_TERM, returnByValue: true });
  try {
    return JSON.parse(res.result.value ?? '{"ok":false,"text":""}');
  } catch {
    return { ok: false, text: '' };
  }
}

async function main() {
  note(`TASK-BOOTGATE browser gate (normal boot, no self-test)`);

  if (!SKIP_BUILD) {
    note('npm run build');
    await run('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  }
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    fail('dist/index.html missing — run npm run build first');
    return;
  }

  note(`starting 'vite preview' on port ${PORT}...`);
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  try {
    // 等 preview 就绪
    let httpOk = false;
    const hd = Date.now() + 20000;
    while (Date.now() < hd) {
      try {
        const r = await fetch(BASE);
        if (r.ok) { httpOk = true; break; }
      } catch { /* 未就绪 */ }
      await sleep(300);
    }
    if (!httpOk) { fail(`vite preview not reachable at ${BASE}`); return; }
    ok('vite preview reachable');

    // COOP/COEP 头（WebContainer 必需）
    const r = await fetch(BASE);
    check(r.headers.get('cross-origin-opener-policy') === 'same-origin' &&
          r.headers.get('cross-origin-embedder-policy') === 'credentialless',
          `COOP/COEP headers on /`);

    const chromePath = findChrome();
    if (!chromePath) { fail('headless Chrome not found'); return; }
    const { chrome, profileDir } = launchChrome(DEBUG_PORT, 'bootgate');

    let cdp = null;
    try {
      cdp = await connectPageCDP(DEBUG_PORT);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOTTIMES_SHIM });
      await cdp.send('Page.navigate', { url: `${BASE}/?bench=1` });

      // 等 xterm 挂载 + onData 绑定（main.ts 模块顶层同步执行）。boot 进行中。
      let taFound = false;
      const td = Date.now() + 15000;
      while (Date.now() < td) {
        const res = await cdp.send('Runtime.evaluate', {
          expression: `!!document.querySelector('textarea.xterm-helper-textarea')`,
          returnByValue: true,
        });
        if (res.result.value === true) { taFound = true; break; }
        await sleep(100);
      }
      if (!taFound) { fail('xterm textarea never appeared'); return; }

      // 聚焦终端，然后在 boot 期间连敲命令（应被 R1 门禁静默忽略：无回显、无执行）。
      await cdp.send('Runtime.evaluate', {
        expression: `(() => { const ta = document.querySelector('textarea.xterm-helper-textarea'); ta && ta.focus(); return true; })()`,
        returnByValue: true,
      });
      // 页面加载后立即、并在随后 ~3s 内连续注入 —— 覆盖 WebContainer.boot + host 拉起窗口。
      const inputStart = Date.now();
      while (Date.now() - inputStart < 3000) {
        await cdp.send('Input.insertText', { text: 'zzz-bootgate' });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(200);
      }
      note('injected input during boot window (~3s of zzz-bootgate + Enter)');

      // 等 boot 完成：提示符出现（bench 打点 __bootTimes.prompt 非空）。
      const pd = Date.now() + 90000;
      let promptShown = false;
      while (Date.now() < pd) {
        const res = await cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify(window.__bootTimes && window.__bootTimes.prompt !== null)`,
          returnByValue: true,
        });
        if (String(res.result.value) === 'true') { promptShown = true; break; }
        await sleep(300);
      }
      check(promptShown, 'boot completed, prompt appeared (__bootTimes.prompt set)');
      if (!promptShown) {
        const snap = await readTerm(cdp);
        note('buffer tail:\n' + String(snap.text).slice(0, 1500));
        return;
      }

      await sleep(1500); // 等 motd/提示符完全落盘到缓冲区

      // ─── 断言 1：boot 期间输入被静默忽略（buffer 无 zzz-bootgate 回显/执行）───
      const snap = await readTerm(cdp);
      const bufferText = snap.text;
      check(!bufferText.includes('zzz-bootgate'),
        'boot-window keystrokes produced no echo/execution in terminal buffer');

      // ─── 断言 2：boot 日志每行带 N/M 步骤计数，递增到 M/M ───
      // 按缓冲区原始顺序抽取带计数的 ok/note 行（不分离 ok 与 note，避免破坏时序）。
      const stepLines = bufferText.split('\n').filter((l) => /\[(?: {2}OK {2}| \.\.\.\. )\] \d+\/\d+ /.test(l));
      check(stepLines.length >= 6, `boot step-counted lines present (${stepLines.length} total ok+note)`);

      const counts = stepLines.map((l) => {
        const m = l.match(/(\d+)\/(\d+) /);
        return m ? [Number(m[1]), Number(m[2])] : null;
      }).filter(Boolean);
      const monotonic = counts.every(([n], i) => i === 0 || n === counts[i - 1][0] + 1);
      check(monotonic, `step counts strictly increment (${counts.map(([n]) => n).join(',')})`);

      const last = counts[counts.length - 1];
      check(!!last && last[0] === last[1], `last counted step is M/M (${last ? last.join('/') : '?'})`);
      if (last) {
        const lastLine = stepLines[stepLines.length - 1];
        const isReady = lastLine.includes('TerminalExecutor ready') || lastLine.includes("(autostart)");
        check(isReady, `last counted line is TerminalExecutor ready or autostart service: "${lastLine.trim().slice(0, 70)}"`);
      }

      // 示例输出
      const sample = stepLines.slice(0, 3).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim());
      note('boot step lines sample:\n' + sample.map((l) => '    ' + l).join('\n'));

      // ─── 断言 3：boot 完成后输入正常执行 ───
      await cdp.send('Runtime.evaluate', {
        expression: `(() => { const ta = document.querySelector('textarea.xterm-helper-textarea'); ta && ta.focus(); return true; })()`,
        returnByValue: true,
      });
      await cdp.send('Input.insertText', { text: 'echo bootgate-after-boot' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(3500); // 等 host 命令往返

      const snap2 = await readTerm(cdp);
      const buffer2 = snap2.text;
      check(buffer2.includes('bootgate-after-boot'), 'post-boot command echoed + executed (echo bootgate-after-boot)');

      note(failures === 0 ? 'RESULT: PASSED — boot gate + N/M progress + post-boot input all good'
                          : `RESULT: FAILED — ${failures} check(s) failed`);
      process.exitCode = failures === 0 ? 0 : 1;
    } finally {
      cdp?.close();
      await cleanupChrome(chrome, profileDir);
    }
  } finally {
    preview.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(`[bootgate] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
