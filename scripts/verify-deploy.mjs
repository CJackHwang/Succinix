#!/usr/bin/env node
// 部署就绪门禁（TASK22）：无 Vercel token 时的本地等效验证。
// `vite preview` 与 Vercel 一样以静态方式托管 dist/ 产物 —— 头断言 + ?test=1 自检通过，
// 即"静态产物可部署"的最终证明（preview 与 Vercel 服务方式等价）。
//
// 流程：
//   1. 构建（--skip-build 跳过，前提是 dist/ 已是最新）
//   2. 解析 vercel.json 静态断言（COOP/COEP 头规则 /(.*) + buildCommand/outputDirectory）
//      —— 补 vite preview 头断言测的是 vite.config.ts 而非部署配置的缺口
//   3. 启动 `vite preview --port <port>`（COOP/COEP 头来自 vite.config.ts 的 preview.headers）
//   4. 断言响应头：Cross-Origin-Opener-Policy=same-origin / Cross-Origin-Embedder-Policy=credentialless
//   5. 启动 headless Chrome -> 打开 /?test=1 -> 捕获自检汇总行 -> 断言 >=71 passed 且 0 failed
//
// 用法：
//   node scripts/verify-deploy.mjs [--skip-build] [--port 7892]
//   （CI 中可直接作为部署就绪 job；无 headless Chrome 时 ?test=1 自检 fail-closed 报 FAIL，
//    不会静默降级 —— 与"部署就绪"门禁语义一致。）
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 7892;
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1; // Chrome DevTools 调试端口，避开 preview 端口
const MIN_PASSED = 71; // TASK25 门禁：preview 模式下 ?test=1 必须 >=71 passed（0 failed）
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let exitCode = 0;
function note(msg) {
  console.log(`[verify-deploy] ${msg}`);
}
function ok(msg) {
  console.log(`  [  OK  ] ${msg}`);
}
function fail(msg) {
  console.error(`  [ FAIL ] ${msg}`);
  exitCode = 1;
}
function check(cond, msg) {
  if (cond) ok(msg);
  else fail(msg);
}

// ─── 子进程工具 ───
function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: opts.silent ? 'ignore' : 'inherit', ...opts.spawn });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw lastErr ?? new Error(`timeout waiting for ${url}`);
}

// ─── 最小 CDP 客户端（无新依赖，Node 22 全局 WebSocket）───
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP websocket failed to open'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// 注入页面的观察脚本：把 ?test=1 自检汇总行与错误页状态记录到 window.__succinixResult / __succinixError。
// 自检输出全程走 xterm（canvas 渲染，DOM 不可读文本），结果由 main.ts 在 ?test=1 完成时写到
// window.__succinixResult；这里只观察错误页状态（boot-error-mode）并原地抓一次初始态。
const INJECT_SCRIPT = `(() => {
  if (window.__succinixResult !== undefined) return;
  window.__succinixResult = null;
  window.__succinixError = null;
  const grab = () => {
    if (window.__succinixResult) return;
    const ov = document.getElementById('boot-overlay');
    if (ov && ov.classList.contains('boot-error-mode')) {
      const head = document.getElementById('boot-error-head');
      const list = document.getElementById('boot-error-list');
      window.__succinixError = {
        head: head ? head.textContent : '',
        list: list ? list.textContent : '',
      };
    }
  };
  const obs = new MutationObserver(grab);
  const start = () => {
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    grab();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;

async function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

async function runHeadlessSelfTest() {
  const chromePath = await findChrome();
  if (!chromePath) {
    fail('headless Chrome not found — ?test=1 self-test must be run manually in a browser at ' + `${BASE}/?test=1`);
    return null;
  }
  const profileDir = mkdtempSync(join(tmpdir(), 'succinix-verify-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    // 等调试端口就绪
    let versionUrl = '';
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const v = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        if (v.ok) {
          versionUrl = (await v.json()).webSocketDebuggerUrl;
          break;
        }
      } catch {
        /* 尚未就绪 */
      }
      await sleep(300);
    }
    if (!versionUrl) {
      fail(`Chrome DevTools endpoint did not come up on :${DEBUG_PORT}`);
      return null;
    }
    // 找一个 page target（新开一个空白页，避免复用可能存在的旧页面）
    let pageUrl = '';
    for (let i = 0; i < 20 && !pageUrl; i++) {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      pageUrl = (list.find((t) => t.type === 'page') || {}).webSocketDebuggerUrl || '';
      if (!pageUrl) await sleep(200);
    }
    if (!pageUrl) {
      fail('no page target available via CDP');
      return null;
    }

    cdp = new CDP(pageUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SCRIPT });
    await cdp.send('Page.navigate', { url: `${BASE}/?test=1` });

    // 轮询自检结果；结果来自 main.ts 写入的 window.__succinixResult（终端 canvas 无法读文本）。
    const testStart = Date.now();
    const testDeadline = testStart + 300000; // 自检含网络边界等待，给足 5 分钟
    let lastHeartbeat = 0;
    while (Date.now() < testDeadline) {
      await sleep(500);
      const res = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ result: window.__succinixResult, error: window.__succinixError })',
        returnByValue: true,
      });
      let state = null;
      try {
        state = JSON.parse(res.result.value ?? 'null');
      } catch {
        /* 解析失败下一轮再试 */
      }
      if (state?.result) return state.result;
      if (state?.error) {
        fail(`page entered error state: ${state.error.head} — ${state.error.list.slice(0, 200)}`);
        return null;
      }
      // 打点：每 30s 输出一次 heartbeat（证明页面未挂死）
      const elapsed = Math.round((Date.now() - testStart) / 1000);
      if (elapsed >= 30 && elapsed % 30 === 0 && elapsed !== lastHeartbeat) {
        lastHeartbeat = elapsed;
        note(`  self-test still running (${elapsed}s elapsed)`);
      }
    }
    fail('self-test did not produce a summary within 300s (page hung)');
    return null;
  } finally {
    cdp?.close();
    chrome.kill('SIGTERM');
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
}

async function main() {
  note('TASK22 deploy-readiness gate: build -> vercel.json -> vite preview -> headers -> ?test=1');

  // 1) 构建
  if (SKIP_BUILD) {
    note('skipping build (--skip-build), using existing dist/');
  } else {
    note('step 1/5: npm run build');
    await run('npm', ['run', 'build']);
    ok('production build succeeded');
  }
  if (!existsSync(join(process.cwd(), 'dist', 'index.html'))) {
    fail('dist/index.html missing — run npm run build first');
    return;
  }

  // 2) vercel.json 静态断言：preview 的头来自 vite.config.ts，这里单独验证部署配置本身
  // （消除"门禁测 vite.config.ts 而非 vercel.json"的缺口 —— Vercel 实际读的是 vercel.json）。
  note('step 2/5: vercel.json static assertion');
  try {
    const vc = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'));
    const rule = (vc.headers ?? []).find((r) => r?.source === '/(.*)');
    const headerKeys = (rule?.headers ?? []).map((h) => [h?.key, h?.value]);
    const hasHeader = (k, v) => headerKeys.some(([kk, vv]) => kk === k && vv === v);
    check(!!rule, 'vercel.json headers contain /(.*) source rule');
    check(hasHeader('Cross-Origin-Opener-Policy', 'same-origin'), 'vercel.json COOP=same-origin');
    check(hasHeader('Cross-Origin-Embedder-Policy', 'credentialless'), 'vercel.json COEP=credentialless');
    check(vc.buildCommand === 'npm run build', `vercel.json buildCommand=${JSON.stringify(vc.buildCommand)}`);
    check(vc.outputDirectory === 'dist', `vercel.json outputDirectory=${JSON.stringify(vc.outputDirectory)}`);
  } catch (e) {
    fail(`vercel.json unreadable or invalid: ${e.message}`);
  }

  // 3) vite preview（COOP/COEP 头来自 vite.config.ts preview.headers，与 vercel.json 一致）
  note(`step 3/5: starting 'vite preview' on port ${PORT}...`);
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  try {
    await waitForHttp(BASE, 20000);
    ok(`vite preview reachable at ${BASE}`);

    // 4) 头断言：覆盖根路径与静态资源（assets/host.js），与 vercel.json 的 /(.*) 一致
    note('step 4/5: COOP/COEP header assertion');
    const entryJs = readdirSync(join(process.cwd(), 'dist', 'assets'))
      .find((f) => f.startsWith('index-') && f.endsWith('.js')) || 'index.js';
    for (const path of ['/', '/host.js', `/assets/${entryJs}`]) {
      const r = await fetch(BASE + path, { method: 'GET' });
      const coop = r.headers.get('cross-origin-opener-policy');
      const coep = r.headers.get('cross-origin-embedder-policy');
      check(r.ok && coop === 'same-origin' && coep === 'credentialless',
        `${path} -> COOP=${coop ?? '(missing)'} COEP=${coep ?? '(missing)'}`);
    }

    // 5) headless Chrome 自检（?test=1 >=71 passed）
    note('step 5/5: headless Chrome ?test=1 self-test');
    const result = await runHeadlessSelfTest();
    if (result) {
      check(result.passed >= MIN_PASSED && result.failed === 0,
        `?test=1 self-test: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped ` +
        `(gate: >=${MIN_PASSED} passed, 0 failed)`);
      if (result.failed > 0) {
        for (const f of result.fails) fail(`    ${f}`);
      }
    }
  } finally {
    preview.kill('SIGTERM');
  }

  note(exitCode === 0
    ? 'RESULT: PASSED — dist/ is deploy-ready (Vercel-equivalent verification)'
    : 'RESULT: FAILED — see failures above');
  process.exitCode = exitCode;
}

main().catch((e) => {
  console.error(`[verify-deploy] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
