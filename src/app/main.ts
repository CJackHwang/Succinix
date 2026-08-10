// Succinix 入口（组装层，O2 拆分）：main 只负责启动顺序与装配。
// E3：xterm 呈现 + 应用特性（看门狗/自动快照/开发钩子）+ 装配 Terminal SDK。
// 交互状态机（历史/补全/真中断/队列/提示符 cwd）在 src/terminal/session.ts；
// 命令实现域在 src/commands/；应用特性模块在 src/app/。
import { bootSuccinix } from '../boot.js';
import { createBootUI } from '../boot-ui.js';
import type { CommandContext } from '../commands.js';
import { tokenize } from '../engine/tokenize.js';
import { ensurePythonRuntime, createTerminalExecutor } from '../engine/index.js';
import { runTests, type TestResult } from '../tests.js';
import { saveSnapshot } from '../persist.js';
import { getSetting } from '../config.js';
import { readMotd } from '../motd.js';
import { AMBER, RED, GRAY, RESET } from '../theme.js';
import { SUCCINIX_VERSION } from '../version.js';
import { SuccinixTerminalSession, type TerminalRpc } from '../terminal/index.js';
import { term, fitAddon } from './xterm.js';
import { output } from './output.js';
import { makeLocalHandlers } from './local-commands.js';
import { makeSessionLogger } from './logging.js';
import { startAutoSnapshot } from './auto-snapshot.js';
import { startHostWatchdog } from './watchdog.js';
import { benchMode, scenarioMode, benchMarkPrompt, scenarioRun, printTestResult, installDevHooks } from './dev-hooks.js';

// 欢迎横幅：boot 日志之后显示在终端里。默认横幅由 /etc/succinix.motd 提供（可编辑、
// 随快照持久）；此处仅作 motd 文件缺失时的兜底。版本号构建期注入（随 package.json 单一来源）。
const WELCOME_BANNER =
  `Succinix ${SUCCINIX_VERSION} — kernel: JS runtime + WebContainer | userland: Lifo | exec: TerminalExecutor\n` +
  `Type 'help' to see available commands.`;

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
    const services = await bootSuccinix(ui);
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

    // TASK18/TASK19：?bench=1 / ?scenario=1 暴露内部句柄（dev-hooks.ts）。
    installDevHooks({
      benchMode,
      scenarioMode,
      client,
      wc,
      ports,
      term,
      saveSnapshot,
      run: (cmd: string, timeoutMs?: number) => scenarioRun(session, services, cmd, timeoutMs),
    });

    // 应用持久化设置（TASK10）：font-size 在终端显示前生效。
    const fontSizeNum = Number(await getSetting(wc.fs, 'font-size'));
    if (Number.isInteger(fontSizeNum) && fontSizeNum >= 8 && fontSizeNum <= 72) {
      term.options.fontSize = fontSizeNum;
    }

    let testResult: TestResult | null = null;
    let testCrashed = '';
    if (params.get('test') === '1') {
      try {
        testResult = await runTests({ wc, client, ports, term });
      } catch (e) {
        testCrashed = String(e);
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

    // TASK18/TASK19：?bench=1 / ?scenario=1 暴露内部句柄（按实例键，dev-hooks.ts）。
    installDevHooks({
      benchMode,
      scenarioMode,
      client,
      wc,
      ports,
      term,
      saveSnapshot: (force?: boolean) => instance.persist.save(wc.fs, force),
      run: (cmd: string, timeoutMs?: number) => scenarioRun(instance.terminal, services, cmd, timeoutMs),
    });

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
