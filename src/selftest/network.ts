// 自检域：网络视图（netstat / 端口匹配）（O5 拆分）。
import { verdict } from './runner.js';
import type { TestContext } from './runner.js';
import { buildNetstatRows, commandMentionsPort } from '../commands/index.js';
import { sleep } from '../util.js';

export async function runNetwork(ctx: TestContext): Promise<void> {
  const { client, ports, term } = ctx;
  // ─── 网络视图（Network，TASK14）：netstat 虚拟端口表 ───
  // netstat format：spawn 3456 echo server → 端口就绪 → netstat 列出该端口且 -p 关联到进程 → kill 清理。
  // 先等上一轮 T15 杀掉的 3456 从端口注册表移除（port close 事件异步），避免残留误判。
  const netCleanDeadline = Date.now() + 10000;
  while (ports.has(3456) && Date.now() < netCleanDeadline) await sleep(300);

  let netPid = 0;
  try {
    const sp = await client.spawn('node -e "http.createServer((q,s)=>s.end(\'netstat-port\')).listen(3456)"');
    netPid = sp.ok && Number(sp.pid) > 0 ? Number(sp.pid) : 0;
    verdict(term, 'Network', 'netstat spawn (3456)', netPid > 0, `pid=${sp.pid ?? 'none'}`);

    let netUrl = ports.get(3456);
    const netReadyDeadline = Date.now() + 20000;
    while (!netUrl && Date.now() < netReadyDeadline) {
      await sleep(300);
      netUrl = ports.get(3456);
    }
    if (!netUrl) {
      verdict(term, 'Network', 'netstat format', false, 'server-ready not detected within 20s');
    } else {
      const netRows = await buildNetstatRows(ports, client, true);
      const netRow = netRows.find((r) => r.localAddress === '127.0.0.1:3456');
      verdict(
        term,
        'Network',
        'netstat format (port + process association)',
        !!netRow &&
          netRow.proto === 'tcp' &&
          netRow.state === 'LISTEN' &&
          netRow.process !== '-' &&
          netRow.process.includes('node http server'),
        netRow ? `row=${netRow.proto} ${netRow.localAddress} ${netRow.state} ${netRow.process}` : 'no 3456 row'
      );
    }
  } catch (e) {
    verdict(term, 'Network', 'netstat spawn/lifecycle', false, String(e).slice(0, 120));
  }

  // kill → 端口从注册表移除 → netstat 不再列出 3456（无该端口）。
  if (netPid > 0) {
    const netKill = await client.terminal(`kill ${netPid}`);
    const netGoneDeadline = Date.now() + 10000;
    while (ports.has(3456) && Date.now() < netGoneDeadline) await sleep(300);
    const netRowsAfter = await buildNetstatRows(ports, client, true);
    const stillPresent = netRowsAfter.some((r) => r.localAddress === '127.0.0.1:3456');
    verdict(
      term,
      'Network',
      'netstat empty (port gone after kill)',
      netKill.ok === true && netKill.killed === true && !stillPresent,
      `killed=${netKill.killed} registered=${ports.has(3456)} rowPresent=${stillPresent}`
    );
  }

  // 端口↔进程匹配（r4 C）：纯函数级断言，防日后回归为子串匹配。
  // --port 3001 命中 3001，但不误关联 300 / 30010（3001↔300/30010 不能互相匹配）。
  const pmCmd = 'node server.js --port 3001';
  const pmPos = commandMentionsPort(pmCmd, 3001);
  const pmNeg300 = commandMentionsPort(pmCmd, 300);
  const pmNeg30010 = commandMentionsPort(pmCmd, 30010);
  verdict(
    term,
    'Network',
    'port match positive (--port 3001 -> 3001)',
    pmPos && !pmNeg300 && !pmNeg30010,
    `pos=${pmPos} neg300=${pmNeg300} neg30010=${pmNeg30010}`
  );
  const pmEq = commandMentionsPort('node server.js --port=3001', 3001);
  const pmListen = commandMentionsPort('node -e "http.createServer(...).listen(3001)"', 3001);
  verdict(
    term,
    'Network',
    'port match forms (--port=3001 / listen(3001))',
    pmEq && pmListen,
    `eq=${pmEq} listen=${pmListen}`
  );
}
