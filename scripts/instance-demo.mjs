#!/usr/bin/env node
// M5 阶段验证点 1 + U1 阶段验证点 2 —— 双 tab 实例 demo（?instance=c-1 / ?instance=c-2）
// + 双用户 demo（?user=a / ?user=b，U1：每用户 home / 会话 cwd / 快照按用户隔离）。
// 零新依赖（复用 verify-deploy/scenarios 的 CDP 模式）：vite preview + headless Chrome
// 双 tab，各自独立 WebContainer。
//
// 断言：双 tab 独立 boot / 状态根按实例（.succinix-<id>）/ env 状态独立 / 快照按实例键
// （双 tab 共享同一 origin 的 IndexedDB，快照键 instance:<id> 必须互不串扰）/
// service start 只影响自己 / reboot 只重置自己（另一 tab 不受影响）。
//
// 盲区如实标注（MASTER-PLAN-NEXT R5）：双 tab 各自独立 host —— host 侧按实例路由
// （ps 过滤 / kill 越权，含跨用户 kill 拒绝）不在此覆盖，以协议级单测为证：
// 跨容器已 e2e、同页路由仅单测。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  allocateBrowserPorts,
  attachPageDiagnostics,
  cleanupChrome,
  launchChrome,
  writeBrowserFailureDiagnostics,
} from './lib/chrome.mjs';
import { connectBrowserCDP, connectTargetCDP } from './lib/cdp.mjs';
import { run, waitForHttp, sleep, makeTab } from './lib/harness.mjs';

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const portIndex = args.indexOf('--port');
const REQUESTED_PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;
let exitCode = 0;

function note(msg) {
  console.log(`[instance-demo] ${msg}`);
}

function check(checks, name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '[  OK  ]' : '[ FAIL ]'} ${name}${detail ? ` (${detail.slice(0, 200)})` : ''}`);
}

async function main() {
  if (!SKIP_BUILD) {
    note('production build...');
    await run('npm', ['run', 'build'], { silent: true });
  }
  const { previewPort, debugPort } = await allocateBrowserPorts(REQUESTED_PORT);
  const base = `http://127.0.0.1:${previewPort}`;
  note(`dual-tab instance demo (isolated ports ${previewPort}/${debugPort})`);
  note('starting vite preview...');
  // 直接用仓库内 vite 二进制（不经 npx，避免 registry 探测）。
  const preview = spawn(process.execPath, [join(import.meta.dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(previewPort), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  let chromeRun;
  let diagnosticCdp;
  let pageDiagnostics;
  let failure;
  try {
    await waitForHttp(base, 30000);

    chromeRun = launchChrome(debugPort, `instance-demo-${process.pid}`);

    // 浏览器级 CDP：建两个 tab（各自独立容器 / 独立页面上下文）。
    const browserCdp = await connectBrowserCDP(debugPort);
    const urls = {
      'c-1': `${base}/?instance=c-1&scenario=1`,
      'c-2': `${base}/?instance=c-2&scenario=1`,
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
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        const target = list.find((x) => x.type === 'page' && x.id === targetIds[id]);
        if (target?.webSocketDebuggerUrl) wsUrl = target.webSocketDebuggerUrl;
        if (!wsUrl) await sleep(200);
      }
      if (!wsUrl) throw new Error(`tab ${id}: CDP target not found`);
      const cdp = await connectTargetCDP(wsUrl);
      tabs[id] = makeTab(cdp, id);
    }
    diagnosticCdp = tabs['c-1'].cdp;
    await diagnosticCdp.send('Log.enable');
    pageDiagnostics = attachPageDiagnostics(diagnosticCdp);

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
    await A.run('succinix service start tinbase', 120000);
    const bSvc = await B.run('succinix service status tinbase');
    // tinbase WASM 引擎首启较慢（~30-60s），端口可能晚于命令内部 30s 等待就绪 ——
    // 轮询 status 直到 running（上限 90s），把"进程已起、端口稍后就绪"如实判为成功。
    let aRunning = false;
    let aStatusOut = '';
    for (let i = 0; i < 45 && !aRunning; i++) {
      const st = await A.run('succinix service status tinbase', 30000);
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
    check(checks, 'succinix service start in c-1 leaves tinbase running (own instance)', aRunning, aStatusOut.slice(0, 80));
    check(checks, 'succinix service status in c-2 stays stopped', bSvcOut.includes('Active: inactive'), bSvcOut.slice(0, 80));
    check(checks, 'port 3001 registered in c-1 view only', aPorts === true && bPorts === false);

    // C5b：停止再启动同一执行世界服务；模板的相对 .tinbase 数据目录必须归属实例状态根。
    const aStop = await A.run('succinix service stop tinbase', 30000);
    const aDb = await A.run('succinix service start tinbase', 120000);
    const aDbOut = String(aDb.output ?? '');
    const aStopOut = String(aStop.output ?? '');
    check(checks, 'succinix service stop tinbase (instance mode)', aStop.handled === true && aStopOut.toLowerCase().includes('stopped'), aStopOut.trim().slice(0, 120));
    let aDbPort = false;
    for (let i = 0; i < 45 && !aDbPort; i++) {
      aDbPort = (await A.eval('window.__succinixScenario.ports.has(3001)')) === true;
      if (aDbPort) break;
      await sleep(2000);
    }
    const aDbDir = await A.eval(`window.__succinixScenario.wc.fs.readdir('/workspace/.succinix-c-1/.tinbase').then((x) => x.length > 0).catch(() => false)`);
    check(checks, 'succinix service restart in c-1 brings port up', aDbPort, aDbOut.slice(0, 100));
    check(checks, 'tinbase data dir created under instance state root', aDbDir === true);

    // C6/C7：reboot 只重置自己 —— A reboot 后会话重建（状态根清空），B 全程不受影响。
    await A.run('succinix reboot');
    await sleep(3000);
    const aAlive = await A.eval('!!window.__succinixScenario && window.__succinixScenario.booted === true');
    const bEcho = await B.run('echo b-alive');
    const aEnvAfter = await A.run('env');
    const bEnvAfter = await B.run('env');
    check(checks, 'reboot in c-1 rebuilds instance in place (page not reloaded)', aAlive === true);
    check(checks, 'c-2 unaffected by c-1 reboot (still responsive)', bEcho.ok === true && String(bEcho.output).includes('b-alive'));
    check(checks, 'c-1 state root cleared by reboot (env reset)', !String(aEnvAfter.output).includes('C1_MARK'));
    check(checks, 'c-2 env untouched by c-1 reboot', String(bEnvAfter.output).includes('C2_MARK') && !String(bEnvAfter.output).includes('C1_MARK'), String(bEnvAfter.output ?? '').trim().slice(0, 120));

    // ─── U1：双用户 demo（?user=a / ?user=b）───
    // 与实例 demo 同一机制（userId == instanceId）；差异点：每用户 home
    // （/workspace/users/<id>，.succinix 种子）、会话 cwd = home（Lifo 视图，pwd 断言）、
    // 身份展示（whoami / 提示符前缀）。快照按用户键隔离 + 刷新后 cwd 仍在 home。
    const userUrls = {
      a: `${base}/?user=a&scenario=1`,
      b: `${base}/?user=b&scenario=1`,
    };
    const userTargetIds = {};
    for (const id of Object.keys(userUrls)) {
      const t = await browserCdp.send('Target.createTarget', { url: userUrls[id] });
      userTargetIds[id] = t.targetId;
    }
    const userTabs = {};
    for (const id of Object.keys(userUrls)) {
      let wsUrl = '';
      for (let i = 0; i < 30 && !wsUrl; i++) {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        const target = list.find((x) => x.type === 'page' && x.id === userTargetIds[id]);
        if (target?.webSocketDebuggerUrl) wsUrl = target.webSocketDebuggerUrl;
        if (!wsUrl) await sleep(200);
      }
      if (!wsUrl) throw new Error(`user tab ${id}: CDP target not found`);
      const cdp = await connectTargetCDP(wsUrl);
      userTabs[id] = makeTab(cdp, id);
    }
    const UA = userTabs['a'];
    const UB = userTabs['b'];

    // U1：双用户各自完整 boot（?user= demo 路径），句柄就绪。
    await UA.waitForScenario();
    await UB.waitForScenario();
    check(checks, 'dual-tab ?user= demo boots independently (a + b)', true);

    // U2：每用户 home 初始化（/workspace/users/<id> + .succinix 种子内容 = 用户 id）。
    const aHomeMarker = await UA.eval(`window.__succinixScenario.wc.fs.readFile('/workspace/users/a/.succinix','utf8').then((t) => t.trim()).catch(() => 'MISSING')`);
    const bHomeMarker = await UB.eval(`window.__succinixScenario.wc.fs.readFile('/workspace/users/b/.succinix','utf8').then((t) => t.trim()).catch(() => 'MISSING')`);
    const aHomeLs = await UA.eval(`window.__succinixScenario.wc.fs.readdir('/workspace/users/a').then((x) => Array.isArray(x)).catch(() => false)`);
    check(checks, 'per-user home seeded under /workspace/users (a + b dirs exist)', aHomeLs === true);
    check(checks, 'per-user .succinix marker content equals user id (a + b)', aHomeMarker === 'a' && bHomeMarker === 'b');

    // U3：会话 cwd = home（Lifo 视图 /workspace/workspace/users/<id>）；身份展示。
    const aPwd = await UA.run('pwd');
    const bPwd = await UB.run('pwd');
    const aWho = await UA.run('whoami');
    const bWho = await UB.run('whoami');
    check(checks, 'session cwd starts at user home (pwd = /workspace/workspace/users/<id>)', String(aPwd.output).trim() === '/workspace/workspace/users/a' && String(bPwd.output).trim() === '/workspace/workspace/users/b', `${String(aPwd.output).trim()} | ${String(bPwd.output).trim()}`);
    check(checks, 'whoami shows user id in ?user= mode (a + b)', String(aWho.output).trim() === 'a' && String(bWho.output).trim() === 'b', `${String(aWho.output).trim()} | ${String(bWho.output).trim()}`);

    // U4：env 状态按用户独立（状态根 /workspace/.succinix-<id>）。
    await UA.run('env UA_MARK=from-a');
    await UB.run('env UB_MARK=from-b');
    const aEnv = await UA.run('env');
    const bEnv = await UB.run('env');
    check(checks, 'env isolated per user (UA_MARK in a only, UB_MARK in b only)', String(aEnv.output).includes('UA_MARK') && !String(aEnv.output).includes('UB_MARK') && String(bEnv.output).includes('UB_MARK') && !String(bEnv.output).includes('UA_MARK'));
    const uaMotd = await UA.eval(`window.__succinixScenario.wc.fs.readFile('/workspace/.succinix-a/etc/succinix.motd').then(() => true).catch(() => false)`);
    const ubMotd = await UB.eval(`window.__succinixScenario.wc.fs.readFile('/workspace/.succinix-b/etc/succinix.motd').then(() => true).catch(() => false)`);
    check(checks, 'per-user state roots (a + b motd present)', uaMotd === true && ubMotd === true);

    // U5：快照按用户键隔离 + 刷新后 cwd 仍在 home（用户 home 内标记文件各自恢复）。
    await UA.eval(`window.__succinixScenario.wc.fs.writeFile('/workspace/users/a/a-marker.txt','a').then(() => true).catch(() => false)`);
    await UB.eval(`window.__succinixScenario.wc.fs.writeFile('/workspace/users/b/b-marker.txt','b').then(() => true).catch(() => false)`);
    const uaSnap = await UA.eval('window.__succinixScenario.saveSnapshot(true).then(() => true).catch(() => false)');
    const ubSnap = await UB.eval('window.__succinixScenario.saveSnapshot(true).then(() => true).catch(() => false)');
    check(checks, 'per-user snapshots saved (both tabs, shared origin IndexedDB)', uaSnap === true && ubSnap === true);
    await UA.reloadAndWait();
    await UB.reloadAndWait();
    const uaHasA = await UA.eval(`window.__succinixScenario.wc.fs.readFile('/workspace/users/a/a-marker.txt').then(() => true).catch(() => false)`);
    const uaHasB = await UA.eval(`window.__succinixScenario.wc.fs.readFile('/workspace/users/b/b-marker.txt').then(() => true).catch(() => false)`);
    const ubHasB = await UB.eval(`window.__succinixScenario.wc.fs.readFile('/workspace/users/b/b-marker.txt').then(() => true).catch(() => false)`);
    const ubHasA = await UB.eval(`window.__succinixScenario.wc.fs.readFile('/workspace/users/a/a-marker.txt').then(() => true).catch(() => false)`);
    check(checks, 'snapshot isolation per user (a restores only own home marker)', uaHasA === true && uaHasB === false);
    check(checks, 'snapshot isolation per user (b restores only own home marker)', ubHasB === true && ubHasA === false);
    const uaPwdAfter = await UA.run('pwd');
    const ubPwdAfter = await UB.run('pwd');
    check(checks, 'session cwd persists in user home after refresh (a + b)', String(uaPwdAfter.output).trim() === '/workspace/workspace/users/a' && String(ubPwdAfter.output).trim() === '/workspace/workspace/users/b');

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n=== INSTANCE DEMO SUMMARY ===`);
    for (const c of checks) console.log(`  ${c.ok ? '[  OK  ]' : '[ FAIL ]'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`);
    console.log(`instance-demo: ${checks.length - failed.length}/${checks.length} checks passed, ${failed.length} failed`);
    if (failed.length > 0) {
      exitCode = 1;
      failure = new Error(`${failed.length} instance isolation assertions failed`);
      const diagnostics = await writeBrowserFailureDiagnostics({
        label: `instance-demo-${process.pid}`,
        error: failure,
        cdp: diagnosticCdp,
        pageDiagnostics,
        chromeRun,
        previewPort,
        debugPort,
      });
      console.error(`[instance-demo] failure diagnostics: ${diagnostics.reportPath}`);
    }

    for (const id of Object.keys(userTabs)) userTabs[id].cdp.close();
    browserCdp.close();
    for (const id of Object.keys(tabs)) tabs[id].cdp.close();
  } catch (e) {
    failure = e;
    note(`FATAL: ${e.stack ?? e}`);
    const diagnostics = await writeBrowserFailureDiagnostics({
      label: `instance-demo-${process.pid}`,
      error: e,
      cdp: diagnosticCdp,
      pageDiagnostics,
      chromeRun,
      previewPort,
      debugPort,
    });
    console.error(`[instance-demo] failure diagnostics: ${diagnostics.reportPath}`);
    exitCode = 1;
  } finally {
    pageDiagnostics?.dispose();
    diagnosticCdp?.close();
    const cleanup = await cleanupChrome(chromeRun?.chrome, chromeRun?.profileDir);
    if (!cleanup.exited || cleanup.descendantsAfter.length > 0 || !cleanup.profileRemoved) {
      console.error(`[instance-demo] cleanup diagnostic: ${JSON.stringify(cleanup)}`);
    }
    await stopPreview(preview);
    if (failure) note('failure diagnostics were retained in the temporary directory above');
  }
  note(exitCode === 0 ? 'RESULT: PASSED' : 'RESULT: FAILED');
  process.exitCode = exitCode;
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

main().catch((e) => {
  console.error(`[instance-demo] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
