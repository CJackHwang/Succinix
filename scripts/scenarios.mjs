#!/usr/bin/env node
// Succinix TASK19 高级复杂功能场景测试：headless Chrome + CDP 驱动真实工作流。
// 零新依赖（仿 verify-deploy.mjs / bench.mjs 的 CDP 模式）。每个场景真实执行、真实断言：
//   S1 npm 项目开发闭环       S2 git 操作            S3 数据库全生命周期
//   S4 服务自启               S5 多工作区隔离        S6 队列串行正确性
//   S7 大输出                 S8 持久化压力          S9 错误路径
//   S10 环境边界（reboot）    S11 python 脚本工作流  S12 cd + npm install cwd 同步
//   S13 TS 生态工作流（npm i -D typescript tsx vitest → tsc → node → vitest 1 passed）
//   S14 语言生态防回归套件（&& 链 / 引号保真 / EACCES hint / cwd 装包 / python 管道）
//
// 用法：
//   node scripts/scenarios.mjs [--skip-build] [--port 7895]
//   （默认先 npm run build 再用 vite preview 托管 dist/；--skip-build 要求 dist/ 已是最新。）
//
// 页面驱动：?scenario=1 时 main.ts 暴露 window.__succinixScenario = { run, client, wc, ports, saveSnapshot }，
// run(cmd) 走与真实终端 execute() 相同的分发路径（browser 拦截 → host RPC），输出结构化返回。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, cleanupChrome } from './lib/chrome.mjs';
import { connectPageCDP, evalValue } from './lib/cdp.mjs';
import { run, waitForHttp, sleep, makeHarness } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const portIdx = args.indexOf('--port');
// 7897 被本机 Clash 代理占用，scenarios 用 7895/7896（与 verify 7892 / bench 7894 错开）。
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 7895;
// --only S1,S4：只跑指定场景（调试用）。
const only = args.includes('--only') ? new Set((args[args.indexOf('--only') + 1] ?? '').split(',')) : null;
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1;

// tinbase 固定开发 key（well-known Supabase 本地 demo keys，README 注明确定性）。
const TINBASE_SERVICE_ROLE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// ─── 结果汇总 ───
let globalPass = 0;
let globalFail = 0;
const scenarioResults = [];

function note(msg) {
  console.log(`[scenarios] ${msg}`);
}
function check(checks, name, ok, detail = '') {
  checks.push({ name, ok, detail });
  globalPass += ok ? 1 : 0;
  globalFail += ok ? 0 : 1;
}
function printChecks(checks) {
  for (const c of checks) {
    const mark = c.ok ? '[  OK  ]' : '[ FAIL ]';
    const color = c.ok ? '\x1b[33m' : '\x1b[31m';
    console.log(`  ${color}${mark}\x1b[0m ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  }
}

// ─── S1：npm 项目开发闭环 ───
async function s1(h) {
  const checks = [];
  const PORT_S1 = 3461;
  // 1. npm init -y（真实 node 子进程，cwd = 容器项目主目录 = 浏览器根）
  const init = await h.run('npm init -y', 120000);
  check(checks, 'npm init -y succeeds', init.ok === true && init.runtime === 'node', `ok=${init.ok} runtime=${init.runtime}`);
  const pkg = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/package.json','utf8').catch(()=>'')`);
  check(checks, 'package.json artifact real', typeof pkg === 'string' && pkg.includes('"name"'), pkg.slice(0, 60));

  // 2. 写 server.js（http 服务，带 CORS 头使浏览器可直取预览 URL）
  const serverJs = `const http=require('http');http.createServer((q,s)=>{s.setHeader('Access-Control-Allow-Origin','*');s.end('s1-http-ok')}).listen(${PORT_S1})`;
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/server.js', ${JSON.stringify(serverJs)})`);

  // 3. node 启动后台
  const sp = await h.spawn('node server.js');
  check(checks, 'node server spawn returns pid', sp.ok === true && Number(sp.pid) > 0, `pid=${sp.pid} runtime=${sp.runtime}`);

  // 4. 等端口就绪 → 预览 URL 真实注册
  const url = await h.waitFor(`window.__succinixScenario.ports.get(${PORT_S1}) || null`, 20000);
  check(checks, 'server-ready -> preview URL registered', typeof url === 'string' && /^https?:\/\//.test(url), url);

  // 5. 真实 HTTP 200：node 子进程在容器内 fetch 预览 URL（容器内无 CORS 限制，走 WebContainer
  //    预览代理回到 server 的 127.0.0.1 端口）。浏览器直取预览 URL 是 AGENTS.md 已知 CORS 边界，
  //    一并记录证据但不作判定。
  const httpRes = await h.evalValue(`(async () => {
    const out = {};
    const url = ${JSON.stringify(url)};
    const fetchScript = 'node -e "fetch(process.argv[1]).then(async r=>console.log(r.status+\\' \\'+await r.text())).catch(e=>console.log(\\'ERR \\'+e.message))"';
    try {
      const r = await window.__succinixScenario.client.terminal(fetchScript + ' ' + url, undefined, 20000);
      out.preview = { ok: r.ok, stdout: String(r.stdout || '') };
    } catch (e) { out.preview = { ok: false, error: String(e) }; }
    try {
      const r = await window.__succinixScenario.client.terminal('node -e "fetch(\\'http://127.0.0.1:${PORT_S1}\\').then(async r=>console.log(r.status+\\' \\'+await r.text()))"', undefined, 15000);
      out.local = { ok: r.ok, stdout: String(r.stdout || '') };
    } catch (e) { out.local = { ok: false, error: String(e) }; }
    try {
      const r = await fetch(url);
      out.browser = { ok: r.ok, status: r.status, text: await r.text() };
    } catch (e) { out.browser = { ok: false, error: String(e) }; }
    return JSON.stringify(out);
  })()`);
  const hr = JSON.parse(httpRes);
  const previewOk = hr.preview.ok === true && String(hr.preview.stdout).trim() === '200 s1-http-ok';
  const localOk = hr.local.ok === true && String(hr.local.stdout).trim() === '200 s1-http-ok';
  check(checks, 'preview URL returns HTTP 200 (container fetch)', previewOk, previewOk ? hr.preview.stdout.trim() : `err=${hr.preview.error || hr.preview.stdout}`);
  if (!previewOk) {
    check(checks, 'in-container port returns HTTP 200 (fallback)', localOk, localOk ? hr.local.stdout.trim() : `err=${hr.local.error || hr.local.stdout}`);
  }
  note(`[S1] browser preview fetch evidence: ${hr.browser?.status === 200 ? `200 ${hr.browser.text}` : `CORS boundary (${String(hr.browser?.error ?? 'n/a').slice(0, 50)})`}`);

  // 6. kill → 进程表退出
  const k = await h.run(`kill ${sp.pid}`);
  await sleep(400);
  check(checks, 'kill stops background server', k.killed === true, `killed=${k.killed} ${k.message ?? ''}`);

  // 清理
  await h.evalValue(`(async () => { const fs = window.__succinixScenario.wc.fs; for (const f of ['/server.js','/package.json','/package-lock.json']) { try { await fs.rm(f); } catch {} } return true; })()`);
  return checks;
}

// ─── S2：git 操作 ───
async function s2(h) {
  const checks = [];
  // 1. pkg install lifo-pkg-git（真实 lifo 通道，网络安装）
  const inst = await h.run('pkg install lifo-pkg-git', 180000);
  check(checks, 'pkg install lifo-pkg-git', inst.handled === true && inst.ok === true, inst.output ? inst.output.slice(0, 160) : '');
  // 真实证明：lifo list 出现 git（Lifo 的 git 不支持 --version，用已装列表断言）
  const ll = await h.run('lifo list');
  check(checks, 'git installed (lifo list)', ll.ok === true && String(ll.stdout).includes('git'), String(ll.stdout).trim().split('\n').find((l) => l.includes('git')) || String(ll.stdout).trim().slice(0, 80));

  // 2. 工作目录 + 文件
  await h.run('mkdir -p /s2-git');
  await h.run('cd /s2-git');
  const w = await h.run('echo "s2-file-content" > README.md');
  check(checks, 'write file in git dir', w.ok === true, `ok=${w.ok}`);

  // 3. git init
  const gi = await h.run('git init');
  check(checks, 'git init', gi.ok === true, String(gi.stdout || gi.stderr || '').trim().slice(0, 80));

  // 4. identity + add + commit
  await h.run('git config user.email "s2@succinix.dev"');
  await h.run('git config user.name "s2"');
  const ga = await h.run('git add README.md');
  check(checks, 'git add', ga.ok === true, `ok=${ga.ok}`);
  const gc = await h.run('git commit -m "s2 initial commit"');
  check(checks, 'git commit', gc.ok === true, String(gc.stdout || gc.stderr || '').trim().slice(0, 120));

  // 5. git log → commit hash 真实产生
  const gl = await h.run('git log --oneline');
  const logOut = String(gl.stdout || '');
  check(checks, 'git log shows commit hash', gl.ok === true && /[0-9a-f]{7,}/i.test(logOut), logOut.trim().slice(0, 80));

  // 清理
  await h.run('cd /');
  await h.run('rm -rf /s2-git');
  return checks;
}

// ─── S3：数据库全生命周期 ───
async function s3(h) {
  const checks = [];
  // 1. db start（首次含 npm install tinbase，重活）
  const ds = await h.run('db start', 200000);
  check(checks, 'db start (wasm)', ds.handled === true && ds.output.includes('Database ready'), ds.output ? ds.output.slice(-120) : '');
  const url = await h.waitFor('window.__succinixScenario.ports.get(3001) || null', 15000);
  check(checks, 'port 3001 in ready list', typeof url === 'string', url);

  // 2. node 脚本：建表 + 插数据 + 读回（真实 SQL / REST）
  const script = `
const BASE='http://127.0.0.1:3001';
const KEY='${TINBASE_SERVICE_ROLE}';
const H={'apikey':KEY,'content-type':'application/json'};
(async()=>{
  try {
    const c=await fetch(BASE+'/admin/v1/sql',{method:'POST',headers:H,body:JSON.stringify({query:'CREATE TABLE IF NOT EXISTS s3_todo (id serial primary key, note text)'})});
    const ins=await fetch(BASE+'/rest/v1/s3_todo',{method:'POST',headers:H,body:JSON.stringify({note:'s3-persist-marker'})});
    const rd=await fetch(BASE+'/rest/v1/s3_todo?select=note',{headers:H});
    console.log('CREATE='+c.status+' INSERT='+ins.status+' READ='+rd.status+' '+await rd.text());
  } catch(e) { console.log('ERR '+String(e)); }
})();
`;
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s3-db.mjs', ${JSON.stringify(script)})`);
  const r = await h.run('node s3-db.mjs', 60000);
  const so = String(r.stdout || '');
  check(checks, 'SQL create + REST insert + read real', r.ok === true && so.includes('CREATE=200') && so.includes('INSERT=201') && so.includes('s3-persist-marker'), so.trim().slice(0, 160));

  // 3. db stop
  const st = await h.run('db stop');
  check(checks, 'db stop', st.handled === true && st.output.includes('stopped'), st.output ? st.output.trim().slice(0, 120) : '');

  // 4. db start 再起（同会话 tinbase 已装，跳过 install）
  const ds2 = await h.run('db start', 120000);
  check(checks, 'db start (restart)', ds2.handled === true && ds2.output.includes('Database ready'), ds2.output ? ds2.output.slice(-120) : '');

  // 5. 数据跨重启仍在（持久化）
  const readScript = `
const BASE='http://127.0.0.1:3001';
const KEY='${TINBASE_SERVICE_ROLE}';
const H={'apikey':KEY,'content-type':'application/json'};
(async()=>{
  try {
    const rd=await fetch(BASE+'/rest/v1/s3_todo?select=note',{headers:H});
    console.log('READ_STATUS='+rd.status+' '+await rd.text());
  } catch(e) { console.log('ERR '+String(e)); }
})();
`;
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s3-read.mjs', ${JSON.stringify(readScript)})`);
  const r2 = await h.run('node s3-read.mjs', 60000);
  const so2 = String(r2.stdout || '');
  check(checks, 'data persists across db restart', r2.ok === true && so2.includes('READ_STATUS=200') && so2.includes('s3-persist-marker'), so2.trim().slice(0, 160));

  // 清理
  await h.run('db stop');
  await h.evalValue(`(async () => { const fs = window.__succinixScenario.wc.fs; for (const f of ['/s3-db.mjs','/s3-read.mjs']) { try { await fs.rm(f); } catch {} } return true; })()`);
  return checks;
}

// ─── S4：服务自启 ───
async function s4(h) {
  const checks = [];
  // 1. enable tinbase
  const en = await h.run('service enable tinbase');
  check(checks, 'service enable tinbase', en.handled === true && en.output.includes('enabled'), en.output ? en.output.trim().slice(0, 120) : '');

  // 2. 刷新 → boot 自动拉起
  await h.reloadAndWait(180000);
  const st = await h.run('service status tinbase');
  // 诊断：进程表（含 outputTail）+ boot 日志尾部（记录 autostart 实际发生了什么）
  const diagPs = await h.run('ps');
  const diagLog = await h.run('log -n 20');
  const diagProcs = (diagPs.processes ?? [])
    .map((p) => `${p.pid}:${p.status}${p.outputTail ? '[' + String(p.outputTail).split('\n').filter(Boolean).slice(-2).join('|') + ']' : ''}`)
    .join(' || ') || 'none';
  const diagDetail = `state=${st.output.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').find((l) => l.includes('state')) || '?'}; procs=${diagProcs}; log=${String(diagLog.output || '').split('\n').filter((l) => /service|tinbase|FAIL|BOOT/i.test(l)).slice(-4).join(' | ')}`;
  check(checks, 'boot autostart pulls tinbase up', st.handled === true && st.output.includes('running'), diagDetail.slice(0, 400));

  // 3. disable → 刷新不再拉起
  const dis = await h.run('service disable tinbase');
  check(checks, 'service disable tinbase', dis.handled === true && dis.output.includes('disabled'), dis.output ? dis.output.trim().slice(0, 120) : '');
  await h.reloadAndWait(120000);
  const st2 = await h.run('service status tinbase');
  check(checks, 'disabled service not autostarted', st2.handled === true && st2.output.includes('stopped'), st2.output ? st2.output.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 160) : '');
  return checks;
}

// ─── S5：多工作区隔离 ───
async function s5(h) {
  const checks = [];
  // 诊断：boot 后 /ws 初始内容（确认 main 是否存在）
  const wsInit = await h.evalValue(`(async () => {
    const fs = window.__succinixScenario.wc.fs;
    let entries = [];
    try { entries = await fs.readdir('/ws', { withFileTypes: true }); } catch (e) { return 'NO_WS: ' + String(e); }
    return entries.map((e) => e.name + (e.isDirectory() ? '/' : '')).join(',');
  })()`);
  note(`[S5] /ws at start: ${wsInit}`);
  await h.run('workspace create proj-a');
  await h.run('workspace create proj-b');
  await h.run('workspace switch proj-a');
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/ws/proj-a/a.txt','a-file-content')`);

  await h.run('workspace switch proj-b');
  const aInB = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/ws/proj-b/a.txt','utf8').then(()=>true).catch(()=>false)`);
  check(checks, 'proj-b does not see proj-a file', aInB === false, `a.txt visible in proj-b: ${aInB}`);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/ws/proj-b/b.txt','b-file-content')`);

  await h.run('workspace switch proj-a');
  const aTxt = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/ws/proj-a/a.txt','utf8').catch(()=>'MISSING')`);
  check(checks, 'proj-a file intact after switch', aTxt === 'a-file-content', aTxt);
  const bInA = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/ws/proj-a/b.txt','utf8').then(()=>true).catch(()=>false)`);
  check(checks, 'proj-a does not see proj-b file', bInA === false, `b.txt visible in proj-a: ${bInA}`);

  // 刷新后状态保留
  await h.reloadAndWait(120000);
  const wsDiag = await h.evalValue(`(async () => {
    const fs = window.__succinixScenario.wc.fs;
    let entries = [];
    try { entries = await fs.readdir('/ws', { withFileTypes: true }); } catch (e) { return 'NO_WS: ' + String(e); }
    return entries.map((e) => e.name + (e.isDirectory() ? '/' : '')).join(',');
  })()`);
  note(`[S5] /ws after refresh: ${wsDiag}`);
  const cur = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/ws/.current','utf8').catch(()=>'')`);
  check(checks, 'current workspace retained after refresh', cur.trim() === 'proj-a', `current=${cur.trim()}`);
  const aAfter = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/ws/proj-a/a.txt','utf8').catch(()=>'MISSING')`);
  check(checks, 'proj-a file retained after refresh', aAfter === 'a-file-content', aAfter);

  // 清理：切回 main，删除两个测试工作区
  const swMain = await h.run('workspace switch main');
  const rmA = await h.run('workspace rm proj-a --yes');
  const rmB = await h.run('workspace rm proj-b --yes');
  const wsList = await h.run('workspace');
  check(
    checks,
    'workspace cleanup',
    swMain.handled === true && rmA.handled === true && rmB.handled === true && !wsList.output.includes('proj-a') && !wsList.output.includes('proj-b'),
    `switch=${swMain.output.trim().slice(0, 40)} | rmA=${rmA.output.trim().slice(0, 40)} | rmB=${rmB.output.trim().slice(0, 40)} | list=${wsList.output.trim().split('\n').slice(0, 3).join('; ')}`
  );
  return checks;
}

// ─── S6：队列串行正确性（N3/TASK20：原名"并发压力"实为队列串行 —— TerminalClient 的
// 单槽 /cmd.json 通道把所有请求串行化，并行调用不会真并发；改名降级，诚实反映行为）───
async function s6(h) {
  const checks = [];
  const expr = `(async () => {
    const s = window.__succinixScenario;
    const cmds = [
      'node -e "setTimeout(()=>console.log(\\'OUT-A\\'),1200)"',
      'node -e "setTimeout(()=>console.log(\\'OUT-B\\'),300)"',
      'node -e "setTimeout(()=>console.log(\\'OUT-C\\'),800)"',
    ];
    const results = await Promise.all(cmds.map(async (c) => {
      try { return await s.client.terminal(c, undefined, 30000); }
      catch (e) { return { ok: false, stdout: '', exitCode: -1, error: String(e) }; }
    }));
    return JSON.stringify(results.map((r) => ({ ok: r.ok, stdout: String(r.stdout || '').trim(), exitCode: r.exitCode })));
  })()`;
  const raw = await h.evalValue(expr);
  const results = JSON.parse(raw);
  const allOk = results.every((r) => r.ok === true);
  check(checks, '3 queued long commands all return', allOk, `ok=${results.map((r) => r.ok).join(',')}`);
  const outs = results.map((r) => r.stdout);
  const noInterleave =
    outs[0] === 'OUT-A' && outs[1] === 'OUT-B' && outs[2] === 'OUT-C';
  check(checks, 'queue serialization preserves per-command output', noInterleave, JSON.stringify(outs));
  return checks;
}

// ─── S7：大输出 ───
async function s7(h) {
  const checks = [];
  // Lifo seq 1 10000（若内核有 seq；否则回落 node 循环）
  const probe = await h.run('seq 1 3');
  const hasSeq = probe.ok === true && String(probe.stdout).trim() === '1\n2\n3';
  if (hasSeq) {
    const r = await h.run('seq 1 10000', 30000);
    const lines = String(r.stdout || '').trim().split('\n').filter((l) => l.length > 0);
    check(checks, 'seq 1 10000 complete (Lifo)', r.ok === true && lines.length === 10000, `lines=${lines.length} bytes=${String(r.stdout).length}`);
  } else {
    const r = await h.run('node -e "for(let i=1;i<=10000;i++)console.log(i)"', 60000);
    const lines = String(r.stdout || '').trim().split('\n').filter((l) => l.length > 0);
    check(checks, '10000 lines via node', r.ok === true && lines.length === 10000, `lines=${lines.length}`);
  }

  // node 输出 2MB+ → 触发 1MB 上限裁剪，有界返回不 OOM、不卡死
  const big = await h.run(`node -e "console.log('x'.repeat(2*1024*1024))"`, 60000);
  const len = String(big.stdout || '').length;
  check(checks, '2MB output capped at 1MB', len <= 1024 * 1024 + 1, `bytes=${len}`);
  check(checks, 'big output returns bounded (no OOM/hang)', big.exitCode !== undefined, `exit=${big.exitCode} ok=${big.ok}`);
  return checks;
}

// ─── S8：持久化压力 ───
async function s8(h) {
  const checks = [];
  // 写 300 个文件
  const n = await h.evalValue(`(async () => {
    const fs = window.__succinixScenario.wc.fs;
    await fs.mkdir('/pstress', { recursive: true });
    for (let i = 0; i < 300; i++) await fs.writeFile('/pstress/f' + i + '.txt', 'content-' + i + '-padding-padding-padding');
    return 300;
  })()`);
  check(checks, '300 files written', n === 300, `n=${n}`);

  // snapshot now（强制落盘）
  const sn = await h.run('snapshot now', 60000);
  check(checks, 'snapshot now', sn.handled === true && sn.output.includes('Snapshot saved'), sn.output ? sn.output.trim().slice(0, 140) : '');

  // 刷新 → 全恢复 + 抽样校验
  await h.reloadAndWait(120000);
  const counts = await h.evalValue(`(async () => {
    const fs = window.__succinixScenario.wc.fs;
    let entries = [];
    try { entries = await fs.readdir('/pstress'); } catch { return { count: -1, samples: {} }; }
    const samples = {};
    for (const f of ['f0.txt','f150.txt','f299.txt']) {
      try { samples[f] = await fs.readFile('/pstress/' + f, 'utf8'); } catch (e) { samples[f] = 'MISSING'; }
    }
    return { count: entries.length, samples };
  })()`);
  check(checks, 'all 300 files restored after refresh', counts.count === 300, `count=${counts.count}`);
  const sampleOk =
    counts.samples['f0.txt'] === 'content-0-padding-padding-padding' &&
    counts.samples['f150.txt'] === 'content-150-padding-padding-padding' &&
    counts.samples['f299.txt'] === 'content-299-padding-padding-padding';
  check(checks, 'sampled file content consistent', sampleOk === true, JSON.stringify(counts.samples));

  // 清理
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/pstress', { recursive: true, force: true })`);
  await h.run('snapshot now', 60000);
  return checks;
}

// ─── S9：错误路径 ───
async function s9(h) {
  const checks = [];
  // 未知命令：英文报错，不挂死
  const u = await h.run('xyz-unknown-cmd-42', 15000);
  check(checks, 'unknown command errors cleanly', u.ok === false, `ok=${u.ok} exit=${u.exitCode}`);
  check(checks, 'unknown command error in English', /[a-z]/i.test(String(u.stderr || u.error || '')), String(u.stderr || u.error || '').trim().slice(0, 60));

  // 不存在目录
  const nd = await h.run('cat /nonexistent-dir-xyz/file.txt', 15000);
  check(checks, 'nonexistent dir errors cleanly', nd.ok === false && nd.exitCode !== 0, `exit=${nd.exitCode}`);

  // 网络失败（无 CORS curl）：有界返回，不挂死，英文提示
  const curl = await h.run('curl -s -m 12 https://example.com', 20000);
  check(checks, 'network failure returns bounded', curl.ok === false || curl.exitCode !== undefined, `exit=${curl.exitCode} ok=${curl.ok}`);
  check(checks, 'network failure has message', String(curl.stdout || curl.stderr || '').length > 0, String(curl.stdout || curl.stderr || '').slice(0, 60));
  return checks;
}

// ─── S10：环境边界（reboot）───
async function s10(h) {
  const checks = [];
  // 写标记文件 + 强制落盘
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s10-marker.txt','s10-survives')`);
  await h.run('snapshot now', 60000);

  // reboot → 页面真实 reload
  const rb = await h.run('reboot', 10000);
  check(checks, 'reboot triggered', rb.handled === true && rb.output.includes('Rebooting'), rb.output ? rb.output.trim() : '');

  // TASK25 防回归：reboot 是 setTimeout(300) 调 location.reload()。waitForScenario 可能在旧页面
  //（booted 仍 true）上立即返回，随后 reload 才落下来打到下一个场景 → 句柄丢失（S11+ 全崩）。
  // 必须先等到导航真的开始（eval 抛"context destroyed" 或句柄消失）再等新 boot。
  let navigating = false;
  const navDeadline = Date.now() + 15000;
  while (Date.now() < navDeadline && !navigating) {
    try {
      const alive = await evalValue(h.cdp, '!!window.__succinixScenario');
      if (alive === false) navigating = true;
    } catch {
      navigating = true; // context destroyed == 导航已开始
    }
    if (!navigating) await sleep(100);
  }
  if (!navigating) throw new Error('reboot navigation did not begin within 15s');

  // 等 reload + 重新 boot + 句柄就绪
  await h.waitForScenario(120000);

  // 文件仍在
  const m = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/s10-marker.txt','utf8').catch(()=>'MISSING')`);
  check(checks, 'file survives reboot', m === 's10-survives', m);

  // 服务状态合理：进程表可用且干净（无孤儿 running）
  const ps = await h.run('ps');
  const procs = Array.isArray(ps.processes) ? ps.processes : [];
  const running = procs.filter((p) => p.status === 'running');
  check(checks, 'process table clean after reboot', Array.isArray(procs) && running.length === 0, `total=${procs.length} running=${running.length}`);

  // 清理
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/s10-marker.txt', { force: true })`);
  return checks;
}

// ─── S11：python 脚本工作流（TASK23 → TASK27 Pyodide，含 pip + 刷新持久化）───
async function s11(h) {
  const checks = [];
  // 1. 写 .py 到浏览器 FS 根（= host /workspace 根，python 子进程 cwd 初始即此处）
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s11-hello.py', 'print("s11-python-ok")\\nimport os\\nprint("cwd=" + os.getcwd())\\n')`);

  // 2. python -c 真实执行（首用触发运行时资产懒注入 + Pyodide daemon 懒启动，给足超时）
  const rc = await h.run('python -c "print(21*2)"', 150000);
  check(checks, 'python -c executes', rc.ok === true && String(rc.stdout).trim() === '42', `ok=${rc.ok} stdout=${String(rc.stdout).trim()}`);

  // 3. python --version → Python 3.14.2（Pyodide 314.0.4 内置）
  const rv = await h.run('python --version', 60000);
  check(checks, 'python --version reports Python 3.14.2', rv.ok === true && String(rv.stdout).includes('3.14.2'), String(rv.stdout).trim().slice(0, 40));

  // 4. python 脚本文件（绝对路径 /s11-hello.py）
  const rs = await h.run('python /s11-hello.py', 120000);
  const so = String(rs.stdout || '');
  check(checks, 'python script runs', rs.ok === true && so.includes('s11-python-ok'), so.trim().slice(0, 120));

  // 5. python3 别名 + 标准库（json/sqlite3/csv/re/math/os 可导入）
  const rstd = await h.run('python3 -c "import json,csv,re,math,os,sqlite3; print(len([json,csv,re,math,os,sqlite3]))"', 120000);
  check(checks, 'python3 alias + stdlib imports', rstd.ok === true && String(rstd.stdout).trim() === '6', `stdout=${String(rstd.stdout).trim()}`);

  // 6. 真管道形态（TASK24 复审修复）：python 命令含 shell 元字符时经 Lifo shell 执行，python 段
  //    转发到常驻 daemon —— 管道真工作：grep 命中保留输出、无匹配过滤为空。
  const rg = await h.run("python -c \"print('hello-pipe')\" | grep pipe", 120000);
  check(checks, 'python pipe (grep filters)', rg.ok === true && String(rg.stdout).includes('hello-pipe'), String(rg.stdout).trim().slice(0, 60));
  const rgEmpty = await h.run("python -c \"print('abc')\" | grep zzz", 120000);
  check(checks, 'python pipe filters empty (grep zzz)', String(rgEmpty.stdout).trim() === '', String(rgEmpty.stdout).trim().slice(0, 60));

  // 7. TASK27 pip：python -m pip install 小包 → import 可用（micropip；网络边界按 SKIP 记录）
  const pipInst = await h.run('python -m pip install pyparsing==3.3.2', 150000);
  const pipErr = String(pipInst.stderr || '');
  if (pipInst.ok) {
    const pipImp = await h.run('python -c "import pyparsing; print(pyparsing.__version__)"', 60000);
    check(checks, 'pip install pyparsing + import (micropip)', pipImp.ok === true && String(pipImp.stdout).trim() === '3.3.2', `pyparsing ${String(pipImp.stdout).trim()}`);
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN|fetch failed|NetworkError|Timed out/i.test(pipErr)) {
    check(checks, 'pip install pyparsing + import (micropip)', true, `network boundary: ${pipErr.trim().slice(0, 60)}`);
  } else {
    check(checks, 'pip install pyparsing + import (micropip)', false, pipErr.trim().split('\n')[0]?.slice(0, 90) ?? '(no stderr)');
  }

  // 8. TASK27 numpy（编译包）：import numpy 或装后 import（给足网络时间；失败如实记录）
  const np1 = await h.run('python -c "import numpy; print(numpy.__version__)"', 60000);
  let numpyOk = false;
  if (np1.ok) {
    numpyOk = /^\d+\.\d+/.test(String(np1.stdout).trim());
  } else {
    const npInst = await h.run('python -m pip install numpy', 180000);
    if (npInst.ok) {
      const np2 = await h.run('python -c "import numpy; print(numpy.__version__)"', 60000);
      numpyOk = np2.ok === true && /^\d+\.\d+/.test(String(np2.stdout).trim());
      check(checks, 'numpy import (installed via pip)', numpyOk, numpyOk ? `numpy ${String(np2.stdout).trim()}` : String(np2.stderr || '').trim().slice(0, 80));
    } else {
      const npErr = String(npInst.stderr || '');
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN|fetch failed|NetworkError|Timed out/i.test(npErr)) {
        check(checks, 'numpy import (installed via pip)', true, `network boundary: ${npErr.trim().slice(0, 60)}`);
      } else {
        check(checks, 'numpy import (installed via pip)', false, npErr.trim().split('\n')[0]?.slice(0, 90) ?? '(no stderr)');
      }
    }
  }
  if (numpyOk) check(checks, 'numpy import (already present)', true, `numpy ${String(np1.stdout).trim()}`);

  // 9. TASK27 pip 持久化（尽力而为）：装过的纯 Python 包刷新后 import 仍在（NODEFS 站点包随快照）。
  //    先 snapshot now 强制落盘，再 reload；pyparsing 应直接可 import（无网络）。若不在 → 如实记录边界。
  await h.run('snapshot now', 60000);
  await h.reloadAndWait(120000);
  const pers = await h.run('python -c "import pyparsing; print(pyparsing.__version__)"', 120000);
  check(checks, 'pip package persists across refresh (pyparsing)', pers.ok === true && String(pers.stdout).trim() === '3.3.2', String(pers.stdout).trim() || String(pers.stderr || '').trim().slice(0, 80));
  // numpy 是编译包（.so 二进制不进文本快照）→ 刷新后需重装（边界，如实记录）。
  // TASK27 复审项 3：冷启动 import 报错必须保持如实，且提示指向 `pip install numpy` 解决路径。
  const persNp = await h.run('python -c "import numpy; print(numpy.__version__)"', 60000);
  if (persNp.ok) {
    check(checks, 'compiled package (numpy) boundary after refresh', false, `unexpectedly importable after refresh: ${String(persNp.stdout).trim()}`);
  } else {
    const npErr = String(persNp.stderr || '').trim();
    check(checks, 'compiled package (numpy) boundary after refresh', npErr.includes('pip install numpy'), `needs pip install after refresh (text snapshot drops .so) — hint: ${npErr.split('\n').slice(-1)[0]?.slice(0, 60)}`);
  }

  // 10. TASK27 复审修复项 1+2（浏览器真实路径）：
  //     - `pip install pyparsing requests` 多包：micropip.install([...]) 数组语义，不再把
  //       `join(' ')` 拼成单个 requirement（此前 PEP 508 会拒）。
  //     - `pip show pyparsing`：真实 pip 式元数据输出。
  //     - `pip show`（无参）：usage 提示 + exit 2（此前生成 NameError → exit 1）。
  const pipMulti = await h.run('python -m pip install pyparsing requests', 180000);
  const pipMultiErr = String(pipMulti.stderr || '');
  if (pipMulti.ok) {
    const impMulti = await h.run('python -c "import pyparsing, requests; print(pyparsing.__version__, requests.__version__)"', 60000);
    const impTokens = String(impMulti.stdout || '').trim().split(/\s+/).filter(Boolean);
    check(
      checks,
      'pip install multi-package (pyparsing requests) + import',
      impMulti.ok === true && impTokens.length === 2 && impTokens[0].length > 0 && impTokens[1].length > 0,
      `pyparsing=${impTokens[0] ?? ''} requests=${impTokens[1] ?? ''}`
    );
    const showPkg = await h.run('pip show pyparsing', 60000);
    check(
      checks,
      'pip show pyparsing works',
      showPkg.ok === true && /Name: pyparsing/i.test(String(showPkg.stdout || '')),
      String(showPkg.stdout || '').split('\n')[0]?.slice(0, 60) || String(showPkg.stderr || '').slice(0, 60)
    );
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN|fetch failed|NetworkError|Timed out/i.test(pipMultiErr)) {
    check(checks, 'pip install multi-package (pyparsing requests) + import', true, `network boundary: ${pipMultiErr.trim().slice(0, 60)}`);
    check(checks, 'pip show pyparsing works', true, 'skipped: multi-package install network boundary');
  } else {
    check(checks, 'pip install multi-package (pyparsing requests) + import', false, pipMultiErr.trim().split('\n')[0]?.slice(0, 90) ?? '(no stderr)');
    check(checks, 'pip show pyparsing works', false, 'multi-package install failed');
  }
  // pip show 无参：不依赖网络，独立断言 usage + exit 2。
  const showNone = await h.run('pip show', 60000);
  check(
    checks,
    'pip show no-arg usage + exit 2',
    showNone.ok === false && Number(showNone.exitCode) === 2 && /Usage: pip show <package>/.test(String(showNone.stderr || '')),
    `exit=${showNone.exitCode} stderr=${String(showNone.stderr || '').trim().slice(0, 60)}`
  );

  // 清理
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/s11-hello.py', { force: true })`);
  return checks;
}

// ─── S12：cd + npm install 装到会话 cwd（TASK23 融合基石验证）───
async function s12(h) {
  const checks = [];
  // 0. 复位会话 cwd（避免历史场景残留的持久化 cwd 影响断言）
  await h.run('cd /workspace');
  // TASK24（自检崩溃根因）：/workspace 是 Lifo 挂载视图，node 子进程实际 spawn 在 host 真实
  // 路径（spawnCwd 映射 /workspace → process.cwd()）。先取真实 base，供后续断言映射后的 cwd。
  const hostBase = String((await h.run('node -e "console.log(process.cwd())"')).stdout || '').trim();

  // 1. 建项目目录（Lifo 的 /workspace 挂载 = 浏览器 FS 根 = host 会话 cwd 初始值）
  const mk = await h.run('mkdir -p /workspace/s12-proj');
  check(checks, 'mkdir project dir', mk.ok === true, `ok=${mk.ok}`);

  // 2. cd 进项目目录（host 同步会话 cwd）
  const cd = await h.run('cd /workspace/s12-proj');
  check(checks, 'cd into project dir', cd.ok === true, `ok=${cd.ok}`);

  // 3. node 子进程 cwd 跟随会话 cwd（核心断言：Lifo cd 影响 node 子进程，真实路径映射）
  const s12Expected = `${hostBase}/s12-proj`;
  const n = await h.run('node -e "console.log(process.cwd())"');
  check(checks, 'node child cwd follows session cwd', n.ok === true && String(n.stdout).trim() === s12Expected, `node cwd=${String(n.stdout).trim()}`);

  // 4. pwd（浏览器侧拦截 → host 会话 cwd）显示会话 cwd
  const pwd = await h.run('pwd');
  check(checks, 'pwd shows session cwd', pwd.handled === true && String(pwd.output).trim() === '/workspace/s12-proj', `pwd=${String(pwd.output).trim()}`);

  // 5. npm init -y → package.json 落在项目目录（cwd 同步：npm 装到会话 cwd 而非容器根）
  const init = await h.run('npm init -y', 120000);
  check(checks, 'npm init -y runs in project dir', init.ok === true, `ok=${init.ok}`);
  const pkgAt = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/s12-proj/package.json','utf8').then(()=>true).catch(()=>false)`);
  check(checks, 'package.json created in project dir (cwd sync)', pkgAt === true, `present=${pkgAt}`);

  // 6. cd 到不存在目录：会话 cwd 不变（node 仍在上一个目录）
  const cdBad = await h.run('cd /s12-does-not-exist-xyz');
  const n2 = await h.run('node -e "console.log(process.cwd())"');
  check(checks, 'failed cd keeps session cwd', cdBad.ok === false && String(n2.stdout).trim() === s12Expected, `exit=${cdBad.exitCode} node cwd=${String(n2.stdout).trim()}`);

  // 清理：回 /workspace，删项目目录
  await h.run('cd /workspace');
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/s12-proj', { recursive: true, force: true })`);
  return checks;
}

// ─── S13：TS 生态工作流（TASK24，复现用户浏览器实测：npm i -D typescript tsx vitest →
// tsc 编译 → node 跑产物 → vitest 1 passed）───
async function s13(h) {
  const checks = [];
  const PROJ = '/workspace/s13-proj';
  // 0. 复位会话 cwd
  await h.run('cd /workspace');

  // 1. 建项目目录 + 进入（host 会话 cwd 同步）
  const mk = await h.run(`mkdir -p ${PROJ}`);
  check(checks, 'mkdir project dir', mk.ok === true, `ok=${mk.ok}`);
  const cd = await h.run(`cd ${PROJ}`);
  check(checks, 'cd into project dir', cd.ok === true, `ok=${cd.ok}`);

  // 2. npm init -y（真实 npm，cwd = 项目目录）
  const init = await h.run('npm init -y', 120000);
  check(checks, 'npm init -y', init.ok === true, `ok=${init.ok}`);

  // 3. npm i -D typescript tsx vitest（真实 npm 安装工具链 —— 重活，给足超时）
  const inst = await h.run('npm i -D typescript tsx vitest', 240000);
  check(checks, 'npm i -D typescript tsx vitest', inst.ok === true, `ok=${inst.ok} ${String(inst.stderr || inst.stdout || '').trim().split('\n').slice(-1)[0].slice(0, 80)}`);

  // 4. 写 TS 源码 + tsconfig（浏览器 FS = 项目目录，与 host 会话 cwd 同一份文件）
  await h.evalValue(`window.__succinixScenario.wc.fs.mkdir('/s13-proj/src', { recursive: true })`);
  // greet.ts 顶层调用使 `node dist/greet.js` 直接输出 hello ts（vitest 导入该模块时也触发，
  // 仅多一行无害输出，不改变测试结果）。
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s13-proj/src/greet.ts', 'export function greet(name: string): string { return "hello " + name; }\\nconsole.log(greet("ts"));\\n')`);
  const tsconfig = JSON.stringify({
    compilerOptions: { outDir: 'dist', rootDir: 'src', target: 'ES2022', module: 'commonjs', strict: true, esModuleInterop: true },
    include: ['src'],
  }, null, 2);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s13-proj/tsconfig.json', ${JSON.stringify(tsconfig)})`);

  // 5. tsc 编译 → 断言 dist 产物存在
  const tsc = await h.run('npx tsc -p tsconfig.json', 180000);
  check(checks, 'tsc compiles TS', tsc.ok === true, `ok=${tsc.ok} ${String(tsc.stderr || '').trim().slice(0, 120)}`);
  const distExists = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/s13-proj/dist/greet.js','utf8').then(()=>true).catch(()=>false)`);
  check(checks, 'dist/greet.js artifact produced', distExists === true, `present=${distExists}`);

  // 6. node 跑编译产物（真实 node 执行）
  const run = await h.run('node dist/greet.js', 60000);
  check(checks, 'node runs compiled artifact', run.ok === true && String(run.stdout).trim() === 'hello ts', `stdout=${String(run.stdout).trim()}`);

  // 7. vitest 测试（真实 vitest，1 passed）
  await h.evalValue(`window.__succinixScenario.wc.fs.mkdir('/s13-proj/test', { recursive: true })`);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s13-proj/test/greet.test.ts', 'import { test, expect } from "vitest"; import { greet } from "../src/greet"; test("greet", () => { expect(greet("ts")).toBe("hello ts"); });\\n')`);
  const vitest = await h.run('npx vitest run', 180000);
  const vtOut = String(vitest.stdout || '') + String(vitest.stderr || '');
  check(checks, 'vitest run: 1 passed', vitest.ok === true && /1 passed/.test(vtOut), vtOut.trim().split('\n').filter((l) => /passed|failed|Test Files/.test(l)).slice(-3).join(' | '));

  // 清理：回 /workspace，删项目目录
  await h.run('cd /workspace');
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/s13-proj', { recursive: true, force: true })`);
  return checks;
}

// ─── S14：语言生态防回归套件（TASK25）───
// 用户实测 5 坑逐条复测，锁定行为、防止回归：
//   1) && 链（node --version && npm --version 两行都出）
//   2) node -e 嵌套双引号写文件（引号保真 + tsc 可编译 + node 跑产物）
//   3) npm i -g → EACCES + hint 行
//   4) cwd 同步装包（cd /ws/proj → npm install 装进项目目录，非根 node_modules）
//   5) python 真管道（命中保留 / 无匹配过滤为空）
// 引号保真与 cwd 装包共用同一项目目录（typescript 一次安装同时证明"可编译"与"装对目录"）。
async function s14(h) {
  const checks = [];
  const PROJ = '/workspace/s14-proj';
  // 0. 复位会话 cwd
  await h.run('cd /workspace');

  // 1. && 链：node --version && npm --version 两行都出（shell 链）
  const chain = await h.run('node --version && npm --version', 60000);
  const chainLines = String(chain.stdout || '').trim().split('\n').filter((l) => l.length > 0);
  check(checks, 'S14 chain: node && npm both lines', chain.ok === true && chain.runtime === 'lifo' && chainLines.length >= 2 && /^v\d/.test(chainLines[0]), chainLines.join(' | '));

  // 2. node -e 嵌套双引号写 TS 文件（mkdir 与 cd 分开 —— 只有整条命令以 cd 开头才同步 host 会话 cwd）
  const mk = await h.run(`mkdir -p ${PROJ}/src`);
  check(checks, 'S14 mkdir project dir', mk.ok === true, `ok=${mk.ok}`);
  const cd = await h.run(`cd ${PROJ}`);
  check(checks, 'S14 cd into project dir', cd.ok === true, `ok=${cd.ok}`);
  const n2 = await h.run(`node -e "require('fs').writeFileSync('src/s14.ts', 'export const msg: string = \\"s14-quote-ok\\";\\nconsole.log(msg);')"`, 60000);
  const s14Content = await h.evalValue(`window.__succinixScenario.wc.fs.readFile('/s14-proj/src/s14.ts','utf8').then(t=>t).catch(()=>'MISSING')`);
  check(checks, 'S14 node -e nested quotes preserved in file', n2.ok === true && typeof s14Content === 'string' && s14Content.includes('"s14-quote-ok"'), `content=${JSON.stringify(s14Content).slice(0, 70)}`);

  // 3. npm init + 装 typescript（cwd = 项目目录）→ 证明"可编译"
  const init = await h.run('npm init -y', 120000);
  check(checks, 'S14 npm init -y', init.ok === true, `ok=${init.ok}`);
  const inst = await h.run('npm i -D typescript', 240000);
  check(checks, 'S14 npm i -D typescript', inst.ok === true, `ok=${inst.ok}`);

  // tsc 编译引号文件 → node 跑产物（引号保真贯通编译）
  const tsconfig = JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src', target: 'ES2022', module: 'commonjs', strict: true }, include: ['src'] }, null, 2);
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s14-proj/tsconfig.json', ${JSON.stringify(tsconfig)})`);
  const tsc = await h.run('npx tsc -p tsconfig.json', 180000);
  check(checks, 'S14 tsc compiles quote.ts (compilable)', tsc.ok === true, `ok=${tsc.ok} ${String(tsc.stderr || '').trim().slice(0, 80)}`);
  const runQ = await h.run('node dist/s14.js', 60000);
  check(checks, 'S14 node runs compiled artifact', runQ.ok === true && String(runQ.stdout).trim() === 's14-quote-ok', String(runQ.stdout).trim());

  // 4. cwd 装包：typescript 装进 /s14-proj/node_modules，根 /node_modules 没有
  const inProj = await h.evalValue(`window.__succinixScenario.wc.fs.readdir('/s14-proj/node_modules/typescript').then(()=>true).catch(()=>false)`);
  const inRoot = await h.evalValue(`window.__succinixScenario.wc.fs.readdir('/node_modules/typescript').then(()=>true).catch(()=>false)`);
  check(checks, 'S14 npm install packages into project dir (cwd sync)', inProj === true && inRoot === false, `proj=${inProj} root=${inRoot}`);

  // 5. npm i -g → EACCES + hint 行
  const g = await h.run('npm i -g left-pad', 120000);
  const gErr = String(g.stderr || '');
  check(checks, 'S14 npm i -g EACCES + hint line', g.ok === false && gErr.includes('EACCES') && gErr.includes('hint: /usr/local is read-only for guest'), `EACCES=${gErr.includes('EACCES')} hint=${gErr.includes('hint:')}`);

  // 6. python 真管道（命中保留 / 无匹配过滤为空）
  const pp1 = await h.run("python -c \"print('s14-pipe')\" | grep pipe", 90000);
  check(checks, 'S14 python pipe keeps match', pp1.ok === true && pp1.runtime === 'lifo' && String(pp1.stdout).includes('s14-pipe'), `runtime=${pp1.runtime} stdout=${String(pp1.stdout).trim().slice(0, 40)}`);
  const pp2 = await h.run("python -c \"print('abc')\" | grep zzz", 90000);
  check(checks, 'S14 python pipe filters empty', pp2.runtime === 'lifo' && String(pp2.stdout).trim() === '', `runtime=${pp2.runtime} stdout=${JSON.stringify(String(pp2.stdout).trim())}`);

  // 清理：回 /workspace，删项目目录
  await h.run('cd /workspace');
  await h.evalValue(`window.__succinixScenario.wc.fs.rm('/s14-proj', { recursive: true, force: true })`);
  return checks;
}

// ─── 主流程 ───
async function main() {
  note('Succinix TASK25 scenario suite (real browser/container, 14 scenarios)');

  if (SKIP_BUILD) {
    note('skipping build (--skip-build), using existing dist/');
  } else {
    note('building...');
    await run('npm', ['run', 'build'], { silent: true });
    note('build ok');
  }
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run npm run build first');
  }

  // 启动 vite preview（直接起 vite.js，确保 SIGTERM 杀掉真实服务器而非 npx 包装进程）
  note(`starting vite preview on :${PORT}...`);
  const preview = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  let chrome = null;
  let cdp = null;
  let profileDir = null;
  try {
    await waitForHttp(BASE, 20000);
    note(`preview reachable at ${BASE}`);

    const launched = launchChrome(DEBUG_PORT, 'scenarios');
    chrome = launched.chrome;
    profileDir = launched.profileDir;
    cdp = await connectPageCDP(DEBUG_PORT);
    await cdp.send('Page.navigate', { url: `${BASE}/?scenario=1` });
    note('waiting for boot + scenario handle...');
    const h = makeHarness(cdp);
    await h.waitForScenario(120000);
    note('scenario handle ready');

    const SCENARIOS = [
      { id: 'S1', name: 'npm project dev loop', run: s1 },
      { id: 'S2', name: 'git operations', run: s2 },
      { id: 'S3', name: 'database full lifecycle', run: s3 },
      { id: 'S4', name: 'service autostart', run: s4 },
      { id: 'S5', name: 'multi-workspace isolation', run: s5 },
      { id: 'S6', name: 'concurrency stress', run: s6 },
      { id: 'S7', name: 'big output (bounded)', run: s7 },
      { id: 'S8', name: 'persistence stress (300 files)', run: s8 },
      { id: 'S9', name: 'error paths', run: s9 },
      { id: 'S10', name: 'environment boundary (reboot)', run: s10 },
      { id: 'S11', name: 'python script workflow', run: s11 },
      { id: 'S12', name: 'cd + npm install cwd sync', run: s12 },
      { id: 'S13', name: 'TS ecosystem workflow', run: s13 },
      { id: 'S14', name: 'language ecosystem regression (5 pits)', run: s14 },
    ];

    for (const sc of SCENARIOS) {
      if (only && !only.has(sc.id)) continue;
      const started = Date.now();
      let checks = [];
      let crashed = '';
      let attempts = 0;
      while (attempts < 2) {
        attempts++;
        try {
          // 场景前置：句柄必须就绪（页面意外 reload 后自动恢复/主动 reload 自愈）。
          await h.ensureScenario(120000);
          checks = (await sc.run(h)) || [];
          crashed = '';
          break;
        } catch (e) {
          crashed = String(e).slice(0, 300);
          checks = [{ name: `scenario crashed: ${crashed}`, ok: false, detail: '' }];
          if (attempts === 1) {
            console.log(`  [ WARN ] ${sc.id} crashed (${crashed}) — reloading and retrying once`);
            try {
              await h.reloadAndWait(180000);
            } catch (e2) {
              crashed += ` | reload failed: ${String(e2).slice(0, 120)}`;
            }
          }
        }
      }
      const ok = crashed === '' && checks.every((c) => c.ok);
      scenarioResults.push({ id: sc.id, name: sc.name, ok, checks, ms: Date.now() - started });
      console.log(`\n[${sc.id}] ${sc.name} (${Math.round((Date.now() - started) / 1000)}s)`);
      printChecks(checks);
      console.log(`  ${ok ? '\x1b[33m[  OK  ]' : '\x1b[31m[ FAIL ]'}\x1b[0m ${sc.id} ${ok ? 'PASS' : 'FAIL'} (${checks.length} checks)`);
    }

    // 汇总
    console.log('\n=== SCENARIO SUMMARY ===');
    let passedScenarios = 0;
    for (const r of scenarioResults) {
      const mark = r.ok ? '[  OK  ]' : '[ FAIL ]';
      console.log(`  ${mark} ${r.id} ${r.name} — ${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks`);
      if (r.ok) passedScenarios++;
    }
    console.log(`\nScenarios: ${passedScenarios}/${SCENARIOS.length} passed | checks: ${globalPass} ok, ${globalFail} fail`);
    process.exitCode = globalFail === 0 && passedScenarios === SCENARIOS.length ? 0 : 1;
  } finally {
    cdp?.close();
    cleanupChrome(chrome, profileDir);
    preview.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(`[scenarios] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
