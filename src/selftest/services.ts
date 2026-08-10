// 自检域：服务管理 + 日志（O5 拆分）。
import { verdict } from './runner.js';
import type { TestContext } from './runner.js';
import { readServices, addServiceDef, removeServiceDef, startService, stopService, getServiceState, enableAutostart, disableAutostart, readAutostart } from '../services.js';
import { readLog, readBootLog, clearLog, flushLogs } from '../log.js';
import { sleep } from '../util.js';

export async function runServices(ctx: TestContext): Promise<void> {
  const { wc, client, ports, term } = ctx;
  // ─── 服务管理（Services，TASK11）：声明式 service 命令族 ───
  const svcCtx = { wc, client, ports };
  const svcDefs = await readServices(wc.fs);
  const tinbaseDef = svcDefs.find((d) => d.name === 'tinbase');
  verdict(
    term,
    'Services',
    'list shows tinbase',
    !!tinbaseDef && tinbaseDef.command.includes('tinbase') && tinbaseDef.port === 3001,
    tinbaseDef ? `name=${tinbaseDef.name} port=${tinbaseDef.port}` : 'no tinbase def'
  );

  // 生命周期：注册临时 echo server 定义 → start → running → stop → stopped → 清理定义（零残留）。
  const SVC_TEST = 'selftest-svc';
  const SVC_PORT = 3457;
  const SVC_CMD = `node -e "http.createServer((q,s)=>s.end('hello-svc')).listen(${SVC_PORT})"`;
  await addServiceDef(wc.fs, SVC_TEST, SVC_CMD, SVC_PORT);
  const svcDefs1 = await readServices(wc.fs);
  const svcDef = svcDefs1.find((d) => d.name === SVC_TEST);
  verdict(term, 'Services', 'temporary def registered', !!svcDef, svcDef ? `name=${svcDef.name}` : 'def missing');
  if (svcDef) {
    const started = await startService(svcCtx, SVC_TEST);
    verdict(term, 'Services', 'start returns pid', started.ok && Number(started.pid) > 0, started.message);

    // 等端口就绪 → running（进程表 + 端口注册表联合判定）。
    let running = false;
    const runDeadline = Date.now() + 15000;
    while (Date.now() < runDeadline) {
      const st = await getServiceState(svcCtx, svcDef);
      if (st.state === 'running') {
        running = true;
        break;
      }
      await sleep(300);
    }
    verdict(term, 'Services', 'start -> running', running, `port=${SVC_PORT} ready=${ports.has(SVC_PORT)}`);

    const stopped = await stopService(svcCtx, SVC_TEST);
    await sleep(500);
    const stAfter = await getServiceState(svcCtx, svcDef);
    verdict(term, 'Services', 'stop -> stopped', stopped.ok && stAfter.state === 'stopped', stopped.message);
  }
  const removed = await removeServiceDef(wc.fs, SVC_TEST);
  const svcDefs2 = await readServices(wc.fs);
  verdict(
    term,
    'Services',
    'cleanup definition (zero residue)',
    removed === true && !svcDefs2.some((d) => d.name === SVC_TEST),
    `removed=${removed}`
  );

  // 自启：enable 写入（去重）→ disable 移除（文件断言，结束后零残留）。
  await enableAutostart(wc.fs, SVC_TEST);
  await enableAutostart(wc.fs, SVC_TEST);
  const autoList1 = await readAutostart(wc.fs);
  const autoCount = autoList1.filter((n) => n === SVC_TEST).length;
  verdict(term, 'Services', 'autostart enable writes (dedup)', autoCount === 1, `count=${autoCount}`);
  const dis = await disableAutostart(wc.fs, SVC_TEST);
  const autoList2 = await readAutostart(wc.fs);
  verdict(term, 'Services', 'autostart disable removes', dis === true && !autoList2.includes(SVC_TEST), `removed=${dis}`);

  // ─── 日志（Logs，TASK12）：journald 风格落盘 /var/log/succinix.log ───
  // 命令执行记录：跑一条真实命令 → log 出现该命令记录（exit=0）。
  const LOG_PROBE = 'echo "log-probe-selftest"';
  const logProbe = await client.terminal(LOG_PROBE);
  await flushLogs(); // 等排队中的日志落盘，再断言
  const logText = await readLog(wc.fs, 200);
  verdict(
    term,
    'Logs',
    'command execution recorded',
    logProbe.ok && logText.includes(LOG_PROBE) && logText.includes('exit=0'),
    `runtime=${logProbe.runtime ?? '?'} recorded=${logText.includes(LOG_PROBE)}`
  );

  // boot 事件：log 含 BOOT 级条目（boot 阶段 ok/note 已写入）。
  await flushLogs();
  const logBootText = await readBootLog(wc.fs, 200);
  const bootCount = logBootText ? logBootText.split('\n').length : 0;
  verdict(term, 'Logs', 'boot events recorded', bootCount > 0, `${bootCount} BOOT entries`);

  // clear：log clear 后为空。
  await clearLog(wc.fs);
  const logAfterClear = await readLog(wc.fs, 10);
  verdict(term, 'Logs', 'clear', logAfterClear.trim() === '', 'log empty after clear');
}
