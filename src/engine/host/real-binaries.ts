// host real-binary command adapters (split from run.ts for the 450-line gate):
// register Lifo commands that forward to real Node/Python/Ruby subprocesses, the
// succinix management surface, fail-closed denylist, and interactive editors.
// All commands share the per-instance SandboxContext from run.ts.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pythonDaemon, PYTHON_DAEMON_JS } from '../python-daemon-client.js';
import { WORKSPACE_MOUNT, canonicalizeVirtualPath, pythonRuntimeArgs, lifoSpawndCwd, withEaccesHint } from '../host-route.js';
import { hasShellMetaToken, tryTokenize } from '../tokenize.js';
import { getSessionCwd, mergedEnv, setSessionCwd } from './config.js';
import { PROCESS_TERMINATION_GRACE_MS, killProcess, registerProcess } from '../host-procs.js';
import { attachOutputCollector } from './spawn.js';
import { createServiceCommandBridge } from './service-command-bridge.js';
import { decodeServiceCommand } from './service-world.js';
import { runPackageManagement } from './package-world.js';
import { createWorkspaceCommand } from './workspace-world.js';
import { createProjectCommand } from './project-world.js';
import { requestBrowserControl } from './control.js';
import { registerRuntimeCommands } from './runtime-commands.js';
import { USERLAND_DENYLIST, USERLAND_PROFILE, defaultUserlandCapabilities, deniedCommandCapability } from '../../userland/index.js';
import { TerminalBackpressureError } from '../../terminal/transport-protocol.js';
import type { runGitCommand } from './git-world.js';

type LifoSandbox = Awaited<ReturnType<typeof import('../lifo-core.js').Sandbox.create>>;
type GitCommandRunner = typeof runGitCommand;

export { runShellScript } from './runtime-commands.js';

// python 命令默认超时（比 node 子进程宽松）：首个命令含 daemon 懒启动 + 可能的重装恢复，
// pip install 走网络拉 wheel —— 120s 内可完成；daemon 内部也有同等超时兜底。
export const PYTHON_TIMEOUT_MS = 150000;

// 与 runNode 的 spawnCwd(instanceId) 语义一致；非共享的 Lifo 私有 cwd 必须拒绝。
export function registerRealBinaryCommands(
  sandbox: LifoSandbox,
  instanceId: string,
  options: {
    runGitCommand?: GitCommandRunner;
    /** Project a Lifo-local PID into the host-wide public process namespace. */
    projectLifoPid?: (localPid: number, name?: string) => number | undefined;
  } = {},
): void {
  // M2：Lifo 混合链的 node/python 转发在「当前在途请求」的实例上下文里执行（单 host 串行
  // 处理请求，currentInstanceId() 即请求所属实例）；cwd/环境按该实例解析。
  const lifoSpawnCwd = (vfsCwd: string): string | null => lifoSpawndCwd(vfsCwd, getSessionCwd(instanceId), process.cwd());
  const resolveGitAbsolutePath = (requested: string): string | null => {
    let virtualPath: string;
    try {
      virtualPath = canonicalizeVirtualPath(requested);
    } catch {
      return null;
    }
    if (virtualPath !== WORKSPACE_MOUNT && !virtualPath.startsWith(`${WORKSPACE_MOUNT}/`)) return null;
    return lifoSpawnCwd(virtualPath);
  };
  // 共享转发：spawn 一个真实子进程，stdout/stderr 累积后写入 Lifo 命令上下文流；
  // 超时/中断（Lifo shell 的 signal）时子进程一并杀掉。
  // V1 H1-2：把 Lifo 混合链拉起的 node/npm/npx 真实子进程登记进 host 进程表（host-procs.ts），
  // 使前台 `cd <root> && npm test` 这类混合链命令的活跃子进程在 ps() 可见、kill 可终止——
  // 此前它们只在 Lifo shell 内部运行，UI 进程表完全不可见。
  // TASK-CISOL（R1）：登记时带上 spawn 的启动 cwd（realCwd），host-procs 据此判定容器归属
  // （cd /workspace/c-<id> 前缀 → 子进程 cwd 落在容器根 → scope=container + containerId）。
  const forward = (
    ctx: { stdout: { write(s: string): void }; stderr: { write(s: string): void }; signal?: AbortSignal | null },
    child: ReturnType<typeof spawn>,
    cmd: string,
    realCwd: string,
    runtime: 'node' | 'ruby' = 'node'
  ): Promise<number> => {
    // M5：Lifo 混合链转发进程同样按请求实例显式归属（cwd 可能是容器 home，无状态根段）。
    // The Lifo ProcessRegistry wrapper is the public process. Keep the real
    // child internally tracked for output/cleanup without exposing a duplicate
    // ps row; killing the wrapper aborts this child through ctx.signal below.
    const pid = registerProcess(cmd, child, realCwd, instanceId, { runtime, internal: true });
    // both：既累积（写 ctx 流）也追加进程表（ps/kill 可见）。
    const out = attachOutputCollector(child, pid, 'both');
    const onAbort = () => { killProcess(pid, PROCESS_TERMINATION_GRACE_MS, 'SIGINT'); };
    ctx.signal?.addEventListener('abort', onAbort);
    return new Promise<number>((resolve) => {
      child.on('close', (code) => {
        ctx.signal?.removeEventListener('abort', onAbort);
        out.flush();
        try {
          ctx.stdout.write(out.stdout());
          ctx.stderr.write(withEaccesHint(out.stderr()));
        } catch (error) {
          // A terminal device may refuse an oversized final write while
          // emitting its backpressure control frame. The child is complete;
          // preserve shell progress instead of escaping from this callback.
          if (!(error instanceof TerminalBackpressureError)) throw error;
        }
        resolve(code ?? -1);
      });
      child.on('error', (e: Error) => {
        ctx.signal?.removeEventListener('abort', onAbort);
        try { ctx.stderr.write(String(e)); } catch (error) {
          if (!(error instanceof TerminalBackpressureError)) throw error;
        }
        resolve(-1);
      });
    });
  };

  // ServiceManager tokenizes ExecStart by whitespace. Complex service commands
  // therefore arrive through this execution-world runner with their original
  // command line encoded in the unit file, preserving quotes and shell args.
  sandbox.commands.register('succinix-service-run', async (ctx) => {
    if (ctx.args.length !== 1) {
      ctx.stderr.write('succinix-service-run: invalid command payload\n');
      return 2;
    }
    const command = decodeServiceCommand(ctx.args[0]!);
    if (!command) {
      ctx.stderr.write('succinix-service-run: invalid command payload\n');
      return 2;
    }
    const parsed = tryTokenize(command);
    if (!parsed.ok || hasShellMetaToken(parsed.tokens)) {
      ctx.stderr.write('succinix-service-run: shell operators are unsupported\n');
      return 2;
    }
    const [program, ...args] = parsed.tokens;
    if (!program) return 127;
    if (program === 'node' || program === 'npm' || program === 'npx') {
      const realCwd = lifoSpawnCwd(ctx.cwd);
      if (!realCwd) {
        ctx.stderr.write(`succinix-service-run: cwd is outside the shared workspace: ${ctx.cwd}\n`);
        return 1;
      }
      const child = spawn(program, args, { cwd: realCwd, env: mergedEnv(instanceId) });
      const code = await forward(ctx, child, [program, ...args].join(' '), realCwd);
      return code;
    }
    const handler = await sandbox.shell?.getRegistry().resolve(program);
    if (!handler) {
      ctx.stderr.write(`${program}: command not found\n`);
      return 127;
    }
    return handler({ ...ctx, args });
  });

  for (const name of ['node', 'npm', 'npx']) {
    sandbox.commands.register(name, async (ctx) => {
      const realCwd = lifoSpawnCwd(ctx.cwd);
      if (!realCwd) {
        ctx.stderr.write(`${name}: cwd is outside the shared workspace: ${ctx.cwd}\n`);
        return 1;
      }
      const child = spawn(name, ctx.args, { cwd: realCwd, env: mergedEnv(instanceId) });
      return forward(ctx, child, [name, ...ctx.args].join(' '), realCwd);
    });
  }
  sandbox.commands.register('git', async (ctx) => {
    if (!options.runGitCommand) {
      ctx.stderr.write('git: runtime adapter is unavailable\n');
      return 69;
    }
    const dir = lifoSpawnCwd(ctx.cwd);
    if (!dir) {
      ctx.stderr.write(`git: cwd is outside the shared workspace: ${ctx.cwd}\n`);
      return 1;
    }
    return options.runGitCommand(ctx, { dir, fs, resolveAbsolutePath: resolveGitAbsolutePath });
  });
  // TASK27：python/pip 命令含 shell 元字符时整条经 Lifo shell 执行（真管道），python 段
  // 转发到常驻 Pyodide daemon（python-daemon-client）。资产未注入时给明确错误，与 runPython 一致。
  const pythonForward = async (
    ctx: { stdout: { write(s: string): void }; stderr: { write(s: string): void }; cwd: string },
    args: string[]
  ): Promise<number> => {
    if (!fs.existsSync(PYTHON_DAEMON_JS)) {
      ctx.stderr.write(
        'python runtime failed to load: assets not injected yet — run any other command first, or refresh the page (the runtime is injected on first use)'
      );
      return -1;
    }
    const cwd = lifoSpawnCwd(ctx.cwd);
    if (!cwd) {
      ctx.stderr.write(`python: cwd is outside the shared workspace: ${ctx.cwd}\n`);
      return 1;
    }
    const r = await pythonDaemon.exec(args, cwd, PYTHON_TIMEOUT_MS);
    ctx.stdout.write(r.stdout);
    ctx.stderr.write(withEaccesHint(r.stderr));
    return r.exitCode;
  };
  for (const name of ['python', 'python3']) {
    sandbox.commands.register(name, async (ctx) => pythonForward(ctx, pythonRuntimeArgs(ctx.args, process.cwd())));
  }
  for (const name of ['pip', 'pip3']) {
    sandbox.commands.register(name, async (ctx) => pythonForward(ctx, ['-m', 'pip', ...ctx.args]));
  }

  // Replace Lifo's colorized systemctl renderer with the Succinix contract;
  // lifecycle operations still execute through the same ServiceManager and
  // ProcessRegistry owned by this Sandbox.
  const systemctlCommand = createServiceCommandBridge(
    sandbox.kernel.serviceManager,
    instanceId,
    requestBrowserControl,
    { projectPid: options.projectLifoPid },
  );
  sandbox.commands.register('systemctl', systemctlCommand);
  sandbox.commands.register('env', async (ctx) => {
    if (ctx.args.length === 0) {
      for (const [key, value] of Object.entries(sandbox.env).sort(([a], [b]) => a.localeCompare(b))) {
        ctx.stdout.write(`${key}=${value}\n`);
      }
      return 0;
    }
    if (ctx.args[0] === '-u' || ctx.args[0] === '--unset') {
      const key = ctx.args[1];
      if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        ctx.stderr.write('env: usage: env -u NAME\n');
        return 2;
      }
      delete sandbox.env[key];
      return 0;
    }
    for (const assignment of ctx.args) {
      const separator = assignment.indexOf('=');
      if (separator <= 0) {
        ctx.stderr.write(`env: invalid assignment '${assignment}'\n`);
        return 2;
      }
      const key = assignment.slice(0, separator);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        ctx.stderr.write(`env: invalid variable name '${key}'\n`);
        return 2;
      }
      sandbox.env[key] = assignment.slice(separator + 1);
    }
    return 0;
  });
  sandbox.commands.register('whoami', async (ctx) => {
    ctx.stdout.write(`${instanceId === 'default' ? 'guest' : instanceId}\n`);
    return 0;
  });
  const workspaceCommand = createWorkspaceCommand({
    sandbox,
    onSwitch: async (cwd) => {
      setSessionCwd(instanceId, cwd);
      // A workspace switch may only change same-sized metadata. Flush it now
      // so an immediate page reload cannot outrun the regular snapshot timer.
      await requestBrowserControl('snapshot', instanceId, { args: { mode: 'save' } });
    },
    remove: (name) => fs.rmSync(path.join(process.cwd(), 'ws', name), { recursive: true, force: true }),
  });
  const browserControl = async (
    ctx: { stdout: { write(s: string): void }; stderr: { write(s: string): void } },
    action: 'snapshot' | 'reboot' | 'status' | 'plugins' | 'ports',
    args?: Record<string, unknown>,
  ): Promise<unknown | undefined> => {
    try {
      return await requestBrowserControl(action, instanceId, { args });
    } catch (error) {
      ctx.stderr.write(`succinix: ${action}: ${error instanceof Error ? error.message : String(error)}\n`);
      return undefined;
    }
  };
  const openPreview = async (ctx: Parameters<import('@lifo-sh/core').Command>[0], requestedPort?: number): Promise<number> => {
    const result = await browserControl(ctx, 'ports') as { ports?: Array<{ port?: unknown; url?: unknown }> } | undefined;
    if (!result) return 69;
    const ports = (result.ports ?? []).filter((entry) => Number.isInteger(entry.port) && typeof entry.url === 'string');
    const match = requestedPort === undefined ? ports[0] : ports.find((entry) => entry.port === requestedPort);
    if (!match) {
      ctx.stderr.write(requestedPort === undefined
        ? 'succinix: open: no preview URL is ready\n'
        : `succinix: open: no preview URL is ready for port ${requestedPort}\n`);
      return 1;
    }
    ctx.stdout.write(`[preview] ${match.url}\n`);
    return 0;
  };
  const projectCommand = createProjectCommand(sandbox, openPreview);

  // Browser-only management commands are intentionally not reimplemented in
  // the UI.  This execution-world command owns the stable capability/doctor
  // surface and delegates package/service operations to the same Lifo
  // registry used by the human shell and batch RPC.
  sandbox.commands.register('succinix', async (ctx) => {
    const [area = 'help', ...args] = ctx.args;
    if (area === 'help' || area === '--help' || area === '-h') {
      ctx.stdout.write(
        'Succinix userland management\n' +
        'Usage: succinix <doctor|capabilities|pkg|service|runtime|workspace|snapshot|reboot|status|plugins|net|init|run|serve|open> [arguments]\n',
      );
      return 0;
    }
    if (area === 'doctor') {
      ctx.stdout.write(`[  OK  ] profile ${USERLAND_PROFILE}\n`);
      ctx.stdout.write('[  OK  ] execution world WebContainer/Lifo\n');
      ctx.stdout.write('[  OK  ] shared filesystem /workspace\n');
      ctx.stdout.write('[  OK  ] terminal Lifo ITerminal transport\n');
      ctx.stdout.write('[SKIP] kernel, permission bits, native binaries, and inbound networking are unavailable\n');
      return 0;
    }
    if (area === 'capabilities') {
      ctx.stdout.write(`PROFILE  ${USERLAND_PROFILE}\n`);
      ctx.stdout.write('COMMAND  STATUS       RUNTIME  EXECUTION    LIMITATIONS\n');
      const rows = [
        ...defaultUserlandCapabilities(),
        ...USERLAND_DENYLIST.map((name) => deniedCommandCapability(name)),
      ].sort((a, b) => a.name.localeCompare(b.name));
      for (const item of rows) {
        ctx.stdout.write(`${item.name.padEnd(8)} ${item.status.padEnd(12)} ${item.runtime.padEnd(8)} ${item.execution.padEnd(12)} ${item.limitations?.join('; ') ?? '-'}\n`);
      }
      return 0;
    }
    if (area === 'runtime') {
      ctx.stdout.write('RUNTIME  STATUS\n');
      ctx.stdout.write('node     ready\n');
      ctx.stdout.write('lifo     ready\n');
      ctx.stdout.write(`python   ${fs.existsSync(PYTHON_DAEMON_JS) ? 'ready' : 'lazy'}\n`);
      ctx.stdout.write('ruby     lazy (WASM)\n');
      ctx.stdout.write('wasi     ready through node:wasi adapter\n');
      return 0;
    }
    if (area === 'pkg') return runPackageManagement(ctx, sandbox, args);
    if (area === 'workspace') return workspaceCommand({ ...ctx, args });
    if (area === 'service') return systemctlCommand({ ...ctx, args });
    if (area === 'snapshot') {
      const [operation = 'status', confirmation] = args;
      if (operation === 'clear' && confirmation !== '--yes') {
        ctx.stderr.write('succinix snapshot: confirm clear with: succinix snapshot clear --yes\n');
        return 2;
      }
      if (!['status', 'now', 'clear'].includes(operation)) {
        ctx.stderr.write('usage: succinix snapshot | succinix snapshot now | succinix snapshot clear --yes\n');
        return 2;
      }
      const mode = operation === 'status' ? 'meta' : operation === 'now' ? 'save' : 'clear';
      const result = await browserControl(ctx, 'snapshot', { mode }) as {
        meta?: { savedAt?: unknown; fileCount?: unknown; totalBytes?: unknown }; cleared?: boolean;
      } | undefined;
      if (!result) return 69;
      if (mode === 'clear') {
        ctx.stdout.write('Snapshot cleared; the next boot starts with a fresh workspace.\n');
      } else if (!result.meta || !Number(result.meta.savedAt)) {
        ctx.stdout.write('Persistent storage: no snapshot yet (fresh workspace)\n');
      } else if (mode === 'save') {
        ctx.stdout.write(`Snapshot saved: ${String(result.meta.fileCount ?? 0)} files, ${Math.round(Number(result.meta.totalBytes ?? 0) / 1024)} KB\n`);
      } else {
        ctx.stdout.write(`Persistent storage: snapshot found (${String(result.meta.fileCount ?? 0)} files, ${Math.round(Number(result.meta.totalBytes ?? 0) / 1024)} KB)\n`);
      }
      return 0;
    }
    if (area === 'reboot') {
      const result = await browserControl(ctx, 'reboot') as { scope?: unknown } | undefined;
      if (!result) return 69;
      ctx.stdout.write(result.scope === 'instance' ? `Rebooting instance '${instanceId}'...\n` : 'Rebooting Succinix...\n');
      return 0;
    }
    if (area === 'status' || area === 'plugins') {
      const result = await browserControl(ctx, area) as {
        state?: { version?: unknown; containerState?: unknown; instances?: unknown[]; capabilities?: unknown[] };
        plugins?: Array<{ name?: unknown; fibers?: Array<{ state?: unknown }> }>;
      } | undefined;
      if (!result) return 69;
      if (area === 'status') {
        const state = result.state;
        ctx.stdout.write('Succinix plugin status\n');
        ctx.stdout.write(`  version          ${String(state?.version ?? '--')}\n`);
        ctx.stdout.write(`  containerState   ${String(state?.containerState ?? '--')}\n`);
        ctx.stdout.write(`  instances        ${String(state?.instances?.length ?? 0)}\n`);
        ctx.stdout.write(`  capabilities     ${(state?.capabilities ?? []).map(String).join(', ') || '(none)'}\n`);
        return 0;
      }
      const plugins = result.plugins ?? [];
      ctx.stdout.write(`Plugins (${plugins.length})\n`);
      for (const plugin of plugins) ctx.stdout.write(`  ${String(plugin.name ?? 'anonymous')}  ${(plugin.fibers ?? []).map((fiber) => String(fiber.state ?? 'unknown')).join(', ') || '(no fibers)'}\n`);
      return 0;
    }
    if (area === 'net') {
      const [operation = ''] = args;
      if (operation === 'doctor') {
        ctx.stdout.write('Network capability report\n[  OK  ] preview URLs (virtual ports; browser-side preview only)\n[SKIP] inbound sockets (no real inbound networking)\n[SKIP] ICMP / ping (no ICMP in this environment)\n[SKIP] tunnels (outbound tunnel bridge is not implemented)\n');
        return 0;
      }
      if (operation === 'preview') {
        const result = await browserControl(ctx, 'ports') as { ports?: Array<{ port?: unknown; url?: unknown }> } | undefined;
        if (!result) return 69;
        const ports = (result.ports ?? []).filter((entry) => Number.isInteger(entry.port) && typeof entry.url === 'string').sort((a, b) => Number(a.port) - Number(b.port));
        if (ports.length === 0) ctx.stdout.write('No preview ports ready yet\n');
        else {
          ctx.stdout.write('Preview ports (virtual)\nPORT  URL\n');
          for (const entry of ports) ctx.stdout.write(`${String(entry.port)}  ${String(entry.url)}  (preview)\n`);
        }
        return 0;
      }
      if (operation === 'tunnel') {
        ctx.stderr.write('succinix: net tunnel: unavailable in this environment\n');
        return 126;
      }
      ctx.stderr.write('usage: succinix net doctor | succinix net preview | succinix net tunnel\n');
      return 2;
    }
    if (area === 'init' || area === 'run' || area === 'serve' || area === 'open') return projectCommand({ ...ctx, args: [area, ...args] });
    ctx.stderr.write(`succinix: unknown command: ${area}\n`);
    return 2;
  });

  registerRuntimeCommands(sandbox, instanceId, lifoSpawnCwd, forward);
}
