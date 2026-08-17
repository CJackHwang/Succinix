// app plugin: owns environment checks, engine boot, instance creation, app boot
// steps, and the page-level AppShell shared by the remaining app plugins.
import type { Context } from '@deepseek-ai/cordis';
import type { WebContainer } from '@webcontainer/api';
import {
  DEFAULT_INSTANCE_BOOT_STEPS,
  DEFAULT_INSTANCE_ID,
  instancePorts,
  statePath,
  checkEnvironment,
  detectSystemInfo,
  type SuccinixHostService,
  userHomePath,
  type TerminalClient,
  RpcTerminalClient,
  createTerminalIdentity,
  startBrowserControlBridge,
  startRuntimeAssetBridge,
  TERMINAL_MAX_BUFFER_BYTES,
} from '@succinix/engine';
import { pagePorts } from '../../engine/ports.js';
import { runApplicationBootSteps } from '../../boot-steps.js';
import { benchMarkPrompt, printTestResult } from '../../app/dev-hooks.js';
import { makeClientLogger } from '../../app/logging.js';
import { getSetting } from '../../config.js';
import { readMotd } from '../../motd.js';
import type { TestResult } from '../../selftest/index.js';
import { createBootUI } from '../../boot-ui.js';
import { ensureTerminal } from '../../app/xterm.js';
import {
  makeAppBoot,
  makeAppStepsContext,
  resolveInstanceRequest,
  WELCOME_BANNER,
} from '../bootstrap.js';
import { pluginSummaries } from './commands.js';
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
  const host = ctx.get('succinix', false) as SuccinixHostService | undefined;
  if (!host) {
    throw new Error('succinix-app-container requires the succinix service');
  }
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

  await ensureTerminal();
  const term = terminal.getTerm();
  const ui = createBootUI(term);
  const params = new URLSearchParams(location.search);
  const request = resolveInstanceRequest(params);
  const testMode = params.get('test') === '1';

  const failures = checkEnvironment();
  if (failures.length > 0) {
    ui.fail(failures);
    return null;
  }
  ui.systemInfo(detectSystemInfo());
  ui.log('Starting system services...', 'info');

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
    const wc = await host.boot({ executor: { onCommand: makeClientLogger() } });
    const instanceId = request.id ?? DEFAULT_INSTANCE_ID;
    const boot = makeAppBoot(ui, { testMode });
    const instance = await host.ensureInstance(instanceId, {
      home: request.userMode ? userHomePath(instanceId) : undefined,
      persistence: undefined,
      executor: { onCommand: makeClientLogger() },
      bootSteps: [...DEFAULT_INSTANCE_BOOT_STEPS],
      bootUI: ui,
      onRestart: ({ wc: nextWc, client: nextClient, ports: nextPorts }) =>
        runApplicationBootSteps(makeAppBoot(ui, { testMode }), stepsFor(nextWc, nextClient, nextPorts)),
    });
    await runApplicationBootSteps(boot, stepsFor(wc, instance.client, instance.ports));
    // Re-apply a non-default instance snapshot after the application has
    // established its state paths. This makes the restored workspace exact
    // across a page refresh without changing the default-instance boot path.
    if (instanceId !== DEFAULT_INSTANCE_ID) await instance.snapshot.restore();

    const interactive = new RpcTerminalClient({
      fs: {
        readFile: (path, encoding) => wc.fs.readFile(path, encoding as 'utf8'),
        writeFile: (path, content) => wc.fs.writeFile(path, content),
        readdir: async (path) => (await wc.fs.readdir(path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        })),
        mkdir: async (path, options) => {
          if (options?.recursive) await wc.fs.mkdir(path, { recursive: true });
          else await wc.fs.mkdir(path);
        },
        rm: (path, options) => wc.fs.rm(path, options),
        rename: (from, to) => wc.fs.rename(from, to),
      },
      // Mailbox paths escape the raw value.  Keep the actual instanceId in
      // every frame so it selects the same per-instance SandboxContext as
      // batch RPC (for example `users/alice` must not become `users_alice`).
      identity: createTerminalIdentity(instanceId),
      cols: term.cols,
      rows: term.rows,
      onOutput: (data) => {
        term.write(data);
        // v0.7: the human shell is a Lifo Shell inside WebContainer; the first
        // frame reaching the browser is the first visible output (prompt).
        // benchMarkPrompt() is idempotent (single-shot guard inside).
        benchMarkPrompt();
      },
      onControl: (control, frame) => {
        if (control !== 'backpressure') return;
        ctx.emit('succinix/terminal-backpressure', {
          instanceId,
          sessionId: interactive.sessionId,
          bootNonce: interactive.bootNonce,
          queuedBytes: typeof frame.bufferedBytes === 'number' ? frame.bufferedBytes : 0,
          limitBytes: TERMINAL_MAX_BUFFER_BYTES,
        });
      },
    });
    const runtimeAssets = startRuntimeAssetBridge(wc, {
      onError: (runtime, error) => {
        console.error(`[runtime:${runtime}] asset injection failed`, error);
        ctx.emit('succinix/degradation', {
          code: 'RUNTIME_ASSET_INJECTION_FAILED',
          message: `runtime asset injection failed for ${runtime}: ${String(error)}`,
          runtime,
          retryable: true,
          degraded: true,
          instanceId,
        });
      },
    });
    const browserControl = startBrowserControlBridge(wc, {
      handlers: {
        snapshot: async (request) => {
          if (request.instanceId !== instanceId) throw new Error('control request targets another instance');
          const mode = request.args?.mode;
          if (mode === 'save') {
            const result = await instance.persist.save(wc.fs, true);
            return { mode, ...result };
          }
          if (mode === 'meta') return { mode, meta: await instance.persist.meta() };
          if (mode === 'clear') {
            await instance.persist.clear();
            return { mode, cleared: true };
          }
          throw new Error('unsupported snapshot control mode');
        },
        reboot: (request) => {
          if (request.instanceId !== instanceId) throw new Error('control request targets another instance');
          // Write the successful control response before replacing the page or
          // instance, so the execution-world command can finish cleanly.
          setTimeout(() => {
            if (instanceId === DEFAULT_INSTANCE_ID) location.reload();
            else void instance.restart().then(() => interactive.renewBootNonce()).catch((error) => {
              console.error('[control:reboot] instance restart failed', error);
            });
          }, 300);
          return { scheduled: true, scope: instanceId === DEFAULT_INSTANCE_ID ? 'page' : 'instance' };
        },
        status: (request) => {
          if (request.instanceId !== instanceId) throw new Error('control request targets another instance');
          return { state: host.state, plugins: pluginSummaries(ctx) };
        },
        plugins: (request) => {
          if (request.instanceId !== instanceId) throw new Error('control request targets another instance');
          return { plugins: pluginSummaries(ctx) };
        },
        ports: (request) => {
          if (request.instanceId !== instanceId) throw new Error('control request targets another instance');
          const mode = request.args?.mode;
          const port = request.args?.port;
          const reconcilePorts = () => {
            const ready = pagePorts.readyPorts();
            if (instanceId === DEFAULT_INSTANCE_ID) {
              instance.ports.clear();
              for (const [readyPort, url] of ready) instance.ports.set(readyPort, url);
              return;
            }
            for (const readyPort of [...instance.ports.keys()]) {
              if (!ready.has(readyPort) || !instancePorts.expects(instanceId, readyPort)) instance.ports.delete(readyPort);
            }
            for (const [readyPort, url] of ready) {
              if (instancePorts.expects(instanceId, readyPort)) instance.ports.set(readyPort, url);
            }
          };
          if (mode === 'expect' || mode === 'release') {
            if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) {
              throw new Error('invalid port control request');
            }
            if (mode === 'expect') instancePorts.expect(instanceId, Number(port));
            else instancePorts.release(instanceId, Number(port));
            reconcilePorts();
            return { mode, port: Number(port), generation: pagePorts.currentGeneration() };
          }
          reconcilePorts();
          return {
            ports: [...instance.ports.entries()].map(([port, url]) => ({
              port,
              url,
              generation: pagePorts.generationFor(port),
            })),
          };
        },
        environment: async (request) => {
          if (request.instanceId !== instanceId) throw new Error('control request targets another instance');
          const content = request.args?.content;
          if (typeof content !== 'string' || content.length > 64 * 1024) throw new Error('invalid environment control payload');
          const file = statePath(instanceId, 'etc/succinix.env');
          await wc.fs.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
          await wc.fs.writeFile(file, content);
          return { written: true };
        },
      },
      onError: (action, error) => {
        console.error(`[control:${action}] bridge failed`, error);
      },
    });
    const built: AppShell = {
      instance,
      wc,
      client: instance.client,
      ports: instance.ports,
      executor: instance.executor,
      interactive,
      runtimeAssets,
      term,
      ui,
      instanceId,
      userId: request.userMode ? (request.id ?? undefined) : undefined,
      fit: () => terminal.fit(),
      saveSnapshot: (force) => instance.persist.save(wc.fs, force),
      onInstanceReset: async () => {
        await instance.restart();
        await interactive.renewBootNonce();
      },
      onInstanceStop: async () => {
        snapshot?.stop();
        watchdog?.stop();
        runtimeAssets.stop();
        browserControl.stop();
        await interactive.dispose();
        ctx.emit('succinix/terminal-close', {
          instanceId,
          sessionId: interactive.sessionId,
          bootNonce: interactive.bootNonce,
        });
        await instance.dispose();
      },
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

    const motdText = await readMotd(wc.fs, instanceId, built.instance.statePrefix);
    if (motdText) {
      for (const line of motdText.split(/\r?\n/)) term.writeln(line);
    } else {
      term.writeln(WELCOME_BANNER);
    }

    // The human shell is started exactly once by `Sandbox.create({ terminal })`
    // inside WebContainer.  Do not boot the legacy browser-side line editor;
    // the SDK session remains available for non-UI consumers during migration.
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

const plugin = { name, apply };
export default plugin;
