// Lifo runtime command adapters that are independent from the Node/Python
// forwarding loop. They still use the same Sandbox and command context.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { CommandContext } from '@lifo-sh/core';
import { canonicalizeVirtualPath, classifyPrefix, withEaccesHint } from '../host-route.js';
import { hasUnsupportedHereDocument } from '../tokenize.js';
import { mergedEnv } from './config.js';
import {
  USERLAND_DENYLIST,
  USERLAND_DENY_EXIT_CODE,
  USERLAND_PROFILE,
  defaultUserlandCapabilities,
  deniedCommandCapability,
} from '../../userland/index.js';
import { runWasiCommand, wasiInfoCommand } from './wasi.js';
import { requestRubyRuntime } from './ruby.js';
import { viCommand, nanoCommand } from './editors.js';

type LifoSandbox = Awaited<ReturnType<typeof import('../lifo-core.js').Sandbox.create>>;

type Forward = (
  ctx: { stdout: { write(s: string): void }; stderr: { write(s: string): void }; signal?: AbortSignal | null },
  child: ReturnType<typeof spawn>,
  cmd: string,
  realCwd: string,
  runtime?: 'node' | 'ruby',
) => Promise<number>;

function shellScriptPath(cwd: string, requested: string): string {
  return canonicalizeVirtualPath(requested.startsWith('/') ? requested : `${cwd}/${requested}`);
}

export async function runShellScript(ctx: CommandContext, command: 'sh' | 'bash'): Promise<number> {
  const [requested] = ctx.args;
  if (!requested || requested.startsWith('-') || ctx.args.length > 1) {
    ctx.stderr.write(`usage: ${command} script\n`);
    return 2;
  }
  let source: string;
  try {
    const file = shellScriptPath(ctx.cwd, requested);
    if (!ctx.vfs.exists(file)) throw new Error('missing');
    source = ctx.vfs.readFileString(file);
  } catch {
    ctx.stderr.write(`${command}: ${requested}: No such file or directory\n`);
    return 127;
  }
  if (hasUnsupportedHereDocument(source)) {
    ctx.stderr.write('succinix: here-document: unsupported\n');
    return 2;
  }
  if (!ctx.executeCaptureResult) {
    ctx.stderr.write(`${command}: shell runner is unavailable\n`);
    return 69;
  }
  const result = await ctx.executeCaptureResult(source, { cwd: ctx.cwd });
  ctx.stdout.write(result.stdout);
  ctx.stderr.write(result.stderr);
  return result.code;
}

function registerSandboxWrapper(sandbox: LifoSandbox): void {
  sandbox.commands.register('succinix-sandbox', async (ctx) => {
    const args = ctx.args;
    const modeIndex = args.indexOf('--mode');
    const rootIndex = args.indexOf('--workspace');
    const mode = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
    const workspace = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
    if (mode !== 'read-only' && mode !== 'workspace-write') {
      ctx.stderr.write(`sandbox unavailable: unsupported mode ${mode ?? '(missing)'}\n`);
      return 126;
    }
    if (typeof workspace !== 'string' || !workspace.startsWith('/workspace')) {
      ctx.stderr.write('sandbox unavailable: invalid workspace root\n');
      return 126;
    }
    const afterRoot = rootIndex >= 0 ? rootIndex + 2 : modeIndex + 2;
    const command = args.slice(afterRoot).join(' ');
    if (!command || classifyPrefix(command) === 'node') {
      ctx.stderr.write(`sandbox unavailable for mode ${mode}: real node subprocesses cannot be confined\n`);
      return 126;
    }
    if (typeof ctx.executeCaptureResult !== 'function') {
      ctx.stderr.write('sandbox unavailable: Lifo runner is not ready\n');
      return 126;
    }
    const result = await ctx.executeCaptureResult(command, { cwd: ctx.cwd });
    ctx.stdout.write(result.stdout);
    ctx.stderr.write(result.stderr);
    return result.code;
  });
}

export function registerRuntimeCommands(
  sandbox: LifoSandbox,
  instanceId: string,
  lifoSpawnCwd: (cwd: string) => string,
  forward: Forward,
): void {
  for (const name of USERLAND_DENYLIST) {
    sandbox.commands.register(name, async (ctx) => {
      ctx.stderr.write(`succinix: ${name}: command unavailable in this environment\n`);
      return USERLAND_DENY_EXIT_CODE;
    });
  }
  sandbox.commands.register('sh', async (ctx) => runShellScript(ctx, 'sh'));
  sandbox.commands.register('bash', async (ctx) => {
    ctx.stdout.write('Succinix shell: bash-compatible userland subset\n');
    if (ctx.args.length === 0) return 0;
    return runShellScript(ctx, 'bash');
  });
  sandbox.commands.register('vi', viCommand);
  sandbox.commands.register('nano', nanoCommand);
  sandbox.commands.register('wasi-run', async (ctx) => runWasiCommand(ctx, process.cwd()));
  sandbox.commands.register('wasi-info', async (ctx) => wasiInfoCommand(ctx, process.cwd()));
  sandbox.commands.register('ruby', async (ctx) => {
    const runtimePath = `${process.cwd()}/usr/lib/succinix/ruby/ruby-runtime.js`;
    if (!fs.existsSync(runtimePath)) {
      try {
        await requestRubyRuntime();
      } catch (error) {
        ctx.stderr.write(`ruby: ${error instanceof Error ? error.message : String(error)}\n`);
        return 69;
      }
    }
    if (!fs.existsSync(runtimePath)) {
      ctx.stderr.write('ruby: runtime asset bridge completed without installing the adapter\n');
      return 69;
    }
    const realCwd = lifoSpawnCwd(ctx.cwd);
    const child = spawn(process.execPath, [runtimePath, ...ctx.args], { cwd: realCwd, env: mergedEnv(instanceId) });
    return forward(ctx, child, ['ruby', ...ctx.args].join(' '), realCwd, 'ruby');
  });
  registerSandboxWrapper(sandbox);
}

export function writeRuntimeError(ctx: Pick<CommandContext, 'stderr'>, message: string): void {
  ctx.stderr.write(`${message}\n`);
}

export function runtimeCapabilities(): string {
  return `${USERLAND_PROFILE}:${defaultUserlandCapabilities().length + USERLAND_DENYLIST.length}`;
}

export { deniedCommandCapability, withEaccesHint };
