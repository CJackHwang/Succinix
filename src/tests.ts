// 自动化系统自检（?test=1 时自动运行，boot diagnostics 风格，英文）。
// 断言逻辑与 TASK2 保持一致，只改输出表现形态：专业自检流程而非测试列表。
import type { Terminal } from '@xterm/xterm';
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from './terminal-client.js';
import { saveSnapshot, loadSnapshot } from './persist.js';

export interface TestContext {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
  term: Terminal;
}

export interface TestResult {
  pass: number;
  fail: number;
  skip: number;
}

const AMBER = '\x1b[33m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
let skip = 0;

// 断言结果行：[ OK ] 暗橙 / [ FAIL ] 暗红，带关键值（pid/版本/端口）。
function verdict(term: Terminal, category: string, name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    term.writeln(`${AMBER}[  OK  ]${RESET} ${category}: ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    fail++;
    term.writeln(`${RED}[ FAIL ]${RESET} ${category}: ${name}${detail ? ` (${detail})` : ''}`);
  }
}

// 已知边界（CORS/网络/symlink）：不算失败，单独计 skip。
function boundary(term: Terminal, category: string, name: string, detail = ''): void {
  skip++;
  term.writeln(`${GRAY}[SKIP]${RESET} ${category}: ${name}${detail ? ` (${detail})` : ''}`);
}

export async function runTests(ctx: TestContext): Promise<TestResult> {
  const { wc, client, ports, term } = ctx;
  pass = 0;
  fail = 0;
  skip = 0;

  term.writeln('WebUnix self-test — boot diagnostics');
  term.writeln('');

  // ─── 基础协议（Kernel）───
  const p1 = await client.exec('ping');
  verdict(term, 'Kernel', 'host alive (ping/pong)', p1.kind === 'pong');

  const p2 = await client.exec('cwd');
  const hostCwd = String(p2.cwd ?? '');
  verdict(term, 'Kernel', 'unified cwd (process.cwd())', p2.ok && hostCwd.startsWith('/'), hostCwd);

  // ─── 共享文件系统（Filesystem）───
  const fs1 = await client.terminal('cat /workspace/browser-wrote.txt');
  verdict(
    term,
    'Filesystem',
    'browser -> lifo (shared file readable)',
    fs1.ok && fs1.runtime === 'lifo' && String(fs1.stdout ?? '').includes('hello from browser'),
    String(fs1.stdout ?? '').trim().slice(0, 60)
  );

  const fs2 = await client.terminal('echo "persistent-host-write" > /workspace/lifo-wrote.txt');
  const back = await wc.fs.readFile('/lifo-wrote.txt', 'utf8');
  verdict(term, 'Filesystem', 'lifo -> browser (shared file writable)', fs2.ok && back.trim() === 'persistent-host-write', JSON.stringify(back.trim()));

  const fs3 = await client.terminal('node -e "console.log(process.cwd())"');
  verdict(term, 'Filesystem', 'node child cwd unified', fs3.ok && String(fs3.stdout ?? '').trim() === hostCwd, String(fs3.stdout ?? '').trim());

  const fs4a = await client.terminal('cd /workspace');
  const fs4b = await client.terminal('pwd');
  verdict(term, 'Filesystem', 'lifo cwd persists across commands', fs4a.ok && fs4b.ok && String(fs4b.stdout ?? '').trim() === '/workspace', String(fs4b.stdout ?? '').trim());

  // ─── 持久化（Persistence）───
  // 自检会真实写入快照 —— 这是特性（自检也验证了持久化）。断言放 Filesystem 区。
  const pers1 = await saveSnapshot(wc.fs);
  verdict(term, 'Persistence', 'snapshot saved', pers1.fileCount > 0, `${pers1.fileCount} files`);

  const pers2 = await loadSnapshot(wc.fs);
  const restoredText = pers2 ? await wc.fs.readFile('/browser-wrote.txt', 'utf8') : '';
  const loadable = !!pers2 && pers2.fileCount === pers1.fileCount && restoredText.includes('hello from browser');
  verdict(term, 'Persistence', 'snapshot loadable', loadable, pers2 ? `restored ${pers2.fileCount} files` : 'no snapshot to restore');

  // ─── TerminalExecutor 统一路由（Executor / Process table / Port registry）───
  const te1 = await client.terminal('node -e "console.log(21*2)"');
  verdict(
    term,
    'Executor',
    'node child process (stdout/stderr/exit)',
    te1.ok && String(te1.stdout ?? '').trim() === '42' && te1.runtime === 'node',
    `runtime=${te1.runtime} stdout=${String(te1.stdout ?? '').trim()}`
  );

  const te2 = await client.terminal('npm --version');
  verdict(term, 'Executor', 'npm resolution (PATH ok)', te2.ok && te2.runtime === 'node', `runtime=${te2.runtime} version=${String(te2.stdout ?? '').trim().slice(0, 30)}`);

  const te3 = await client.terminal('grep -i lifo /workspace/browser-wrote.txt');
  verdict(
    term,
    'Executor',
    'lifo routing (grep)',
    te3.ok && te3.runtime === 'lifo' && String(te3.stdout ?? '').toLowerCase().includes('lifo'),
    `runtime=${te3.runtime} ${String(te3.stdout ?? '').trim().slice(0, 50)}`
  );

  const te4 = await client.terminal('ps');
  const procs: Array<Record<string, unknown>> = Array.isArray(te4.processes) ? te4.processes : [];
  const nodeProc = procs.find((pr) => String(pr.cmd ?? '').startsWith('node'));
  verdict(term, 'Process table', 'ps lists node child', !!nodeProc && Number(nodeProc.pid) > 0, nodeProc ? `pid=${nodeProc.pid} "${nodeProc.cmd}" [${nodeProc.status}]` : 'no node child found');

  const te5 = await client.terminal('cat /workspace/browser-wrote.txt | wc -c');
  verdict(term, 'Executor', 'lifo routing (cat|wc)', te5.ok && te5.runtime === 'lifo' && String(te5.stdout ?? '').trim() === '74', `runtime=${te5.runtime} stdout=${String(te5.stdout ?? '').trim()}`);

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
    verdict(term, 'Process table', 'kill long-running node', k.ok && k.killed === true, `pid=${longProc.pid} ${k.message ?? ''}`);
    await sleep(300);
    const psAfterKill = await client.terminal('ps');
    const after = (psAfterKill.processes ?? []).find((pr: any) => pr.pid === longProc.pid);
    verdict(term, 'Process table', 'kill marks exited', !after || after.status === 'exited', JSON.stringify(after ?? `pid=${longProc.pid} no longer in table`));
  } else {
    verdict(term, 'Process table', 'kill long-running node', false, 'no long-running node child found via ps');
  }

  // ─── T15: spawn 后台 http 服务完整链路 ───
  let spawnPid = 0;
  try {
    const sp = await client.spawn('node -e "http.createServer((q,s)=>s.end(\'hello-port\')).listen(3456)"');
    verdict(term, 'Process table', 'spawn returns pid', sp.ok === true && Number(sp.pid) > 0, `pid=${sp.pid} runtime=${sp.runtime}`);
    spawnPid = Number(sp.pid);

    const ps1 = await client.terminal('ps');
    const spProc = (ps1.processes ?? []).find((pr: any) => pr.pid === spawnPid);
    verdict(term, 'Process table', 'spawned process visible running', !!spProc && spProc.status === 'running', JSON.stringify(spProc ?? `pid=${spawnPid} not found`));

    // 等 server-ready → 端口注册表出现 3456
    let previewUrl = ports.get(3456);
    const deadline = Date.now() + 20000;
    while (!previewUrl && Date.now() < deadline) {
      await sleep(300);
      previewUrl = ports.get(3456);
    }
    verdict(term, 'Port registry', 'server-ready detection', !!previewUrl, previewUrl ?? 'no server-ready within 20s');

    if (previewUrl) {
      try {
        const resp = await fetch(previewUrl);
        const text = await resp.text();
        verdict(term, 'Network', 'direct fetch preview URL', resp.ok && text === 'hello-port', `status=${resp.status} body=${JSON.stringify(text)}`);
      } catch (e) {
        boundary(term, 'Network', 'direct fetch preview URL', `CORS — expected boundary: ${String(e).slice(0, 60)}`);
      }
    }
  } catch (e) {
    verdict(term, 'Process table', 'spawn/http chain', false, String(e).slice(0, 120));
  }

  // kill → 进程表变 exited
  if (spawnPid > 0) {
    const k2 = await client.terminal(`kill ${spawnPid}`);
    await sleep(400);
    const ps2 = await client.terminal('ps');
    const afterKill = (ps2.processes ?? []).find((pr: any) => pr.pid === spawnPid);
    const killedOk = k2.ok && k2.killed === true && (!afterKill || afterKill.status === 'exited');
    verdict(term, 'Process table', 'spawn/kill lifecycle', killedOk, `killed=${k2.killed} status=${afterKill ? afterKill.status : 'no longer in table'}`);
  }

  // ─── 已知边界（网络/生态，仅供参考，计入 skipped）───
  try {
    const b1 = await client.terminal('curl -s -m 12 https://example.com', undefined, 20000);
    boundary(term, 'Network', 'curl example.com', `known boundary: external net exit=${b1.exitCode} ${String(b1.stdout || b1.stderr || '').slice(0, 40)}`);
  } catch (e) {
    boundary(term, 'Network', 'curl example.com', `known boundary: external net ${String(e).slice(0, 60)}`);
  }
  try {
    const b2 = await client.terminal('curl -s -m 20 https://r.jina.ai/https://example.com', undefined, 25000);
    boundary(term, 'Network', 'curl via r.jina.ai', `known boundary: external net ok=${b2.ok} ${String(b2.stdout || b2.stderr || '').slice(0, 40)}`);
  } catch (e) {
    boundary(term, 'Network', 'curl via r.jina.ai', `known boundary: external net ${String(e).slice(0, 60)}`);
  }
  try {
    const b3 = await client.terminal('lifo search git', undefined, 20000);
    boundary(term, 'Kernel', 'lifo search git', `known boundary: ecosystem ok=${b3.ok} ${String(b3.stdout || b3.stderr || '').slice(0, 40)}`);
  } catch (e) {
    boundary(term, 'Kernel', 'lifo search git', `known boundary: ecosystem ${String(e).slice(0, 60)}`);
  }
  try {
    const b4 = await client.terminal('ln -s /workspace/browser-wrote.txt /workspace/mylink.txt && ls -la /workspace');
    boundary(term, 'Filesystem', 'symlink fallback', `known boundary: degraded ok=${b4.ok} ${String(b4.stdout || b4.stderr || '').slice(0, 60)}`);
  } catch (e) {
    boundary(term, 'Filesystem', 'symlink fallback', `known boundary: degraded ${String(e).slice(0, 60)}`);
  }

  // ─── 优雅退出 ───
  const pEnd = await client.terminal('exit');
  verdict(term, 'Kernel', 'exit handshake', pEnd.kind === 'bye');

  // ─── 汇总行 ───
  term.writeln('');
  term.writeln(`Self-test result: ${pass} passed, ${fail} failed, ${skip} skipped`);

  return { pass, fail, skip };
}
