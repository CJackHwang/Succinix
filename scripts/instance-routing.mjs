#!/usr/bin/env node
// 同页多实例宿主行为 e2e（R5）：单 tab（一个 WebContainer / 一个共享 host）内，
// 用第二个 TerminalClient 以 instanceId=c-2 驱动同一 host —— 覆盖双 tab demo 的盲区：
//   ps 按实例过滤 / kill 越权拒绝 / reset-instance（reboot host 侧）只重置自己 /
//   同页快照按实例键隔离 / 端口事件按实例期望归属实例视图。
// 不新增运行时依赖；页面通过 ?instance=c-1&scenario=1 暴露 dev hook，
// 第二实例客户端经 client.constructor 在页内构造（共享 wc → 共享 RPC 通道 + 单 host）。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { launchChrome, cleanupChrome } from './lib/chrome.mjs';
import { connectPageCDP } from './lib/cdp.mjs';
import { run, waitForHttp, sleep, makeHarness } from './lib/harness.mjs';

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const PORT = 7894;
const DEBUG_PORT = 7903;
const BASE = `http://localhost:${PORT}`;

function note(msg) {
  console.log(`[instance-routing] ${msg}`);
}

function check(checks, name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '[  OK  ]' : '[ FAIL ]'} ${name}${detail ? ` (${detail.slice(0, 200)})` : ''}`);
}

// 页内第二个实例客户端（instanceId=c-2，与页面 c-1 共享 wc → 共享 RPC 通道 + 单 host）。
const C2 = 'window.__c2client';
const CLIENT_A = 'window.__succinixScenario.client';

async function initC2(h) {
  return h.evalValue(
    `(() => { if (!window.__c2client) window.__c2client = new (window.__succinixScenario.client.constructor)(window.__succinixScenario.wc, { instanceId: 'c-2' }); return !!window.__c2client; })()`
  );
}

async function psOf(h, clientExpr) {
  const raw = await h.evalValue(`(async () => JSON.stringify(await (${clientExpr}).terminal('ps', undefined, 10000)))()`);
  return JSON.parse(raw);
}

async function spawnOf(h, clientExpr, cmd) {
  const raw = await h.evalValue(
    `(async () => JSON.stringify(await (${clientExpr}).spawn(${JSON.stringify(cmd)}, undefined, 10000)))()`
  );
  return JSON.parse(raw);
}

async function killOf(h, clientExpr, pid) {
  const raw = await h.evalValue(
    `(async () => JSON.stringify(await (${clientExpr}).terminal(${JSON.stringify(`kill ${pid}`)}, undefined, 10000)))()`
  );
  return JSON.parse(raw);
}

async function resetOf(h, clientExpr) {
  const raw = await h.evalValue(`(async () => JSON.stringify(await (${clientExpr}).resetInstance(20000)))()`);
  return JSON.parse(raw);
}

async function waitProcStatus(h, clientExpr, pid, wantExited, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await psOf(h, clientExpr);
    const p = (r.processes ?? []).find((x) => x.pid === pid);
    if (!p) return 'gone';
    if (wantExited && p.status === 'exited') return 'exited';
    if (!wantExited && p.status === 'running') return 'running';
    await sleep(300);
  }
  return 'timeout';
}

async function main() {
  note(`same-page instance routing (port ${PORT}, debug ${DEBUG_PORT})`);
  if (!SKIP_BUILD) {
    note('production build...');
    await run('npm', ['run', 'build'], { silent: true });
  }
  note('starting vite preview...');
  const preview = spawn(process.execPath, [join(import.meta.dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  let chrome = null;
  let profileDir = null;
  let cdp = null;
  try {
    await waitForHttp(BASE, 30000);
    const launched = launchChrome(DEBUG_PORT, 'instance-routing');
    chrome = launched.chrome;
    profileDir = launched.profileDir;
    cdp = await connectPageCDP(DEBUG_PORT);
    await cdp.send('Page.navigate', { url: `${BASE}/?instance=c-1&scenario=1` });
    note('waiting for boot + scenario handle...');
    const h = makeHarness(cdp);
    await h.waitForScenario(120000);
    note('scenario handle ready');

    const checks = [];

    // R5-0：页内构造第二实例客户端（共享 host / 共享 RPC 通道）。
    const c2Ready = await initC2(h);
    check(checks, 'second instance client constructed on same page', c2Ready === true);
    const pingC2 = await psOf(h, C2);
    check(checks, 'c-2 client reaches the shared host (ps ok)', pingC2.ok === true, `ok=${pingC2.ok}`);

    // R5-1：ps 按实例过滤 —— c-1 的进程不出现在 c-2 视图，反之亦然。
    const p1 = await spawnOf(h, CLIENT_A, 'node -e "setInterval(()=>{},1000)"');
    check(checks, 'c-1 spawn returns pid', p1.ok === true && Number.isInteger(p1.pid), `pid=${p1.pid}`);
    const p2 = await spawnOf(h, C2, 'node -e "setInterval(()=>{},1000)"');
    check(checks, 'c-2 spawn returns pid', p2.ok === true && Number.isInteger(p2.pid), `pid=${p2.pid}`);
    const psA1 = await psOf(h, CLIENT_A);
    const psC1 = await psOf(h, C2);
    const p1InA = psA1.processes?.some((p) => p.pid === p1.pid && p.containerId === '.succinix-c-1');
    const p2InA = psA1.processes?.some((p) => p.pid === p2.pid);
    const p1InC = psC1.processes?.some((p) => p.pid === p1.pid);
    const p2InC = psC1.processes?.some((p) => p.pid === p2.pid && p.containerId === '.succinix-c-2');
    check(checks, 'ps: c-1 view shows own process attributed', p1InA === true, `pid=${p1.pid}`);
    check(checks, 'ps: c-2 view hides c-1 process', p1InC !== true, `pid=${p1.pid}`);
    check(checks, 'ps: c-2 view shows own process attributed', p2InC === true, `pid=${p2.pid}`);
    check(checks, 'ps: c-1 view hides c-2 process', p2InA !== true, `pid=${p2.pid}`);

    // R5-2：kill 越权拒绝 —— c-2 不能 kill c-1 的进程；c-1 可以。
    const killDenied = await killOf(h, C2, p1.pid);
    check(
      checks,
      'kill: cross-instance kill denied (permission denied)',
      killDenied.ok === false && String(killDenied.message ?? '').includes('permission denied') && String(killDenied.message ?? '').includes(`not owned by instance 'c-2'`),
      String(killDenied.message ?? '').slice(0, 120)
    );
    check(checks, 'kill: c-1 process still running after denied kill', (await waitProcStatus(h, CLIENT_A, p1.pid, false)) === 'running');
    const killOwn = await killOf(h, CLIENT_A, p1.pid);
    check(checks, 'kill: c-1 can kill own process', killOwn.ok === true && killOwn.killed === true, `killed=${killOwn.killed}`);
    check(checks, 'kill: c-1 process gone after own kill', (await waitProcStatus(h, CLIENT_A, p1.pid, true)) !== 'timeout');

    // R5-3：端口事件按实例期望归属视图 —— c-2 裸 spawn 的端口不进 c-1 视图；
    // c-1 自己的 service start 端口进入 c-1 视图。
    const srv = await spawnOf(h, C2, `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(3211)"`);
    check(checks, 'c-2 spawns http server on 3211', srv.ok === true && Number.isInteger(srv.pid), `pid=${srv.pid}`);
    await sleep(4000);
    const portUnowned = await h.evalValue('window.__succinixScenario.ports.has(3211)');
    check(checks, 'port 3211 (c-2 spawn) not in c-1 instance view', portUnowned === false, `inView=${portUnowned}`);
    const svcUnit = "[Unit]\nDescription=instance routing server\n\n[Service]\nExecStart=node -e require('http').createServer((q,s)=>s.end('ok')).listen(3212)\nType=simple\nWorkingDirectory=/workspace\n\n[Install]\nWantedBy=multi-user.target\n";
    await h.evalValue(`(async () => { const fs = window.__succinixScenario.wc.fs; await fs.mkdir('/workspace/.succinix-c-1/etc/systemd/system', { recursive: true }); await fs.writeFile('/workspace/.succinix-c-1/etc/systemd/system/web3212.service', ${JSON.stringify(svcUnit)}); return true; })()`);
    await h.run('succinix service daemon-reload');
    const svcStart = await h.run('succinix service start web3212', 60000);
    let portOwned = false;
    for (let i = 0; i < 40 && !portOwned; i++) {
      portOwned = (await h.evalValue('window.__succinixScenario.ports.has(3212)')) === true;
      if (!portOwned) await sleep(1000);
    }
    const serviceStatus = await h.run('succinix service status web3212');
    const previewState = await h.run('succinix net preview');
    const serviceStartDetail = svcStart.output?.trim() || JSON.stringify({ ok: svcStart.ok, stderr: svcStart.stderr, error: svcStart.error, exitCode: svcStart.exitCode, status: serviceStatus.output, ports: previewState.output });
    check(checks, 'succinix service start in c-1 registers port 3212 in c-1 view', portOwned === true, serviceStartDetail.slice(0, 180));
    const portUnownedAfter = await h.evalValue('window.__succinixScenario.ports.has(3211)');
    check(checks, 'port 3211 still not in c-1 view after own expectation exists', portUnownedAfter === false, `inView=${portUnownedAfter}`);

    // R5-4：reset-instance（reboot host 侧边界）只重置自己 —— c-1 重置后 c-2 进程存活。
    const p3 = await spawnOf(h, CLIENT_A, 'node -e "setInterval(()=>{},1000)"');
    const resetA = await resetOf(h, CLIENT_A);
    check(checks, 'c-1 reset-instance ok', resetA.ok === true, `ok=${resetA.ok}`);
    const p3State = await waitProcStatus(h, CLIENT_A, p3.pid, true, 20000);
    check(checks, 'c-1 process killed by c-1 reset-instance', p3State !== 'running', p3State);
    const p2AfterReset = await waitProcStatus(h, C2, p2.pid, false, 10000);
    const srvAfterReset = await waitProcStatus(h, C2, srv.pid, false, 10000);
    check(checks, 'c-2 process survives c-1 reset-instance', p2AfterReset === 'running', p2AfterReset);
    check(checks, 'c-2 spawned server survives c-1 reset-instance', srvAfterReset === 'running', srvAfterReset);
    const resetC2 = await resetOf(h, C2);
    check(checks, 'c-2 reset-instance ok', resetC2.ok === true, `ok=${resetC2.ok}`);
    check(checks, 'c-2 process killed by c-2 reset-instance', (await waitProcStatus(h, C2, p2.pid, true, 20000)) !== 'running');

    // R5-5：同页快照按实例键隔离 —— c-1 快照只写 instance:c-1，不覆盖 instance:c-2
    // （v0.7 persist v2：库 succinix-persist-v2，指针存 snapshot-v2-pointers，键 current|instance:<id>）。
    const idbKeys = await h.evalValue(`(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('succinix-persist-v2', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const stores = Array.from(db.objectStoreNames);
      const tx = db.transaction('snapshot-v2-pointers', 'readonly');
      const req = tx.objectStore('snapshot-v2-pointers').getAllKeys();
      return new Promise((res) => { tx.oncomplete = () => res({ stores, keys: req.result }); });
    })()`);
    check(checks, 'persist v2 stores exist', Array.isArray(idbKeys?.stores) && ['snapshot-v2-pointers', 'snapshot-v2-manifests', 'snapshot-v2-chunks'].every((s) => idbKeys.stores.includes(s)), JSON.stringify(idbKeys?.stores));
    check(checks, 'page snapshot stored under instance:c-1 pointer', Array.isArray(idbKeys?.keys) && idbKeys.keys.includes('instance:c-1'), JSON.stringify(idbKeys?.keys));
    await h.evalValue(`(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('succinix-persist-v2', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const tx = db.transaction('snapshot-v2-pointers', 'readwrite');
      tx.objectStore('snapshot-v2-pointers').put({ current: 0, lastKnownGood: null, updatedAt: 1, dummy: 'c2-marker' }, 'instance:c-2');
      return new Promise((res) => { tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
    })()`);
    const snapOk = await h.evalValue('window.__succinixScenario.saveSnapshot(true).then(() => true).catch(() => false)');
    check(checks, 'c-1 saveSnapshot(true) succeeds', snapOk === true);
    const idbAfter = await h.evalValue(`(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('succinix-persist-v2', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const tx = db.transaction('snapshot-v2-pointers', 'readonly');
      const keysReq = tx.objectStore('snapshot-v2-pointers').getAllKeys();
      const c1Req = tx.objectStore('snapshot-v2-pointers').get('instance:c-1');
      const c2Req = tx.objectStore('snapshot-v2-pointers').get('instance:c-2');
      return new Promise((res) => {
        tx.oncomplete = () => res({ keys: keysReq.result, c1: c1Req.result, c2: c2Req.result });
      });
    })()`);
    const c1Real = idbAfter?.c1 && typeof idbAfter.c1.current === 'number' && idbAfter.c1.current > 0 && typeof idbAfter.c1.updatedAt === 'number';
    check(checks, 'snapshot pointer keys isolated (c-1 + c-2 both present)', Array.isArray(idbAfter?.keys) && idbAfter.keys.includes('instance:c-1') && idbAfter.keys.includes('instance:c-2'), JSON.stringify(idbAfter?.keys));
    check(checks, 'c-1 snapshot pointer is real (not the c-2 dummy)', c1Real === true);
    check(checks, 'c-2 snapshot pointer not clobbered by c-1 save', idbAfter?.c2?.dummy === 'c2-marker');

    // 汇总
    console.log('\n=== INSTANCE ROUTING SUMMARY ===');
    const okN = checks.filter((c) => c.ok).length;
    console.log(`  Checks: ${okN}/${checks.length} passed`);
    process.exitCode = okN === checks.length ? 0 : 1;
  } finally {
    cdp?.close();
    await cleanupChrome(chrome, profileDir);
    preview.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(`[instance-routing] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
