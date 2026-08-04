// 自动化系统自检（?test=1 时自动运行，boot diagnostics 风格，英文）。
// 断言逻辑与 TASK2 保持一致，只改输出表现形态：专业自检流程而非测试列表。
import type { Terminal } from '@xterm/xterm';
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from './terminal-client.js';
import { saveSnapshot, loadSnapshot } from './persist.js';
import {
  getCurrentWorkspace,
  listWorkspaces,
  buildWorkspaceList,
  workspaceCreate,
  workspaceSwitch,
  workspaceRemove,
  buildNetstatRows,
  commandMentionsPort,
  buildUnameLine,
  detectUnameArch,
  unameRuntimeVersion,
  tryHandleLocalCommand,
} from './commands.js';
import {
  readEnvFile,
  getEnvVar,
  setEnvVar,
  unsetEnvVar,
  getSetting,
  setSetting,
  resetSetting,
} from './config.js';
import {
  readServices,
  addServiceDef,
  removeServiceDef,
  startService,
  stopService,
  getServiceState,
  enableAutostart,
  disableAutostart,
  readAutostart,
} from './services.js';
import { readLog, readBootLog, clearLog, flushLogs } from './log.js';
import { listPackages, formatPackageList, searchPackages } from './pkg.js';
import { readMotd, writeMotd, resetMotd, DEFAULT_MOTD } from './motd.js';

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
  /** 失败项列表（TASK16：自检后打印到终端，暗红显示） */
  failures: string[];
}

const AMBER = '\x1b[33m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
let skip = 0;
// TASK16：收集失败项，自检结束后供 main.ts 打印到终端（暗红失败行）。
let failures: string[] = [];

// 断言结果行：[ OK ] 暗橙 / [ FAIL ] 暗红，带关键值（pid/版本/端口）。
function verdict(term: Terminal, category: string, name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    term.writeln(`${AMBER}[  OK  ]${RESET} ${category}: ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    fail++;
    failures.push(`${category}: ${name}${detail ? ` (${detail})` : ''}`);
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
  failures = [];

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
  verdict(term, 'Persistence', 'snapshot saved', pers1.meta.fileCount > 0, `${pers1.meta.fileCount} files`);

  const pers2 = await loadSnapshot(wc.fs);
  const restoredText = pers2 ? await wc.fs.readFile('/browser-wrote.txt', 'utf8') : '';
  const loadable = !!pers2 && pers2.fileCount === pers1.meta.fileCount && restoredText.includes('hello from browser');
  verdict(term, 'Persistence', 'snapshot loadable', loadable, pers2 ? `restored ${pers2.fileCount} files` : 'no snapshot to restore');

  // ─── 工作区（Workspace，TASK7）：多工作区隔离 ───
  const wsCurrent = await getCurrentWorkspace(wc.fs);
  const wsNames = await listWorkspaces(wc.fs);
  const wsText = buildWorkspaceList(wsCurrent, wsNames).join('\n');
  const wsListOk = wsNames.includes(wsCurrent ?? 'main') && wsText.includes('(current)') && wsText.startsWith('Workspaces');
  verdict(term, 'Workspace', 'list workspaces', wsListOk, `current=${wsCurrent ?? 'none'} count=${wsNames.length}`);

  // 生命周期：创建临时工作区 → 切换 → 读 .current 验证 → 删除，清理干净不留残留。
  // 记录原始当前工作区，结束时恢复原状（自检不改变用户工作区状态）。
  const wsOriginal = (await getCurrentWorkspace(wc.fs)) ?? 'main';
  const WS_TEST = 'selftest-ws';
  const wsC = await workspaceCreate(wc.fs, WS_TEST);
  verdict(term, 'Workspace', 'create workspace', wsC.ok && (await listWorkspaces(wc.fs)).includes(WS_TEST), wsC.message);

  const wsS = await workspaceSwitch(wc.fs, WS_TEST);
  const wsAfterSwitch = await getCurrentWorkspace(wc.fs);
  verdict(term, 'Workspace', 'switch updates .current', wsS.ok && wsAfterSwitch === WS_TEST, `current=${wsAfterSwitch}`);

  // 保护：禁止删除 main 与当前工作区。
  const wsProtectMain = await workspaceRemove(wc.fs, 'main', wsAfterSwitch, true);
  verdict(term, 'Workspace', 'main workspace protected', !wsProtectMain.ok, wsProtectMain.message);

  const wsProtectCur = await workspaceRemove(wc.fs, WS_TEST, wsAfterSwitch, true);
  verdict(term, 'Workspace', 'current workspace protected', !wsProtectCur.ok, wsProtectCur.message);

  // 清理：切回原工作区再删 selftest-ws，.current 恢复原状，无残留。
  await workspaceSwitch(wc.fs, wsOriginal);
  const wsR = await workspaceRemove(wc.fs, WS_TEST, wsOriginal, true);
  const wsAfterRm = await listWorkspaces(wc.fs);
  const wsFinalCurrent = await getCurrentWorkspace(wc.fs);
  verdict(
    term,
    'Workspace',
    'remove workspace + cleanup',
    wsR.ok && !wsAfterRm.includes(WS_TEST) && wsFinalCurrent === wsOriginal,
    wsR.message
  );

  // ─── 系统配置（Config，TASK10）：env 与 settings 生命周期 ───
  // env: set TEST_VAR → 读回（内存 + 落盘 /etc/webunix.env）→ delete，无残留。
  const cfgEnvKey = 'TEST_VAR';
  await setEnvVar(wc.fs, cfgEnvKey, 'selftest-value');
  const cfgEnvRead = await getEnvVar(wc.fs, cfgEnvKey);
  const cfgEnvFile = (await readEnvFile(wc.fs)).get(cfgEnvKey);
  verdict(
    term,
    'Config',
    'env set/get lifecycle',
    cfgEnvRead === 'selftest-value' && cfgEnvFile === 'selftest-value',
    `TEST_VAR=${cfgEnvRead}`
  );
  const cfgEnvDel = await unsetEnvVar(wc.fs, cfgEnvKey);
  const cfgEnvAfter = await getEnvVar(wc.fs, cfgEnvKey);
  verdict(
    term,
    'Config',
    'env delete lifecycle',
    cfgEnvDel === true && cfgEnvAfter === undefined,
    `removed=${cfgEnvDel}`
  );

  // H1 回归：等长值修改必须强制落盘。快照签名只看文件数+总字节（内容盲），
  // 'aaaaa'→'bbbbb' 等长替换不改变签名 → 自动快照会跳过写；依赖 setEnvVar 写盘后强制保存。
  // 先保存一次快照收录旧值（模拟"旧值已被持久化"的真实前置），再等长替换，
  // loadSnapshot 若仍读回旧值即说明修改未落盘（重启回滚）。
  const cfgEqlKey = 'TEST_EQLEN';
  await setEnvVar(wc.fs, cfgEqlKey, 'aaaaa');
  await saveSnapshot(wc.fs); // 快照先收录 'aaaaa'（此后等长替换不再改变文件数/总字节）
  await setEnvVar(wc.fs, cfgEqlKey, 'bbbbb'); // 同长度替换：内容盲签名不变，必须靠强制保存
  await loadSnapshot(wc.fs); // 从快照恢复，校验新值已收录
  const cfgEqlAfter = await getEnvVar(wc.fs, cfgEqlKey);
  verdict(
    term,
    'Config',
    'equal-length env change persists (force snapshot)',
    cfgEqlAfter === 'bbbbb',
    `${cfgEqlKey}=${cfgEqlAfter}`
  );
  await unsetEnvVar(wc.fs, cfgEqlKey); // 清理，零残留

  // settings: 设 preview-port 9999 → 读回 → reset 回默认 3001。
  await setSetting(wc.fs, 'preview-port', '9999');
  const cfgPortSet = await getSetting(wc.fs, 'preview-port');
  verdict(term, 'Config', 'settings read/write', cfgPortSet === '9999', `preview-port=${cfgPortSet}`);
  const cfgPortReset = await resetSetting(wc.fs, 'preview-port');
  const cfgPortAfter = await getSetting(wc.fs, 'preview-port');
  verdict(
    term,
    'Config',
    'settings reset restores default',
    cfgPortReset === true && cfgPortAfter === '3001',
    `preview-port=${cfgPortAfter}`
  );

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

  // ─── 日志（Logs，TASK12）：journald 风格落盘 /var/log/webunix.log ───
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

  // ─── 包管理（Packages，TASK13）：pkg 命令族统一 lifo + npm 两通道 ───
  const pkgCtx = { wc, client };
  const pkgList = await listPackages(pkgCtx);
  const pkgText = formatPackageList(pkgList).join('\n');
  const pkgTinbase = pkgList.find((p) => p.name === 'tinbase');
  verdict(
    term,
    'Packages',
    'list merged',
    pkgText.startsWith('Packages') && pkgText.includes('SOURCE') && pkgText.includes('VERSION'),
    `${pkgList.length} packages (${pkgList.filter((p) => p.source === 'lifo').length} lifo, ` +
      `${pkgList.filter((p) => p.source === 'npm').length} npm)${pkgTinbase ? ` tinbase@${pkgTinbase.version}` : ''}`
  );

  // search：pkg search git 命中 lifo-pkg-git。网络项 —— 失败按已知边界 SKIP。
  try {
    const outcome = await searchPackages(pkgCtx, 'git');
    const hit = outcome.entries.find((s) => s.name === 'git' && s.source === 'lifo');
    if (hit) {
      verdict(term, 'Packages', 'search lifo-git', true, `lifo-pkg-git ${hit.version}`);
    } else if (outcome.entries.length === 0) {
      boundary(term, 'Packages', 'search lifo-git', 'no results (registry/network unavailable)');
    } else {
      verdict(term, 'Packages', 'search lifo-git', false, 'lifo-pkg-git not in results');
    }
  } catch (e) {
    boundary(term, 'Packages', 'search lifo-git', `network boundary: ${String(e).slice(0, 60)}`);
  }

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

  // ─── 内存（Memory）：浏览器报告设备内存或 JS heap 统计（任一存在即可）───
  const devMem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  const perfMem = (performance as unknown as { memory?: unknown }).memory;
  if (devMem !== undefined || perfMem !== undefined) {
    const detail = devMem !== undefined ? `${devMem} GB` : 'performance.memory present';
    verdict(term, 'Memory', 'device memory reported', true, detail);
  } else {
    boundary(term, 'Memory', 'device memory reported', 'no device memory / heap stats in this browser');
  }

  // ─── 系统信息（Info，TASK15）：uname 输出 + motd 生命周期 ───
  const unameSummary = buildUnameLine();
  const unameOk =
    unameSummary.startsWith('WebUnix') &&
    /^WebUnix \d+\.\d+\.\d+ js-runtime\+webcontainer \d+\.\d+\.\d+ (x86_64|arm64|unknown)$/.test(unameSummary);
  verdict(term, 'Info', 'uname output', unameOk, `${unameSummary} (arch=${detectUnameArch()})`);

  // motd：设置 → 读回 → reset（恢复默认，零残留）。
  await writeMotd(wc.fs, 'selftest-motd');
  const motdRead = await readMotd(wc.fs);
  const motdSetOk = motdRead === 'selftest-motd';
  await resetMotd(wc.fs);
  const motdAfter = await readMotd(wc.fs);
  verdict(
    term,
    'Info',
    'motd read/write/reset',
    motdSetOk && motdAfter === DEFAULT_MOTD,
    `set=${motdSetOk} reset=${motdAfter === DEFAULT_MOTD}`
  );

  // R2（TASK17）：经命令分发路径断言 uname flag 解析 —— 不直接调 buildUname*()，
  // 而是走 tryHandleLocalCommand → unameCmd 的真实链路（捕获型假终端收集输出）。
  // uname -r 应输出运行时版本、uname -m 应输出 UA 架构，验证 flag 解析不再短路。
  const captureTerm = (): { term: Terminal; lines: string[] } => {
    const lines: string[] = [];
    const termShim = {
      writeln: (l: string) => void lines.push(String(l)),
      write: (d: string) => void lines.push(String(d)),
      clear: () => {},
    } as unknown as Terminal;
    return { term: termShim, lines };
  };
  const dispatchBase = { wc, client, ports, fit: () => {} };

  const capR = captureTerm();
  const handledR = await tryHandleLocalCommand({ ...dispatchBase, term: capR.term }, 'uname -r');
  verdict(
    term,
    'Info',
    'uname -r via dispatch',
    handledR && capR.lines.join('') === unameRuntimeVersion(),
    `handled=${handledR} out=${capR.lines.join('') || '(empty)'}`
  );

  const capM = captureTerm();
  const handledM = await tryHandleLocalCommand({ ...dispatchBase, term: capM.term }, 'uname -m');
  verdict(
    term,
    'Info',
    'uname -m via dispatch',
    handledM && capM.lines.join('') === detectUnameArch(),
    `handled=${handledM} out=${capM.lines.join('') || '(empty)'}`
  );

  // ─── 内置命令冒烟（Smoke，TASK16）：help 全部条目里浏览器侧命令的取安全形态逐个跑 ───
  // 只跑非破坏性命令：reboot 会 reload、db start 会装 tinbase、snapshot now/clear 有副作用，均排除；
  // 其余全部经 tryHandleLocalCommand 分发，断言"被浏览器处理且不抛异常"。
  const smokeCtx = { wc, client, ports, term, fit: () => {} };
  const smokeCommands: string[] = [
    'help', 'clear', 'sysinfo', 'version', 'whoami', 'ports',
    'db status', 'db stop', // db start 排除（重型：安装+spawn）
    'snapshot', // 状态查看；snapshot now / clear 排除（副作用）
    'free', 'top', // top 3 次快照，约 4s，可接受
    'cache', // du 统计，几秒内返回
    'workspace', 'env', 'settings', 'service', 'log', 'pkg',
    'netstat', 'ip addr', 'uname -a', 'motd', 'shutdown',
  ];
  const smokeFails: string[] = [];
  for (const cmd of smokeCommands) {
    try {
      const handled = await tryHandleLocalCommand(smokeCtx, cmd);
      if (!handled) smokeFails.push(`${cmd}: not handled locally`);
    } catch (e) {
      smokeFails.push(`${cmd}: ${String(e).slice(0, 100)}`);
    }
  }
  if (smokeFails.length === 0) {
    verdict(term, 'Smoke', `built-in commands dispatch (${smokeCommands.length})`, true, smokeCommands.join(' '));
  } else {
    verdict(term, 'Smoke', 'built-in commands dispatch', false, smokeFails.join('; '));
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

  return { pass, fail, skip, failures };
}
