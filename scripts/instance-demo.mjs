#!/usr/bin/env node
// M5 阶段验证点 1 —— 双 tab 实例 demo 实测（?instance=c-1 / ?instance=c-2）。
// 零新依赖（复用 verify-deploy/scenarios 的 CDP 模式）：vite preview + headless Chrome
// 双 tab，各自独立 WebContainer。
//
// 断言：双 tab 独立 boot / 状态根按实例（.succinix-<id>）/ env 状态独立 / 快照按实例键
// （双 tab 共享同一 origin 的 IndexedDB，快照键 instance:<id> 必须互不串扰）/
// service start 只影响自己 / reboot 只重置自己（另一 tab 不受影响）。
//
// 盲区如实标注（MASTER-PLAN M3）：双 tab 各自独立 host —— host 侧按实例路由
// （ps 过滤 / kill 越权）不在此覆盖，以 M3 协议级单测为证：
// 跨容器已 e2e、同页路由仅单测。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
// 注意：7897 常被本机代理（mihomo/clash 混合端口）占用，故用 7893/7902。
const PORT = 7893;
const DEBUG_PORT = 7902;
// vite preview 默认只监听 IPv6 localhost（::1）—— 探测/导航必须用 localhost，不能用 127.0.0.1。
const BASE = `http://localhost:${PORT}`;
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
  console.log(`[instance-demo] ${msg}`);
}

function check(checks, name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '[  OK  ]' : '[ FAIL ]'} ${name}${detail ? ` (${detail.slice(0, 200)})` : ''}`);
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd: opts.cwd, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(' ')} exited ${code}`))));
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`http wait timeout: ${url}`);
}

// ─── 最小 CDP 客户端（同 scenarios.mjs，无新依赖）───
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

async function evalValue(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown';
    throw new Error(`page eval failed: ${desc.slice(0, 300)}`);
  }
  return res.result.value;
}

// 页面句柄：?instance=<id>&scenario=1 的 tab。
function makeTab(cdp, id) {
  const t = {
    id,
    cdp,
    async eval(expression) {
      return evalValue(cdp, expression);
    },
    async run(cmd, timeoutMs) {
      const expr = `(async () => JSON.stringify(await window.__succinixScenario.run(${JSON.stringify(cmd)}, ${timeoutMs ?? 'undefined'})))()`;
      return JSON.parse(await evalValue(cdp, expr));
    },
    async waitForScenario(timeoutMs = 180000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const v = await evalValue(cdp, '!!window.__succinixScenario && window.__succinixScenario.booted === true');
          if (v) return;
        } catch {
          /* 导航期间上下文销毁：下一轮再试 */
        }
        await sleep(400);
      }
      throw new Error(`tab ${id}: scenario handle did not become ready within ${timeoutMs}ms`);
    },
    async reloadAndWait(timeoutMs = 180000) {
      try {
        await cdp.send('Page.reload', { ignoreCache: true });
      } catch {
        /* 导航中 */
      }
      // 先等旧页面销毁（导航开始、句柄消失），再等新 boot 完成 —— 直接轮询句柄会
      // 命中导航前残留的旧句柄而提前返回（页面随后进入 ~8s boot，句柄再次缺失）。
      const goneDeadline = Date.now() + 30000;
      while (Date.now() < goneDeadline) {
        try {
          const v = await evalValue(cdp, '!window.__succinixScenario');
          if (v === true) break;
        } catch {
          /* 导航中上下文销毁：视为已消失 */
          break;
        }
        await sleep(200);
      }
      await t.waitForScenario(timeoutMs);
    },
  };
  return t;
}

async function main() {
  note(`dual-tab instance demo (ports ${PORT}/${DEBUG_PORT})`);
  if (!SKIP_BUILD) {
    note('production build...');
    await run('npm', ['run', 'build']);
  }
  note('starting vite preview...');
  // 直接用仓库内 vite 二进制（不经 npx，避免 registry 探测）。
  const preview = spawn(process.execPath, [join(import.meta.dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  const cleanup = () => {
    try {
      preview.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);
  try {
    await waitForHttp(BASE, 30000);

    const chromePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
    if (!chromePath) throw new Error('headless Chrome not found');
    const profileDir = mkdtempSync(join(tmpdir(), 'succinix-instance-demo-'));
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

    const cleanupChrome = () => {
      try {
        chrome.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };
    process.on('exit', cleanupChrome);

    // 浏览器级 CDP：建两个 tab（各自独立容器 / 独立页面上下文）。
    let browserWs = '';
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !browserWs) {
      try {
        const v = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        if (v.ok) browserWs = (await v.json()).webSocketDebuggerUrl;
      } catch {
        /* not up */
      }
      if (!browserWs) await sleep(300);
    }
    if (!browserWs) throw new Error(`Chrome DevTools endpoint did not come up on :${DEBUG_PORT}`);

    const browserCdp = new CDP(browserWs);
    await browserCdp.open();
    const urls = {
      'c-1': `${BASE}/?instance=c-1&scenario=1`,
      'c-2': `${BASE}/?instance=c-2&scenario=1`,
    };
    const targetIds = {};
    for (const id of Object.keys(urls)) {
      const t = await browserCdp.send('Target.createTarget', { url: urls[id] });
      targetIds[id] = t.targetId;
    }

    // 每个 tab 一个页面级 CDP 连接。
    const tabs = {};
    for (const id of Object.keys(urls)) {
      let wsUrl = '';
      for (let i = 0; i < 30 && !wsUrl; i++) {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        const target = list.find((x) => x.type === 'page' && x.id === targetIds[id]);
        if (target?.webSocketDebuggerUrl) wsUrl = target.webSocketDebuggerUrl;
        if (!wsUrl) await sleep(200);
      }
      if (!wsUrl) throw new Error(`tab ${id}: CDP target not found`);
      const cdp = new CDP(wsUrl);
      await cdp.open();
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      tabs[id] = makeTab(cdp, id);
    }

    const checks = [];
    const A = tabs['c-1'];
    const B = tabs['c-2'];

    // C1：双 tab 各自完整 boot（实例 demo 路径），句柄就绪。
    await A.waitForScenario();
    await B.waitForScenario();
    check(checks, 'dual-tab ?instance= demo boots independently (c-1 + c-2)', true);

    // C2：状态根按实例 —— 各自 motd 落在 /workspace/.succinix-<id>/etc。
    const aMotd = await A.eval(`window.__succinixScenario.wc.fs.readFile('/workspace/.succinix-c-1/etc/succinix.motd').then(() => true).catch(() => false)`);
    const bMotd = await B.eval(`window.__succinixScenario.wc.fs.readFile('/workspace/.succinix-c-2/etc/succinix.motd').then(() => true).catch(() => false)`);
    check(checks, 'per-instance state roots (c-1 + c-2 motd present)', aMotd === true && bMotd === true);

    // C3：env 状态独立 —— A 设置 C1_MARK，B 不可见。
    const aEnvSet = await A.run('env C1_MARK=from-c1');
    await B.run('env C2_MARK=from-c2');
    const aEnvList = await A.run('env');
    const bEnvList = await B.run('env');
    check(checks, 'env set in c-1 persists to instance env file', aEnvSet.ok === true, String(aEnvSet.stdout ?? ''));
    check(checks, 'env isolated per instance (C1_MARK in c-1 only, C2_MARK in c-2 only)', String(aEnvList.output).includes('C1_MARK') && !String(aEnvList.output).includes('C2_MARK') && String(bEnvList.output).includes('C2_MARK') && !String(bEnvList.output).includes('C1_MARK'));

    // C4：快照按实例键（双 tab 共享 origin IndexedDB —— instance:c-1 / instance:c-2 必须互不串扰）。
    // 注意：node 子进程的容器根没有 /workspace（浏览器 wc.fs `/` == process.cwd()，
    // 浏览器 `/workspace/x` == cwd/workspace/x）—— 标记文件必须经浏览器 wc.fs 写
    // 浏览器视角绝对路径（/workspace 跨刷新不变），快照恢复才可断言。
    await A.eval(`window.__succinixScenario.wc.fs.writeFile('/workspace/c1-marker.txt','c1').then(() => true).catch(() => false)`);
    await B.eval(`window.__succinixScenario.wc.fs.writeFile('/workspace/c2-marker.txt','c2').then(() => true).catch(() => false)`);
    const aSnap = await A.eval('window.__succinixScenario.saveSnapshot(true).then(() => true).catch(() => false)');
    const bSnap = await B.eval('window.__succinixScenario.saveSnapshot(true).then(() => true).catch(() => false)');
    check(checks, 'per-instance snapshots saved (both tabs, shared origin IndexedDB)', aSnap === true && bSnap === true);
    await A.reloadAndWait();
    await B.reloadAndWait();
    const aHasC1 = await A.eval('window.__succinixScenario.wc.fs.readFile(\'/workspace/c1-marker.txt\').then(() => true).catch(() => false)');
    const aHasC2 = await A.eval('window.__succinixScenario.wc.fs.readFile(\'/workspace/c2-marker.txt\').then(() => true).catch(() => false)');
    const bHasC1 = await B.eval('window.__succinixScenario.wc.fs.readFile(\'/workspace/c1-marker.txt\').then(() => true).catch(() => false)');
    const bHasC2 = await B.eval('window.__succinixScenario.wc.fs.readFile(\'/workspace/c2-marker.txt\').then(() => true).catch(() => false)');
    check(checks, 'snapshot isolation after refresh (c-1 restores only own marker)', aHasC1 === true && aHasC2 === false);
    check(checks, 'snapshot isolation after refresh (c-2 restores only own marker)', bHasC1 === false && bHasC2 === true);

    // C5：service start 只影响自己实例。
    await A.run('service start tinbase', 120000);
    const bSvc = await B.run('service status tinbase');
    // tinbase WASM 引擎首启较慢（~30-60s），端口可能晚于命令内部 30s 等待就绪 ——
    // 轮询 status 直到 running（上限 90s），把"进程已起、端口稍后就绪"如实判为成功。
    let aRunning = false;
    let aStatusOut = '';
    for (let i = 0; i < 45 && !aRunning; i++) {
      const st = await A.run('service status tinbase', 30000);
      aStatusOut = String(st.output ?? '');
      if (aStatusOut.includes('running')) {
        aRunning = true;
        break;
      }
      await sleep(2000);
    }
    const aPorts = await A.eval('window.__succinixScenario.ports.has(3001)');
    const bPorts = await B.eval('window.__succinixScenario.ports.has(3001)');
    const bSvcOut = String(bSvc.output ?? '');
    check(checks, 'service start in c-1 leaves tinbase running (own instance)', aRunning, aStatusOut.slice(0, 80));
    check(checks, 'service status in c-2 stays stopped', bSvcOut.includes('stopped'), bSvcOut.slice(0, 80));
    check(checks, 'port 3001 registered in c-1 view only', aPorts === true && bPorts === false);

    // C5b：db start 实例模式 —— 停掉 service 后走 db 命令的 --data-dir 路径（M4 数据隔离 +
    // M5 mapDataDirArgs 浏览器视角映射），数据目录必须落在实例状态根下。
    await A.run('service stop tinbase', 30000);
    const aDb = await A.run('db start', 120000);
    const aDbOut = String(aDb.output ?? '');
    let aDbPort = false;
    for (let i = 0; i < 45 && !aDbPort; i++) {
      aDbPort = (await A.eval('window.__succinixScenario.ports.has(3001)')) === true;
      if (aDbPort) break;
      await sleep(2000);
    }
    const aDbDir = await A.eval(`window.__succinixScenario.wc.fs.readdir('/workspace/.succinix-c-1/tinbase').then((x) => x.length > 0).catch(() => false)`);
    check(checks, 'db start in c-1 (instance mode) brings port up', aDbPort, aDbOut.slice(0, 100));
    check(checks, 'db data dir created under instance state root', aDbDir === true);

    // C6/C7：reboot 只重置自己 —— A reboot 后会话重建（状态根清空），B 全程不受影响。
    await A.run('reboot');
    await sleep(3000);
    const aAlive = await A.eval('!!window.__succinixScenario && window.__succinixScenario.booted === true');
    const bEcho = await B.run('echo b-alive');
    const aEnvAfter = await A.run('env');
    const bEnvAfter = await B.run('env');
    check(checks, 'reboot in c-1 rebuilds instance in place (page not reloaded)', aAlive === true);
    check(checks, 'c-2 unaffected by c-1 reboot (still responsive)', bEcho.ok === true && String(bEcho.output).includes('b-alive'));
    check(checks, 'c-1 state root cleared by reboot (env reset)', !String(aEnvAfter.output).includes('C1_MARK'));
    check(checks, 'c-2 env untouched by c-1 reboot', String(bEnvAfter.output).includes('C2_MARK') && !String(bEnvAfter.output).includes('C1_MARK'));

    browserCdp.close();
    for (const id of Object.keys(tabs)) tabs[id].cdp.close();
    cleanupChrome();

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n=== INSTANCE DEMO SUMMARY ===`);
    for (const c of checks) console.log(`  ${c.ok ? '[  OK  ]' : '[ FAIL ]'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`);
    console.log(`instance-demo: ${checks.length - failed.length}/${checks.length} checks passed, ${failed.length} failed`);
    if (failed.length > 0) exitCode = 1;
  } catch (e) {
    note(`FATAL: ${e.stack ?? e}`);
    exitCode = 1;
  } finally {
    cleanup();
  }
  note(exitCode === 0 ? 'RESULT: PASSED' : 'RESULT: FAILED');
  process.exitCode = exitCode;
}

main().catch((e) => {
  console.error(`[instance-demo] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
