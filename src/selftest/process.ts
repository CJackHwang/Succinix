// 自检域：执行路由 / 进程表 / Shell 融合 / spawn 链路（O5 拆分）。
import { verdict, boundary } from './runner.js';
import type { TestContext } from './runner.js';
import { tokenize } from '@succinix/engine';
import { respawnWithKillFirst } from '../host-restart.js';
import { sleep } from '../util.js';

export async function runProcess(ctx: TestContext): Promise<void> {
  const { client, ports, term } = ctx;
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

  const tableProbe = await client.spawn('node -e "setInterval(()=>{},1000)"');
  const te4 = await client.terminal('ps');
  const procs: Array<Record<string, unknown>> = Array.isArray(te4.processes) ? te4.processes : [];
  const probePid = Number(tableProbe.pid);
  const nodeProc = procs.find((pr) => Number(pr.pid) === probePid && pr.status === 'running');
  verdict(
    term,
    'Process table',
    'ps lists running node child',
    tableProbe.ok === true && probePid > 0 && !!nodeProc,
    nodeProc ? `pid=${nodeProc.pid} "${nodeProc.cmd}" [${nodeProc.status}]` : `pid=${probePid || '?'} not found as running`,
  );
  if (probePid > 0) {
    await client.terminal(`kill ${probePid}`);
    await sleep(300);
  }

  const te5 = await client.terminal('cat /workspace/browser-wrote.txt | wc -c');
  verdict(term, 'Executor', 'lifo routing (cat|wc)', te5.ok && te5.runtime === 'lifo' && String(te5.stdout ?? '').trim() === '74', `runtime=${te5.runtime} stdout=${String(te5.stdout ?? '').trim()}`);

  // ─── Shell 融合（TASK24）：转义引号分词 + node 系命令 shell 元字符回退 ───
  // tokenize 是 host 与浏览器共享的纯函数（src/engine/tokenize.ts）：直接断言 shlex 语义。
  const tk1 = tokenize('node -e "console.log(\\"hi\\")"');
  const tkInner = tk1[0] === 'node' && tk1[1] === '-e' && tk1[2] === 'console.log("hi")';
  const tkSpace = tokenize('echo "a b"');
  const tkEsc = tokenize('echo "a\\"b"');
  let tkUnterminated = false;
  try {
    tokenize('echo "unterminated');
  } catch {
    tkUnterminated = true;
  }
  verdict(
    term,
    'Shell',
    'tokenize escape quotes',
    tkInner && tkSpace.length === 2 && tkSpace[1] === 'a b' && tkEsc[1] === 'a"b' && tkUnterminated,
    `inner=${JSON.stringify(tk1[2])} space=${JSON.stringify(tkSpace[1])} esc=${JSON.stringify(tkEsc[1])} unterminated=${tkUnterminated}`
  );

  // node 系命令含 shell 元字符 → 整条经 Lifo shell 执行（runtime=lifo），node 段转真 node。
  const shellPipe = await client.terminal('node -e "console.log(21*2)" | grep 42');
  verdict(
    term,
    'Shell',
    'node pipe chain',
    shellPipe.ok && shellPipe.runtime === 'lifo' && String(shellPipe.stdout ?? '').trim() === '42',
    `runtime=${shellPipe.runtime} stdout=${String(shellPipe.stdout ?? '').trim()}`
  );

  const shellChain = await client.terminal('node --version && npm --version');
  const chainLines = String(shellChain.stdout ?? '').trim().split('\n').filter((l) => l.length > 0);
  verdict(
    term,
    'Shell',
    'node && chain',
    shellChain.ok && shellChain.runtime === 'lifo' && chainLines.length >= 2,
    `runtime=${shellChain.runtime} lines=${chainLines.length}`
  );

  const longSpawn = await client.spawn('node -e "setInterval(()=>{},1000)"');
  const longPid = Number(longSpawn.pid);
  const psAfterStart = await client.terminal('ps');
  const longProc = (psAfterStart.processes ?? []).find(
    (pr: Record<string, unknown>) => Number(pr.pid) === longPid && pr.status === 'running'
  );
  if (longSpawn.ok === true && longPid > 0 && longProc) {
    const k = await client.terminal(`kill ${longPid}`);
    verdict(term, 'Process table', 'kill long-running node', k.ok && k.killed === true, `pid=${longProc.pid} ${k.message ?? ''}`);
    await sleep(300);
    const psAfterKill = await client.terminal('ps');
    const after = (psAfterKill.processes ?? []).find((pr: Record<string, unknown>) => Number(pr.pid) === longPid);
    verdict(term, 'Process table', 'kill marks exited', !after || after.status === 'exited', JSON.stringify(after ?? `pid=${longPid} no longer in table`));
  } else {
    verdict(term, 'Process table', 'kill long-running node', false, `pid=${longPid || '?'} no long-running node child found via ps`);
  }

  // ─── T15: spawn 后台 http 服务完整链路 ───
  let spawnPid = 0;
  try {
    const sp = await client.spawn('node -e "http.createServer((q,s)=>s.end(\'hello-port\')).listen(3456)"');
    verdict(term, 'Process table', 'spawn returns pid', sp.ok === true && Number(sp.pid) > 0, `pid=${sp.pid} runtime=${sp.runtime}`);
    spawnPid = Number(sp.pid);

    const ps1 = await client.terminal('ps');
    const spProc = (ps1.processes ?? []).find((pr: Record<string, unknown>) => pr.pid === spawnPid);
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
    const afterKill = (ps2.processes ?? []).find((pr: Record<string, unknown>) => pr.pid === spawnPid);
    const killedOk = k2.ok && k2.killed === true && (!afterKill || afterKill.status === 'exited');
    verdict(term, 'Process table', 'spawn/kill lifecycle', killedOk, `killed=${k2.killed} status=${afterKill ? afterKill.status : 'no longer in table'}`);
  }

  // ─── TASK19 回归 1：spawn 失败竞态 ───
  // dispatchSpawn 对"spawn 成功但进程很快非零退出"（如 npx 包不存在）必须报 ok:false，
  // 不得让浏览器读到 ok:true + pid 后把一次注定失败的启动误报为成功。
  // N4（TASK20）：离线时 npx 探测 registry 会挂到 RPC 超时抛异常，自检 crash。
  // 套 try/catch + 缩短超时（2000ms），离线优雅降级为 skip（"不假报成功"的不变量仍成立），不 crash。
  try {
    const spFail = await client.spawn('npx definitely-not-exist-xyz', undefined, 2000);
    verdict(term, 'Process table', 'spawn failure reported (ok:false)', spFail.ok === false, spFail.error ?? `pid=${spFail.pid ?? 'none'} runtime=${spFail.runtime ?? '?'}`);
  } catch (e) {
    boundary(term, 'Process table', 'spawn failure reported (ok:false)', `npx registry probe unavailable offline: ${String(e).slice(0, 80)}`);
  }

  // ─── TASK19 回归 2：双 host 不变量（kill 先于 spawn）───
  // 重启 host 必须先 kill 旧 host 再 spawn 新 host，否则两个 host 同时轮询 cmd.json。
  // 用假句柄直接断言 respawnWithKillFirst 的顺序（main.ts 的 restartHost 复用同一函数）。
  const order: string[] = [];
  await respawnWithKillFirst(
    () => void order.push('kill'),
    async () => {
      order.push('spawn');
      return {} as never;
    }
  );
  verdict(term, 'Process table', 'host restart kills old before spawn', order.join(',') === 'kill,spawn', order.join(' -> '));
}
