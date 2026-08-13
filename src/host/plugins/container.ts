// app plugin: owns environment checks, engine boot, instance creation, app boot
// steps, and the page-level AppShell shared by the remaining app plugins.
import type { Context } from 'cordis';
import type { WebContainer } from '@webcontainer/api';
import {
  DEFAULT_INSTANCE_BOOT_STEPS,
  DEFAULT_INSTANCE_ID,
  checkEnvironment,
  detectSystemInfo,
  userHomePath,
  type TerminalClient,
} from '@succinix/engine';
import { runApplicationBootSteps } from '../../boot-steps.js';
import { benchMarkPrompt, printTestResult } from '../../app/dev-hooks.js';
import { makeClientLogger, makeSessionLogger } from '../../app/logging.js';
import { getSetting } from '../../config.js';
import { readMotd } from '../../motd.js';
import { AMBER, GRAY, RED, RESET } from '../../theme.js';
import type { TestResult } from '../../tests.js';
import { createBootUI } from '../../boot-ui.js';
import {
  makeAppBoot,
  makeAppStepsContext,
  resolveInstanceRequest,
  WELCOME_BANNER,
} from '../bootstrap.js';
import type {
  AppCommandsService,
  AppContainerService,
  AppDevhooksService,
  AppSelftestService,
  AppShell,
  AppShellService,
  AppSnapshotService,
  AppTerminalService,
  AppWatchdogService,
} from '../types.js';

export const name = 'succinix-app-container';

async function startHostApp(ctx: Context): Promise<AppShell | null> {
  const terminal = ctx.get('succinix-app-terminal') as AppTerminalService | undefined;
  const commands = ctx.get('succinix-app-commands') as AppCommandsService | undefined;
  const selftest = ctx.get('succinix-app-selftest') as AppSelftestService | undefined;
  const snapshot = ctx.get('succinix-app-snapshot') as AppSnapshotService | undefined;
  const watchdog = ctx.get('succinix-app-watchdog') as AppWatchdogService | undefined;
  const devhooks = ctx.get('succinix-app-devhooks') as AppDevhooksService | undefined;
  const shellService = ctx.get('succinix-app-shell') as AppShellService | undefined;
  if (!terminal || !commands) {
    throw new Error('succinix-app-container requires succinix-app-terminal and succinix-app-commands');
  }

  const term = terminal.getTerm();
  const output = terminal.getOutput();
  const ui = createBootUI(term);
  const params = new URLSearchParams(location.search);
  const request = resolveInstanceRequest(params);
  const testMode = params.get('test') === '1';
  const logger = makeSessionLogger();

  const failures = checkEnvironment();
  if (failures.length > 0) {
    ui.fail(failures);
    return null;
  }
  ui.systemInfo(detectSystemInfo());
  ui.log('Starting system services...', 'info');

  const localHandlers = commands.makeHandlers();
  const stepsFor = (wc: WebContainer, client: TerminalClient, ports: Map<number, string>) =>
    makeAppStepsContext({
      wc,
      client,
      ports,
      instanceId: request.id ?? DEFAULT_INSTANCE_ID,
      userMode: request.userMode,
      skipHostReady: true,
    });

  try {
    const wc = await ctx.succinix.boot({ executor: { onCommand: makeClientLogger() } });
    const instanceId = request.id ?? DEFAULT_INSTANCE_ID;
    const boot = makeAppBoot(ui, { testMode });
    const instance = await ctx.succinix.ensureInstance(instanceId, {
      output,
      terminal: {
        promptPrefix: request.userMode ? `${request.id}@succinix:` : 'guest@succinix:',
        localHandlers,
        onCommand: logger.onCommand,
        onCommandError: logger.onCommandError,
        onPrompt: benchMarkPrompt,
        colors: {
          red: (s) => RED + s + RESET,
          gray: (s) => GRAY + s + RESET,
          amber: (s) => AMBER + s + RESET,
        },
      },
      home: request.userMode ? userHomePath(instanceId) : undefined,
      persistence: undefined,
      executor: { onCommand: makeClientLogger() },
      bootSteps: [...DEFAULT_INSTANCE_BOOT_STEPS],
      bootUI: ui,
      onRestart: ({ wc: nextWc, client: nextClient, ports: nextPorts }) =>
        runApplicationBootSteps(makeAppBoot(ui, { testMode }), stepsFor(nextWc, nextClient, nextPorts)),
    });
    await runApplicationBootSteps(boot, stepsFor(wc, instance.client, instance.ports));

    const built: AppShell = {
      instance,
      wc,
      client: instance.client,
      ports: instance.ports,
      executor: instance.executor,
      term,
      output,
      ui,
      instanceId,
      userId: request.userMode ? (request.id ?? undefined) : undefined,
      fit: () => terminal.fit(),
      saveSnapshot: (force) => instance.persist.save(wc.fs, force),
      onInstanceReset: () => instance.restart(),
      onInstanceStop: () => instance.dispose(),
    };
    shellService?.setShell(built);
    terminal.wire(built);
    commands.attach(built);
    devhooks?.attach(built);

    const fontSizeNum = Number(await getSetting(wc.fs, 'font-size', instanceId, built.instance.statePrefix));
    if (Number.isInteger(fontSizeNum) && fontSizeNum >= 8 && fontSizeNum <= 72) {
      term.options.fontSize = fontSizeNum;
    }

    let testResult: TestResult | null = null;
    let testCrashed = '';
    if (testMode) {
      try {
        testResult = (await selftest?.run(built)) ?? null;
      } catch (e) {
        testCrashed = String(e);
      }
    }

    await ui.complete();
    terminal.fit();
    printTestResult(term, testResult, testCrashed);

    try {
      const cwdRes = await built.client.exec('cwd', undefined, 2000);
      if (cwdRes.cwd) built.instance.terminal.setCwd(String(cwdRes.cwd));
    } catch {
      /* host cwd unavailable: keep the seeded session cwd */
    }

    const motdText = await readMotd(wc.fs, instanceId, built.instance.statePrefix);
    if (motdText) {
      for (const line of motdText.split(/\r?\n/)) term.writeln(line);
    } else {
      term.writeln(WELCOME_BANNER);
    }

    await built.instance.terminal.boot();
    snapshot?.attach(built);
    watchdog?.attach(built);
    return built;
  } catch (e) {
    ui.fail([`Startup failed: ${String(e)}`], {
      header: 'Startup failed',
      footer: 'Check the browser console for the underlying error.',
    });
    return null;
  }
}

export function apply(ctx: Context): void {
  let shell: AppShell | null = null;
  let starting: Promise<AppShell | null> | null = null;

  const shellService: AppShellService = {
    getShell: () => shell,
    setShell: (next) => {
      shell = next;
    },
  };
  ctx.provide('succinix-app-shell', shellService);

  const containerService: AppContainerService = {
    getShell: () => shell,
    start: () => {
      if (starting) return starting;
      starting = startHostApp(ctx);
      return starting;
    },
  };
  ctx.provide('succinix-app-container', containerService);

  ctx.effect(() => () => {
    shellService.setShell(null);
  });
}

const plugin = { name, inject: ['succinix'] as const, apply };
export default plugin;
