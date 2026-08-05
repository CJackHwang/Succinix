#!/usr/bin/env node
// WebUnix TASK19 高级复杂功能场景测试：headless Chrome + CDP 驱动真实工作流。
// 零新依赖（仿 verify-deploy.mjs / bench.mjs 的 CDP 模式）。每个场景真实执行、真实断言：
//   S1 npm 项目开发闭环       S2 git 操作            S3 数据库全生命周期
//   S4 服务自启               S5 多工作区隔离        S6 并发压力
//   S7 大输出                 S8 持久化压力          S9 错误路径
//   S10 环境边界（reboot）
//
// 用法：
//   node scripts/scenarios.mjs [--skip-build] [--port 7895]
//   （默认先 npm run build 再用 vite preview 托管 dist/；--skip-build 要求 dist/ 已是最新。）
//
// 页面驱动：?scenario=1 时 main.ts 暴露 window.__webunixScenario = { run, client, wc, ports, saveSnapshot }，
// run(cmd) 走与真实终端 execute() 相同的分发路径（browser 拦截 → host RPC），输出结构化返回。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const portIdx = args.indexOf('--port');
// 7897 被本机 Clash 代理占用，scenarios 用 7895/7896（与 verify 7892 / bench 7894 错开）。
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 7895;
// --only S1,S4：只跑指定场景（调试用）。
const only = args.includes('--only') ? new Set((args[args.indexOf('--only') + 1] ?? '').split(',')) : null;
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

// tinbase 固定开发 key（well-known Supabase 本地 demo keys，README 注明确定性）。
const TINBASE_SERVICE_ROLE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ─── 最小 CDP 客户端（同 verify-deploy.mjs，无新依赖）───
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

async function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

async function launchChrome() {
  const chromePath = await findChrome();
  if (!chromePath) throw new Error('headless Chrome not found');
  const profileDir = mkdtempSync(join(tmpdir(), 'webunix-scenarios-'));
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
  return { chrome, profileDir };
}

async function connectCDP() {
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
  if (!versionUrl) throw new Error(`Chrome DevTools endpoint did not come up on :${DEBUG_PORT}`);

  let pageUrl = '';
  for (let i = 0; i < 20 && !pageUrl; i++) {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    pageUrl = (list.find((t) => t.type === 'page') || {}).webSocketDebuggerUrl || '';
    if (!pageUrl) await sleep(200);
  }
  if (!pageUrl) throw new Error('no page target available via CDP');

  const cdp = new CDP(pageUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

// 在页面里跑一个 async 表达式并取回 by-value 结果。
async function evalValue(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown';
    throw new Error(`page eval failed: ${desc.slice(0, 400)}`);
  }
  return res.result.value;
}

// ─── 场景句柄（给每个场景的驱动器）───
function makeHarness(cdp) {
  const h = {
    cdp,
    // 在页面里执行表达式（awaitPromise），返回 by-value。
    async evalValue(expression) {
      return evalValue(cdp, expression);
    },
    // 跑一条真实命令：与终端 execute() 同分发路径（browser 拦截 → host RPC）。
    async run(cmd, timeoutMs) {
      const expr = `(async () => JSON.stringify(await window.__webunixScenario.run(${JSON.stringify(cmd)}, ${timeoutMs ?? 'undefined'})))()`;
      return JSON.parse(await evalValue(cdp, expr));
    },
    // spawn 后台进程（真实 client.spawn 路径）。
    async spawn(cmd) {
      const expr = `(async () => JSON.stringify(await window.__webunixScenario.client.spawn(${JSON.stringify(cmd)})))()`;
      return JSON.parse(await evalValue(cdp, expr));
    },
    // 轮询页面条件，满足返回真值；超时抛错。
    async waitFor(condExpr, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        try {
          const v = await evalValue(cdp, condExpr);
          if (v) return v;
          last = v;
        } catch (e) {
          last = e;
        }
        await sleep(300);
      }
      throw new Error(`waitFor timeout: ${condExpr} (last=${String(last).slice(0, 120)})`);
    },
    // 等场景句柄就绪（初次导航后 / 每次 reload 后）。句柄在 boot 完成时注册。
    async waitForScenario(timeoutMs = 120000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const v = await evalValue(cdp, '!!window.__webunixScenario && window.__webunixScenario.booted === true');
          if (v) return;
        } catch {
          /* 导航期间上下文销毁：下一轮再试 */
        }
        await sleep(400);
      }
      throw new Error(`scenario handle did not become ready within ${timeoutMs}ms`);
    },
    // 刷新页面（保持 ?scenario=1），等重新 boot + 句柄就绪。
    async reloadAndWait(timeoutMs = 120000) {
      try {
        await cdp.send('Page.reload', { ignoreCache: true });
      } catch {
        /* 导航中 */
      }
      await h.waitForScenario(timeoutMs);
    },
  };
  return h;
}

// ─── S1：npm 项目开发闭环 ───
async function s1(h) {
  const checks = [];
  const PORT_S1 = 3461;
  // 1. npm init -y（真实 node 子进程，cwd = 容器项目主目录 = 浏览器根）
  const init = await h.run('npm init -y', 120000);
  check(checks, 'npm init -y succeeds', init.ok === true && init.runtime === 'node', `ok=${init.ok} runtime=${init.runtime}`);
  const pkg = await h.evalValue(`window.__webunixScenario.wc.fs.readFile('/package.json','utf8').catch(()=>'')`);
  check(checks, 'package.json artifact real', typeof pkg === 'string' && pkg.includes('"name"'), pkg.slice(0, 60));

  // 2. 写 server.js（http 服务，带 CORS 头使浏览器可直取预览 URL）
  const serverJs = `const http=require('http');http.createServer((q,s)=>{s.setHeader('Access-Control-Allow-Origin','*');s.end('s1-http-ok')}).listen(${PORT_S1})`;
  await h.evalValue(`window.__webunixScenario.wc.fs.writeFile('/server.js', ${JSON.stringify(serverJs)})`);

  // 3. node 启动后台
  const sp = await h.spawn('node server.js');
  check(checks, 'node server spawn returns pid', sp.ok === true && Number(sp.pid) > 0, `pid=${sp.pid} runtime=${sp.runtime}`);

  // 4. 等端口就绪 → 预览 URL 真实注册
  const url = await h.waitFor(`window.__webunixScenario.ports.get(${PORT_S1}) || null`, 20000);
  check(checks, 'server-ready -> preview URL registered', typeof url === 'string' && /^https?:\/\//.test(url), url);

  // 5. 真实 HTTP 200：node 子进程在容器内 fetch 预览 URL（容器内无 CORS 限制，走 WebContainer
  //    预览代理回到 server 的 127.0.0.1 端口）。浏览器直取预览 URL 是 AGENTS.md 已知 CORS 边界，
  //    一并记录证据但不作判定。
  const httpRes = await h.evalValue(`(async () => {
    const out = {};
    const url = ${JSON.stringify(url)};
    const fetchScript = 'node -e "fetch(process.argv[1]).then(async r=>console.log(r.status+\\' \\'+await r.text())).catch(e=>console.log(\\'ERR \\'+e.message))"';
    try {
      const r = await window.__webunixScenario.client.terminal(fetchScript + ' ' + url, undefined, 20000);
      out.preview = { ok: r.ok, stdout: String(r.stdout || '') };
    } catch (e) { out.preview = { ok: false, error: String(e) }; }
    try {
      const r = await window.__webunixScenario.client.terminal('node -e "fetch(\\'http://127.0.0.1:${PORT_S1}\\').then(async r=>console.log(r.status+\\' \\'+await r.text()))"', undefined, 15000);
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
  await h.evalValue(`(async () => { const fs = window.__webunixScenario.wc.fs; for (const f of ['/server.js','/package.json','/package-lock.json']) { try { await fs.rm(f); } catch {} } return true; })()`);
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
  await h.run('git config user.email "s2@webunix.dev"');
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
  const url = await h.waitFor('window.__webunixScenario.ports.get(3001) || null', 15000);
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
  await h.evalValue(`window.__webunixScenario.wc.fs.writeFile('/s3-db.mjs', ${JSON.stringify(script)})`);
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
  await h.evalValue(`window.__webunixScenario.wc.fs.writeFile('/s3-read.mjs', ${JSON.stringify(readScript)})`);
  const r2 = await h.run('node s3-read.mjs', 60000);
  const so2 = String(r2.stdout || '');
  check(checks, 'data persists across db restart', r2.ok === true && so2.includes('READ_STATUS=200') && so2.includes('s3-persist-marker'), so2.trim().slice(0, 160));

  // 清理
  await h.run('db stop');
  await h.evalValue(`(async () => { const fs = window.__webunixScenario.wc.fs; for (const f of ['/s3-db.mjs','/s3-read.mjs']) { try { await fs.rm(f); } catch {} } return true; })()`);
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
    const fs = window.__webunixScenario.wc.fs;
    let entries = [];
    try { entries = await fs.readdir('/ws', { withFileTypes: true }); } catch (e) { return 'NO_WS: ' + String(e); }
    return entries.map((e) => e.name + (e.isDirectory() ? '/' : '')).join(',');
  })()`);
  note(`[S5] /ws at start: ${wsInit}`);
  await h.run('workspace create proj-a');
  await h.run('workspace create proj-b');
  await h.run('workspace switch proj-a');
  await h.evalValue(`window.__webunixScenario.wc.fs.writeFile('/ws/proj-a/a.txt','a-file-content')`);

  await h.run('workspace switch proj-b');
  const aInB = await h.evalValue(`window.__webunixScenario.wc.fs.readFile('/ws/proj-b/a.txt','utf8').then(()=>true).catch(()=>false)`);
  check(checks, 'proj-b does not see proj-a file', aInB === false, `a.txt visible in proj-b: ${aInB}`);
  await h.evalValue(`window.__webunixScenario.wc.fs.writeFile('/ws/proj-b/b.txt','b-file-content')`);

  await h.run('workspace switch proj-a');
  const aTxt = await h.evalValue(`window.__webunixScenario.wc.fs.readFile('/ws/proj-a/a.txt','utf8').catch(()=>'MISSING')`);
  check(checks, 'proj-a file intact after switch', aTxt === 'a-file-content', aTxt);
  const bInA = await h.evalValue(`window.__webunixScenario.wc.fs.readFile('/ws/proj-a/b.txt','utf8').then(()=>true).catch(()=>false)`);
  check(checks, 'proj-a does not see proj-b file', bInA === false, `b.txt visible in proj-a: ${bInA}`);

  // 刷新后状态保留
  await h.reloadAndWait(120000);
  const wsDiag = await h.evalValue(`(async () => {
    const fs = window.__webunixScenario.wc.fs;
    let entries = [];
    try { entries = await fs.readdir('/ws', { withFileTypes: true }); } catch (e) { return 'NO_WS: ' + String(e); }
    return entries.map((e) => e.name + (e.isDirectory() ? '/' : '')).join(',');
  })()`);
  note(`[S5] /ws after refresh: ${wsDiag}`);
  const cur = await h.evalValue(`window.__webunixScenario.wc.fs.readFile('/ws/.current','utf8').catch(()=>'')`);
  check(checks, 'current workspace retained after refresh', cur.trim() === 'proj-a', `current=${cur.trim()}`);
  const aAfter = await h.evalValue(`window.__webunixScenario.wc.fs.readFile('/ws/proj-a/a.txt','utf8').catch(()=>'MISSING')`);
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

// ─── S6：并发压力 ───
async function s6(h) {
  const checks = [];
  const expr = `(async () => {
    const s = window.__webunixScenario;
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
  check(checks, '3 concurrent long commands all return', allOk, `ok=${results.map((r) => r.ok).join(',')}`);
  const outs = results.map((r) => r.stdout);
  const noInterleave =
    outs[0] === 'OUT-A' && outs[1] === 'OUT-B' && outs[2] === 'OUT-C';
  check(checks, 'results not interleaved (per-id correct)', noInterleave, JSON.stringify(outs));
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
    const fs = window.__webunixScenario.wc.fs;
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
    const fs = window.__webunixScenario.wc.fs;
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
  await h.evalValue(`window.__webunixScenario.wc.fs.rm('/pstress', { recursive: true, force: true })`);
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
  await h.evalValue(`window.__webunixScenario.wc.fs.writeFile('/s10-marker.txt','s10-survives')`);
  await h.run('snapshot now', 60000);

  // reboot → 页面真实 reload
  const rb = await h.run('reboot', 10000);
  check(checks, 'reboot triggered', rb.handled === true && rb.output.includes('Rebooting'), rb.output ? rb.output.trim() : '');

  // 等 reload + 重新 boot + 句柄就绪
  await h.waitForScenario(120000);

  // 文件仍在
  const m = await h.evalValue(`window.__webunixScenario.wc.fs.readFile('/s10-marker.txt','utf8').catch(()=>'MISSING')`);
  check(checks, 'file survives reboot', m === 's10-survives', m);

  // 服务状态合理：进程表可用且干净（无孤儿 running）
  const ps = await h.run('ps');
  const procs = Array.isArray(ps.processes) ? ps.processes : [];
  const running = procs.filter((p) => p.status === 'running');
  check(checks, 'process table clean after reboot', Array.isArray(procs) && running.length === 0, `total=${procs.length} running=${running.length}`);

  // 清理
  await h.evalValue(`window.__webunixScenario.wc.fs.rm('/s10-marker.txt', { force: true })`);
  return checks;
}

// ─── 主流程 ───
async function main() {
  note('WebUnix TASK19 scenario suite (real browser/container, 10 scenarios)');

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

    const launched = await launchChrome();
    chrome = launched.chrome;
    profileDir = launched.profileDir;
    cdp = await connectCDP();
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
    ];

    for (const sc of SCENARIOS) {
      if (only && !only.has(sc.id)) continue;
      const started = Date.now();
      let checks = [];
      let crashed = '';
      try {
        checks = (await sc.run(h)) || [];
      } catch (e) {
        crashed = String(e).slice(0, 300);
        checks = [{ name: `scenario crashed: ${crashed}`, ok: false, detail: '' }];
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
    chrome?.kill('SIGTERM');
    if (profileDir) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* 临时目录清理失败不影响结果 */
      }
    }
    preview.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(`[scenarios] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
