// Succinix 入口：全屏暗橙终端 + REPL；boot 日志全程写入终端（无 DOM splash 覆盖层）。
// E3：main.ts 重构为组装层 —— xterm 呈现 + 应用特性（看门狗/自动快照/开发钩子）+ 装配
// Terminal SDK（SuccinixTerminalSession + createTerminalBoot）。交互状态机（历史/补全/
// 真中断/队列/提示符 cwd）已迁移到 src/terminal/session.ts；commands.ts 经薄适配层注入。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { bootSuccinix, makeClientLogger, type SuccinixServices } from './boot.js';
import { createBootUI } from './boot-ui.js';
import { tryHandleLocalCommand, type CommandContext } from './commands.js';
import { tokenize } from './engine/tokenize.js';
import { log } from './log.js';
import { runTests, type TestResult } from './tests.js';
import { saveSnapshot, type PersistContext } from './persist.js';
import { getSetting } from './config.js';
import { readMotd } from './motd.js';
import { AMBER, RED, GRAY, RESET } from './theme.js';
import { SUCCINIX_VERSION } from './version.js';
import { ensurePythonRuntime, createTerminalExecutor } from './engine/index.js';
import {
  SuccinixTerminalSession,
  createTerminalBoot,
  DEFAULT_BOOT_STEPS,
  type TerminalOutput,
  type TerminalRpc,
  type LocalCommandHandler,
} from './terminal/index.js';

// 欢迎横幅：boot 日志之后显示在终端里。默认横幅由 /etc/succinix.motd 提供（可编辑、
// 随快照持久）；此处仅作 motd 文件缺失时的兜底。版本号构建期注入（随 package.json 单一来源）。
const WELCOME_BANNER =
  `Succinix ${SUCCINIX_VERSION} — kernel: JS runtime + WebContainer | userland: Lifo | exec: TerminalExecutor\n` +
  `Type 'help' to see available commands.`;

// ─── xterm：全屏暗橙终端（JetBrains Mono，暖色暗调色板）───
const term = new Terminal({
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.15,
  cursorBlink: true,
  convertEol: true,
  scrollback: 3000,
  theme: {
    background: '#0a0a0a',
    foreground: '#d6cfc4',
    cursor: '#c2702a',
    cursorAccent: '#0a0a0a',
    selectionBackground: '#3a2a1a',
    selectionForeground: '#ffffff',
    black: '#1a1816',
    red: '#c0543a',
    green: '#7a8a5a',
    yellow: '#c98a2e',
    blue: '#7a8a9a',
    magenta: '#a06f9a',
    cyan: '#6f9a8a',
    white: '#d6cfc4',
    brightBlack: '#6b6560',
    brightRed: '#d96a4e',
    brightGreen: '#9aab72',
    brightYellow: '#dba04a',
    brightBlue: '#8aa0ae',
    brightMagenta: '#b887b0',
    brightCyan: '#86aea0',
    brightWhite: '#efe8dc',
  },
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal')!);
fitAddon.fit();
window.addEventListener('resize', () => fitAddon.fit());

// 模式（与既有开发钩子形状完全一致，scripts/bench.mjs / scenarios.mjs / verify-deploy.mjs 依赖）。
const benchMode = new URLSearchParams(location.search).get('bench') === '1';
const scenarioMode = new URLSearchParams(location.search).get('scenario') === '1';

// TASK18：bench 模式记录首提示符出现时间（基准脚本读 window.__bootTimes.prompt）。
function benchMarkPrompt(): void {
  if (!benchMode) return;
  const t = (window as unknown as { __bootTimes?: { prompt: number | null } }).__bootTimes;
  if (t && t.prompt === null) t.prompt = performance.now();
}

// ─── TerminalOutput 适配（SDK 契约 ≤10 行；xterm 只在应用层）───
const output: TerminalOutput = {
  write: (d) => term.write(d),
  clear: () => term.clear(),
};

// ─── commands.ts 薄适配层 ───
// 闭包捕获 CommandContext 所需字段（wc/client/ports/fit/hostProc）；term 用
// { writeln, write, clear } shim 桥接 TerminalOutput —— commands.ts 本身不改。
const LOCAL_COMMAND_NAMES = [
  'help', 'clear', 'sysinfo', 'ports', 'db', 'snapshot', 'free', 'top', 'reboot', 'shutdown',
  'cache', 'workspace', 'env', 'settings', 'service', 'log', 'pkg', 'netstat', 'ip', 'uname',
  'motd', 'lang', 'pwd', 'version', 'whoami',
];

function termShimFor(out: TerminalOutput): Terminal {
  return {
    writeln: (l: unknown) => out.write(String(l) + '\r\n'),
    write: (d: unknown) => out.write(String(d)),
    clear: () => out.clear(),
  } as unknown as Terminal;
}

// 每个命令名一个处理器：把 (ctx, args) 还原成完整命令串交给 tryHandleLocalCommand。
// ctx 是可变引用（boot 完成后赋值），处理器在运行时才取值。
function makeLocalHandlers(getCtx: () => CommandContext): Record<string, LocalCommandHandler> {
  const handlers: Record<string, LocalCommandHandler> = {};
  for (const name of LOCAL_COMMAND_NAMES) {
    handlers[name] = async (lctx, args) => {
      const c = getCtx();
      const handled = await tryHandleLocalCommand({ ...c, term: termShimFor(lctx.output) }, [name, ...args].join(' '));
      if (!handled) throw new Error(`unknown command: ${name}`);
    };
  }
  return handlers;
}

// ─── 命令日志采集（对齐既有 /var/log/succinix.log 行为）───
// host 命令由 TerminalClient.onCommand（boot 注入）落盘；本地命令由 session.onCommand 落盘；
// 错误由 session.onCommandError 落盘（phase 区分 python 注入失败与 RPC 失败）。
function makeSessionLogger(): {
  onCommand: (entry: { command: string; exit: number | null; runtime: string }) => void;
  onCommandError: (command: string, error: string, phase: 'local' | 'pre' | 'rpc') => void;
} {
  return {
    onCommand: (entry) => {
      if (entry.runtime === 'browser' && !/^log\s+clear\b/.test(entry.command)) {
        void log('INFO', `cmd: ${entry.command} exit=0 runtime=browser`);
      }
    },
    onCommandError: (command, error, phase) => {
      void log('ERROR', phase === 'pre' ? `cmd: ${command} python asset inject failed: ${error}` : `cmd: ${command} error: ${error}`);
    },
  };
}

// ─── 场景测试驱动（TASK19，scripts/scenarios.mjs 用）───
// 与 execute() 相同分发路径（本地命令经 session.dispatchLocal 捕获，host 命令走 rpcExec），
// 输出改为结构化捕获（capture shim）。timeoutMs 仅约束 host 命令的 RPC 等待。
async function scenarioRun(
  session: SuccinixTerminalSession,
  services: SuccinixServices,
  cmd: string,
  timeoutMs = 60000
): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const [word, ...args] = cmd.trim().split(/\s+/);
  let handled: boolean;
  try {
    handled = await session.dispatchLocal(word ?? '', args, {
      write: (d: string) => void lines.push(d),
      clear: () => {},
    });
  } catch (e) {
    return { handled: true, ok: false, error: String(e), output: lines.join('\n'), lines };
  }
  if (handled) {
    return { handled: true, ok: true, output: lines.join('\n'), lines };
  }
  const rpc = await session.rpcExec(cmd, timeoutMs);
  if ('error' in rpc) {
    return { handled: false, ok: false, error: rpc.error, thrown: true };
  }
  const res = rpc.res;
  return {
    handled: false,
    ok: res.ok,
    exitCode: res.exitCode,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
    runtime: res.runtime,
    error: res.error,
    message: res.message,
    pid: res.pid,
    processes: res.processes,
    killed: res.killed,
    kind: res.kind,
  };
}

// ─── 自动快照（每 ~2.5s 保存一次；persist 内部去重 + 空闲退避）───
const AUTO_SNAPSHOT_BASE_MS = 2500;
const AUTO_SNAPSHOT_MAX_MS = 15000;

// M5：持久化主循环按实例键（demo 传 instance.persist；缺省 = 模块级默认实例，现状全等）。
function startAutoSnapshot(fs: SuccinixServices['wc']['fs'], persist?: Pick<PersistContext, 'save'>): void {
  const save = persist ? (force?: boolean) => persist.save(fs, force) : (force?: boolean) => saveSnapshot(fs, force);
  let interval = AUTO_SNAPSHOT_BASE_MS;
  let idleTicks = 0;
  const tick = async () => {
    try {
      const r = await save();
      if (r.reason === 'changed') {
        idleTicks = 0;
        interval = AUTO_SNAPSHOT_BASE_MS;
      } else {
        idleTicks++;
        if (idleTicks >= 2) interval = Math.min(interval * 2, AUTO_SNAPSHOT_MAX_MS);
      }
    } catch (e) {
      console.warn('[persist] auto snapshot failed:', e);
    }
    setTimeout(tick, interval);
  };
  setTimeout(tick, AUTO_SNAPSHOT_BASE_MS);
  const flush = () => {
    void save(true).catch(() => {});
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}

// TASK16：自检结果进终端（complete() 之后、motd 横幅之前）。默认路径与 ?instance= demo 共用。
function printTestResult(term: Terminal, testResult: TestResult | null, testCrashed: string): void {
  if (testResult) {
    const summary = `Self-test result: ${testResult.pass} passed, ${testResult.fail} failed, ${testResult.skip} skipped`;
    if (testResult.fail > 0) {
      term.writeln(`${RED}${summary}${RESET}`);
      for (const f of testResult.failures) {
        term.writeln(`${RED}  [ FAIL ] ${f}${RESET}`);
      }
    } else {
      term.writeln(`${AMBER}${summary}${RESET}`);
    }
    (window as unknown as { __succinixResult?: { passed: number; failed: number; skipped: number; fails: string[] } }).__succinixResult = {
      passed: testResult.pass,
      failed: testResult.fail,
      skipped: testResult.skip,
      fails: testResult.failures,
    };
  } else if (testCrashed) {
    term.writeln(`${RED}[ FAIL ] self-test crashed: ${testCrashed}${RESET}`);
  }
}

// ─── host 看门狗（每 30s ping，连续 2 次失败 → executor.respawn 重启 host）───
function startHostWatchdog(executor: ReturnType<typeof createTerminalExecutor>, wc: SuccinixServices['wc']): void {
  let consecutiveFailures = 0;
  let probing = false;
  setInterval(async () => {
    if (probing) return;
    probing = true;
    try {
      const p = await executor.pingDirect(30000);
      if (p === true) {
        consecutiveFailures = 0;
        return;
      }
      if (p === false) {
        consecutiveFailures++;
        if (consecutiveFailures >= 2) {
          consecutiveFailures = 0;
          void restartHost(executor, wc);
        }
        return;
      }
      // p === null：通道忙，中性不计。
    } finally {
      probing = false;
    }
  }, 30000);
}

// 重新注入 host.js（容器内缺失时从构建产物拉取）并 respawn，等待就绪。
async function restartHost(executor: ReturnType<typeof createTerminalExecutor>, wc: SuccinixServices['wc']): Promise<void> {
  try {
    term.writeln(`${AMBER}[ WARN ] host unresponsive — re-injecting host.js and respawning${RESET}`);
    void log('WARN', 'host unresponsive — re-injecting host.js and respawning');
    try {
      // 确保 host.js / lifo-core.js 存在（缺失时从构建产物拉取；lifo-core 异步写不阻塞重启就绪）。
      try {
        await wc.fs.readFile('/host.js');
      } catch {
        const src = await (await fetch('/host.js')).text();
        await wc.fs.writeFile('/host.js', src);
      }
      try {
        await wc.fs.readFile('/lifo-core.js');
      } catch {
        const src = await (await fetch('/lifo-core.js')).text();
        void wc.fs.writeFile('/lifo-core.js', src).catch(() => {});
      }
    } catch {
      /* 资产注入失败：respawn 内部仍会尝试 */
    }
    await executor.respawn();
    term.writeln(`${AMBER}[  OK  ] host respawned — process table is clean${RESET}`);
    void log('WARN', 'host respawned; process table is fresh');
  } catch (e) {
    term.writeln(`${RED}[ FAIL ] host restart failed: ${String(e)}${RESET}`);
    void log('ERROR', `host restart failed: ${String(e)}`);
  }
}

// ─── 主流程（组装层）───
async function main(): Promise<void> {
  const ui = createBootUI(term);
  const logger = makeSessionLogger();
  const params = new URLSearchParams(location.search);
  // M5/U1 demo：?instance=<id> / ?user=<id> 走实例工厂（引擎级 boot + 应用级 bootsteps +
  // 聚合对象；?user 附带每用户 home 语义，见 bootSuccinix）。两者等价（同一字段），
  // 缺省路径（无参数 / default）= 现状行为全等。
  const demoId = params.get('user') ?? params.get('instance');
  if (demoId && demoId !== 'default') {
    await mainDemoInstance(ui, logger, demoId);
    return;
  }
  try {
    const boot = createTerminalBoot(ui, {
      steps: [...DEFAULT_BOOT_STEPS],
      testMode: params.get('test') === '1',
      onCommand: makeClientLogger(),
    });
    const services = await boot.boot();
    // 环境不适配：错误页已在覆盖层内显示，不进终端、不淡出。
    if (!services) return;
    const { wc, client, ports, hostProc } = services;

    // 命令式通道：包装已 boot 的 client（复用同一 host，不双 spawn）。
    const executor = createTerminalExecutor({ wc, client, hostProc });
    const rpcAdapter: TerminalRpc = {
      exec: (cmd, _opts, timeoutMs) => executor.exec(cmd, { timeoutMs }),
      spawn: (cmd, _opts, timeoutMs) => executor.spawn(cmd, { timeoutMs }),
      listProcesses: () => executor.listProcesses(),
      kill: (pid) => executor.kill(pid),
      ping: () => executor.ping(),
      pingDirect: (timeoutMs) => executor.pingDirect(timeoutMs),
      interruptDirect: (timeoutMs) => executor.interruptDirect(timeoutMs),
      readdir: (dir) => wc.fs.readdir(dir, { withFileTypes: true }),
    };

    let ctx: CommandContext;
    const getCtx = () => ctx;
    const session = new SuccinixTerminalSession(rpcAdapter, output, {
      localHandlers: makeLocalHandlers(getCtx),
      beforeRpc: async (cmd) => {
        // python/pip 命令（含链中段）首用前懒注入运行时资产（注入幂等，~13MB 仅一次）。
        if (tokenize(cmd.trim()).some((t) => t === 'python' || t === 'python3' || t === 'pip' || t === 'pip3')) {
          await ensurePythonRuntime(wc);
        }
      },
      onCommand: logger.onCommand,
      onCommandError: logger.onCommandError,
      onPrompt: benchMarkPrompt,
      colors: { red: (s) => RED + s + RESET, gray: (s) => GRAY + s + RESET, amber: (s) => AMBER + s + RESET },
    });
    term.onData((d) => session.handleData(d));

    ctx = { wc, client, ports, term, fit: () => fitAddon.fit(), hostProc };

    // TASK18：?bench=1 时暴露内部句柄（RPC 客户端 / 容器 FS / 终端 / 快照）。
    if (benchMode) {
      (window as unknown as { __succinixBench?: unknown }).__succinixBench = { client, wc, term, saveSnapshot };
    }

    // TASK19：?scenario=1 时暴露场景驱动句柄。
    if (scenarioMode) {
      (window as unknown as { __succinixScenario?: unknown }).__succinixScenario = {
        booted: true,
        client,
        wc,
        ports,
        term,
        saveSnapshot,
        run: (cmd: string, timeoutMs?: number) => scenarioRun(session, services, cmd, timeoutMs),
      };
    }

    // 应用持久化设置（TASK10）：font-size 在终端显示前生效。
    const fontSizeNum = Number(await getSetting(wc.fs, 'font-size'));
    if (Number.isInteger(fontSizeNum) && fontSizeNum >= 8 && fontSizeNum <= 72) {
      term.options.fontSize = fontSizeNum;
    }

    let testResult: TestResult | null = null;
    let testCrashed = '';
    if (boot.testMode) {
      try {
        testResult = await runTests({ wc, client, ports, term });
      } catch (e) {
        testCrashed = String(e);
        term.writeln(`${RED}[ FAIL ] self-test crashed: ${String(e)}${RESET}`);
      }
    }

    // boot（及可选自检）完成：移除错误页 DOM（终端全程可见）。
    await ui.complete();
    fitAddon.fit();

    // TASK16：自检结果进终端（complete() 之后、motd 横幅之前）。
    printTestResult(term, testResult, testCrashed);

    // 提示符准确性：boot 后取一次真实会话 cwd（host 启动已恢复 /etc/succinix.cwd 的持久值）。
    try {
      const cwdRes = await client.exec('cwd', undefined, 2000);
      if (cwdRes.cwd) session.setCwd(String(cwdRes.cwd));
    } catch {
      /* host cwd 不可得：保持 /workspace */
    }

    const motdText = await readMotd(wc.fs);
    if (motdText) {
      for (const line of motdText.split(/\r?\n/)) term.writeln(line);
    } else {
      term.writeln(WELCOME_BANNER);
    }

    // R1：解锁输入（session.boot 写首提示符；置于 motd 之后）。
    await session.boot();

    // 持久化主循环 + host 看门狗 + 服务就绪预览提示。
    startAutoSnapshot(wc.fs);
    startHostWatchdog(executor, wc);
    wc.on('server-ready', (port, url) => {
      term.writeln(`\r\n${AMBER}[preview]${RESET} Port ${port} ready -> ${url}`);
    });
  } catch (e) {
    // 启动期异常（host 未就绪等）：在覆盖层内显示错误页并停留。
    ui.fail([`Startup failed: ${String(e)}`], {
      header: 'Startup failed',
      footer: 'Check the browser console for the underlying error.',
    });
  }
}

// ─── M5 demo：?instance=<id> ───
// 组装走 bootSuccinix 的 demo 分支（createSuccinixInstance 引擎级 boot + 应用级 bootsteps）。
// 会话来自实例聚合对象（instance.terminal，restart 后自动指向新会话）；本地命令 ctx 注入
// instanceId / persist / restart / dispose —— snapshot/env/settings/service/motd 按实例解析。
async function mainDemoInstance(
  ui: ReturnType<typeof createBootUI>,
  logger: ReturnType<typeof makeSessionLogger>,
  instanceId: string
): Promise<void> {
  let ctx: CommandContext;
  const getCtx = () => ctx;
  // U1：?user=<id> 模式（userId 与 instanceId 等价）—— 提示符显示用户身份，guest 缺省不变。
  const userParam = new URLSearchParams(location.search).get('user');
  try {
    const services = await bootSuccinix(ui, {
      output,
      terminal: {
        promptPrefix: userParam ? `${userParam}@succinix:` : undefined,
        localHandlers: makeLocalHandlers(getCtx),
        beforeRpc: async (cmd) => {
          // python/pip 命令（含链中段）首用前懒注入运行时资产（注入幂等，~13MB 仅一次）。
          if (tokenize(cmd.trim()).some((t) => t === 'python' || t === 'python3' || t === 'pip' || t === 'pip3')) {
            await ensurePythonRuntime(getCtx().wc);
          }
        },
        onCommand: logger.onCommand,
        onCommandError: logger.onCommandError,
        onPrompt: benchMarkPrompt,
        colors: { red: (s) => RED + s + RESET, gray: (s) => GRAY + s + RESET, amber: (s) => AMBER + s + RESET },
      },
    });
    if (!services || !services.instance) return;
    const instance = services.instance;
    const { wc, client, ports } = services;

    ctx = {
      wc,
      client,
      ports,
      term,
      fit: () => fitAddon.fit(),
      instanceId,
      userId: userParam ?? undefined,
      persist: instance.persist,
      onInstanceReset: () => instance.restart(),
      onInstanceStop: () => void instance.dispose(),
    };
    term.onData((d) => instance.terminal.handleData(d));

    // TASK18：?bench=1 时暴露内部句柄（RPC 客户端 / 容器 FS / 终端 / 快照，按实例键）。
    if (benchMode) {
      (window as unknown as { __succinixBench?: unknown }).__succinixBench = {
        client,
        wc,
        term,
        saveSnapshot: (force?: boolean) => instance.persist.save(wc.fs, force),
      };
    }

    // TASK19：?scenario=1 时暴露场景驱动句柄。
    if (scenarioMode) {
      (window as unknown as { __succinixScenario?: unknown }).__succinixScenario = {
        booted: true,
        client,
        wc,
        ports,
        term,
        saveSnapshot: (force?: boolean) => instance.persist.save(wc.fs, force),
        run: (cmd: string, timeoutMs?: number) => scenarioRun(instance.terminal, services, cmd, timeoutMs),
      };
    }

    // 应用持久化设置（TASK10）：font-size 按实例 settings 解析。
    const fontSizeNum = Number(await getSetting(wc.fs, 'font-size', instanceId));
    if (Number.isInteger(fontSizeNum) && fontSizeNum >= 8 && fontSizeNum <= 72) {
      term.options.fontSize = fontSizeNum;
    }

    // 自检（?test=1）：demo 模式仍跑默认实例自检（M5 保留项，hooks 不降）。
    let testResult: TestResult | null = null;
    let testCrashed = '';
    if (new URLSearchParams(location.search).get('test') === '1') {
      try {
        testResult = await runTests({ wc, client, ports, term });
      } catch (e) {
        testCrashed = String(e);
        term.writeln(`${RED}[ FAIL ] self-test crashed: ${String(e)}${RESET}`);
      }
    }

    // boot（及可选自检）完成：移除错误页 DOM（终端全程可见）。
    await ui.complete();
    fitAddon.fit();
    printTestResult(term, testResult, testCrashed);

    // 提示符准确性：boot 后取一次真实会话 cwd（host 已按实例恢复 succinix.cwd 的持久值）。
    try {
      const cwdRes = await client.exec('cwd', undefined, 2000);
      if (cwdRes.cwd) instance.terminal.setCwd(String(cwdRes.cwd));
    } catch {
      /* host cwd 不可得：保持 /workspace */
    }

    const motdText = await readMotd(wc.fs, instanceId);
    if (motdText) {
      for (const line of motdText.split(/\r?\n/)) term.writeln(line);
    } else {
      term.writeln(WELCOME_BANNER);
    }

    // R1：解锁输入（session.boot 写首提示符；置于 motd 之后）。
    await instance.terminal.boot();

    // 持久化主循环（按实例键）+ host 看门狗（per-host，每页一个）+ 服务就绪预览提示。
    startAutoSnapshot(wc.fs, instance.persist);
    startHostWatchdog(instance.executor, wc);
    wc.on('server-ready', (port, url) => {
      term.writeln(`\r\n${AMBER}[preview]${RESET} Port ${port} ready -> ${url}`);
    });
  } catch (e) {
    // 启动期异常（host 未就绪等）：在覆盖层内显示错误页并停留。
    ui.fail([`Startup failed: ${String(e)}`], {
      header: 'Startup failed',
      footer: 'Check the browser console for the underlying error.',
    });
  }
}

void main();
