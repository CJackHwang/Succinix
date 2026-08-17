// 场景套件：基础工作流（O11 拆分自 scenarios.mjs）。
import { check, note, sleep } from '../lib/harness.mjs';

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

async function s2(h) {
  const checks = [];
  // 1. 直接走 WebContainer host 的 Isomorphic Git adapter，不能被第三方 lifo-pkg-git 覆盖。
  await h.run('mkdir -p /workspace/s2-git');
  await h.run('cd /workspace/s2-git');
  const w = await h.run('echo "s2-file-content" > README.md');
  check(checks, 'write file in git dir', w.ok === true, `ok=${w.ok}`);

  // 2. 本地 Git 工作流。
  const gi = await h.run('git init');
  check(checks, 'git init', gi.ok === true, String(gi.stdout || gi.stderr || '').trim().slice(0, 80));

  const ga = await h.run('git add README.md');
  check(checks, 'git add', ga.ok === true, `ok=${ga.ok}`);
  const gc = await h.run('git commit -m "s2 initial commit"');
  check(checks, 'git commit', gc.ok === true, String(gc.stdout || gc.stderr || '').trim().slice(0, 120));

  const gb = await h.run('git branch s2-feature');
  const gco = await h.run('git checkout s2-feature');
  check(checks, 'git branch and checkout', gb.ok === true && gco.ok === true && String(gco.stdout).includes('s2-feature'), String(gco.stdout || gco.stderr || '').trim());

  const gl = await h.run('git log --oneline');
  const logOut = String(gl.stdout || '');
  check(checks, 'git log shows commit hash', gl.ok === true && /[0-9a-f]{7,}/i.test(logOut), logOut.trim().slice(0, 80));

  // 3. 脚本入口与直接命令共享相同的 here-document 能力边界。
  await h.evalValue(`window.__succinixScenario.wc.fs.writeFile('/s2-git/s2-heredoc.sh', ${JSON.stringify('#!/bin/sh\ncat <<EOF\ns2\nEOF\n')})`);
  const scriptResults = [];
  for (const command of ['sh s2-heredoc.sh', 'bash s2-heredoc.sh', './s2-heredoc.sh']) scriptResults.push(await h.run(command));
  check(
    checks,
    'script here-document has stable unsupported contract',
    scriptResults.every((result) => result.exitCode === 2 && String(result.stderr).includes('here-document: unsupported')),
    scriptResults.map((result) => `${result.exitCode}:${String(result.stderr).trim()}`).join(' | '),
  );

  // 4. HTTPS smart-Git 经过真实 WebContainer 网络与 CORS proxy；远端只读，避免外部写入。
  const clone = await h.run('git clone https://github.com/octocat/Hello-World.git /workspace/s2-remote', 30000);
  check(checks, 'git clone HTTPS remote', clone.ok === true, String(clone.stdout || clone.stderr || '').trim().slice(-160));
  await h.run('cd /workspace/s2-remote');
  const fetch = await h.run('git fetch', 30000);
  const pull = await h.run('git pull', 30000);
  check(
    checks,
    'git fetch and pull HTTPS remote',
    fetch.ok === true && pull.ok === true,
    `fetch=${fetch.ok} ${String(fetch.stderr || fetch.stdout || '').trim().slice(-80)} pull=${pull.ok} ${String(pull.stderr || pull.stdout || '').trim().slice(-120)}`,
  );

  // 5. SSH、token 和直接命令的 here-document 都有可重复的边界合同。
  const ssh = await h.run('git clone git@github.com:octocat/Hello-World.git');
  check(checks, 'git SSH fails closed', ssh.exitCode === 126 && String(ssh.stderr).includes('SSH transport is unsupported'), String(ssh.stderr).trim());
  await h.run('env GIT_HTTP_TOKEN=s2-private-token');
  const envFile = await h.evalValue("window.__succinixScenario.wc.fs.readFile('/etc/succinix.env','utf8').catch(()=>'')");
  check(checks, 'git token never enters persisted environment', !String(envFile).includes('s2-private-token'), String(envFile).slice(0, 80));
  const heredoc = await h.run('cat <<EOF\ns2\nEOF');
  check(checks, 'here-document has stable unsupported contract', heredoc.exitCode === 2 && String(heredoc.stderr).includes('here-document: unsupported'), String(heredoc.stderr).trim());

  // 清理。
  await h.run('cd /');
  await h.run('rm -rf /workspace/s2-git /workspace/s2-remote');
  await h.evalValue("window.__succinixScenario.wc.fs.rm('/s2-git/s2-heredoc.sh').catch(() => undefined)");
  return checks;
}

export const scenarios = [
  { id: 'S1', name: 'npm project dev loop', run: s1 },
  { id: 'S2', name: 'git operations', run: s2 },
];
