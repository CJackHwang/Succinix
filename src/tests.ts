// 自动化测试套件（?test=1 时自动运行，结果打印到终端）。
// 现有 14 项（基础协议 / 共享文件系统 / 统一路由）+ T15 spawn 后台服务完整链路。
import type { Terminal } from '@xterm/xterm';
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from './terminal-client.js';

export interface TestContext {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
  term: Terminal;
}

export interface TestResult {
  pass: number;
  fail: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;

function verdict(term: Terminal, name: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else fail++;
  term.writeln(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function section(term: Terminal, title: string): void {
  term.writeln(`\n── ${title} ──`);
}

export async function runTests(ctx: TestContext): Promise<TestResult> {
  const { wc, client, ports, term } = ctx;
  pass = 0;
  fail = 0;

  // ─── 基础协议 ───
  section(term, '基础协议');
  const p1 = await client.exec('ping');
  verdict(term, 'P1 ping', p1.kind === 'pong');

  const p2 = await client.exec('cwd');
  const hostCwd = String(p2.cwd ?? '');
  verdict(term, 'P2 cwd（统一 cwd = process.cwd()）', p2.ok && hostCwd.startsWith('/'), hostCwd);

  // ─── 共享文件系统（已实测结论，回归验证）───
  section(term, '共享文件系统');
  const fs1 = await client.terminal('cat /workspace/browser-wrote.txt');
  verdict(
    term,
    'FS1 lifo 读浏览器文件',
    fs1.ok && fs1.runtime === 'lifo' && String(fs1.stdout ?? '').includes('hello from browser'),
    String(fs1.stdout ?? '').trim().slice(0, 60)
  );

  const fs2 = await client.terminal('echo "persistent-host-write" > /workspace/lifo-wrote.txt');
  const back = await wc.fs.readFile('/lifo-wrote.txt', 'utf8');
  verdict(term, 'FS2 浏览器读回 lifo 写的文件', fs2.ok && back.trim() === 'persistent-host-write', JSON.stringify(back.trim()));

  const fs3 = await client.terminal('node -e "console.log(process.cwd())"');
  verdict(term, 'FS3 node 子进程 cwd 与 host 统一', fs3.ok && String(fs3.stdout ?? '').trim() === hostCwd, String(fs3.stdout ?? '').trim());

  const fs4a = await client.terminal('cd /workspace');
  const fs4b = await client.terminal('pwd');
  verdict(term, 'FS4 lifo cwd 跨命令持久', fs4a.ok && fs4b.ok && String(fs4b.stdout ?? '').trim() === '/workspace', String(fs4b.stdout ?? '').trim());

  // ─── TerminalExecutor 统一路由 ───
  section(term, 'TerminalExecutor 统一路由');

  const te1 = await client.terminal('node -e "console.log(21*2)"');
  verdict(
    term,
    'TE1 node -e 21*2 → stdout=42 / runtime=node',
    te1.ok && String(te1.stdout ?? '').trim() === '42' && te1.runtime === 'node',
    `runtime=${te1.runtime} stdout=${String(te1.stdout ?? '').trim()}`
  );

  const te2 = await client.terminal('npm --version');
  verdict(term, 'TE2 npm --version → runtime=node', te2.ok && te2.runtime === 'node', `runtime=${te2.runtime} ${String(te2.stdout ?? '').trim().slice(0, 30)}`);

  const te3 = await client.terminal('grep -i lifo /workspace/browser-wrote.txt');
  verdict(
    term,
    'TE3 grep -i lifo → runtime=lifo',
    te3.ok && te3.runtime === 'lifo' && String(te3.stdout ?? '').toLowerCase().includes('lifo'),
    `runtime=${te3.runtime} ${String(te3.stdout ?? '').trim().slice(0, 50)}`
  );

  const te4 = await client.terminal('ps');
  const procs: Array<Record<string, unknown>> = Array.isArray(te4.processes) ? te4.processes : [];
  const nodeProc = procs.find((pr) => String(pr.cmd ?? '').startsWith('node'));
  verdict(term, 'TE4 ps 列出 node 子进程', !!nodeProc && Number(nodeProc.pid) > 0, nodeProc ? `pid=${nodeProc.pid} "${nodeProc.cmd}" [${nodeProc.status}]` : '未找到 node 子进程');

  const te5 = await client.terminal('cat /workspace/browser-wrote.txt | wc -c');
  verdict(term, 'TE5 管道 cat|wc → runtime=lifo / 74', te5.ok && te5.runtime === 'lifo' && String(te5.stdout ?? '').trim() === '74', `runtime=${te5.runtime} stdout=${String(te5.stdout ?? '').trim()}`);

  try {
    await client.terminal('node -e "setInterval(()=>{},1000)"', undefined, 1500); // 预期超时：命令未结束
  } catch {
    /* 预期行为：浏览器侧先超时，host 子进程仍在进程表里 */
  }
  const psAfterStart = await client.terminal('ps');
  const longProc = (psAfterStart.processes ?? []).find(
    (pr: any) => String(pr.cmd ?? '').startsWith('node') && pr.status === 'running'
  );
  if (longProc) {
    const k = await client.terminal(`kill ${longProc.pid}`);
    verdict(term, 'TE6 kill 长驻 node 子进程', k.ok && k.killed === true, `pid=${longProc.pid} ${k.message ?? ''}`);
    await sleep(300);
    const psAfterKill = await client.terminal('ps');
    const after = (psAfterKill.processes ?? []).find((pr: any) => pr.pid === longProc.pid);
    verdict(term, 'TE6b kill 后进程状态为 exited', !after || after.status === 'exited', JSON.stringify(after ?? `pid=${longProc.pid} 已不在表中`));
  } else {
    verdict(term, 'TE6 kill 长驻 node 子进程', false, 'ps 未找到长驻 node 子进程');
  }

  // ─── T15: spawn 后台 http 服务完整链路 ───
  section(term, 'T15 spawn 后台服务');
  let spawnPid = 0;
  try {
    const sp = await client.spawn('node -e "http.createServer((q,s)=>s.end(\'hello-port\')).listen(3456)"');
    verdict(term, 'T15a spawn 返回 pid', sp.ok === true && Number(sp.pid) > 0, `pid=${sp.pid} runtime=${sp.runtime}`);
    spawnPid = Number(sp.pid);

    const ps1 = await client.terminal('ps');
    const spProc = (ps1.processes ?? []).find((pr: any) => pr.pid === spawnPid);
    verdict(term, 'T15b ps 可见后台进程 running', !!spProc && spProc.status === 'running', JSON.stringify(spProc ?? `pid=${spawnPid} 未找到`));

    // 等 server-ready → 端口注册表出现 3456
    let previewUrl = ports.get(3456);
    const deadline = Date.now() + 20000;
    while (!previewUrl && Date.now() < deadline) {
      await sleep(300);
      previewUrl = ports.get(3456);
    }
    verdict(term, 'T15c ports 注册表出现 3456', !!previewUrl, previewUrl ?? '20 秒内未收到 server-ready');

    if (previewUrl) {
      const resp = await fetch(previewUrl);
      const text = await resp.text();
      verdict(term, 'T15d 浏览器 fetch 预览 URL 得到 hello-port', resp.ok && text === 'hello-port', `status=${resp.status} body=${JSON.stringify(text)}`);
    }
  } catch (e) {
    verdict(term, 'T15 链路异常', false, String(e).slice(0, 120));
  }

  // kill → 进程表变 exited
  if (spawnPid > 0) {
    const k2 = await client.terminal(`kill ${spawnPid}`);
    await sleep(400);
    const ps2 = await client.terminal('ps');
    const afterKill = (ps2.processes ?? []).find((pr: any) => pr.pid === spawnPid);
    const killedOk = k2.ok && k2.killed === true && (!afterKill || afterKill.status === 'exited');
    verdict(term, 'T15e kill 后进程表变 exited', killedOk, `killed=${k2.killed} status=${afterKill ? afterKill.status : '已不在表中'}`);
  }

  // ─── 已知边界（网络/生态，仅供参考，不计入 PASS/FAIL）───
  section(term, '已知边界（仅供参考）');
  try {
    const b1 = await client.terminal('curl -s -m 12 https://example.com', undefined, 20000);
    term.writeln(`ℹ️ B1 curl 直连 example.com → exit=${b1.exitCode} ok=${b1.ok} ${String(b1.stdout || b1.stderr || '').slice(0, 60)}`);
  } catch (e) {
    term.writeln(`ℹ️ B1 curl 直连 example.com → ${String(e).slice(0, 80)}`);
  }
  try {
    const b2 = await client.terminal('curl -s -m 20 https://r.jina.ai/https://example.com', undefined, 25000);
    term.writeln(`ℹ️ B2 curl 走 r.jina.ai → ok=${b2.ok} ${String(b2.stdout || b2.stderr || '').slice(0, 60)}`);
  } catch (e) {
    term.writeln(`ℹ️ B2 curl 走 r.jina.ai → ${String(e).slice(0, 80)}`);
  }
  try {
    const b3 = await client.terminal('lifo search git', undefined, 20000);
    term.writeln(`ℹ️ B3 lifo search git → ok=${b3.ok} ${String(b3.stdout || b3.stderr || '').slice(0, 60)}`);
  } catch (e) {
    term.writeln(`ℹ️ B3 lifo search git → ${String(e).slice(0, 80)}`);
  }
  try {
    const b4 = await client.terminal('ln -s /workspace/browser-wrote.txt /workspace/mylink.txt && ls -la /workspace');
    term.writeln(`ℹ️ B4 symlink 降级 → ok=${b4.ok} ${String(b4.stdout || b4.stderr || '').slice(0, 80)}`);
  } catch (e) {
    term.writeln(`ℹ️ B4 symlink 降级 → ${String(e).slice(0, 80)}`);
  }

  // ─── 优雅退出 ───
  const pEnd = await client.terminal('exit');
  verdict(term, 'P3 exit 握手', pEnd.kind === 'bye');

  return { pass, fail };
}
