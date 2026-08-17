import type { Command, CommandContext } from '@lifo-sh/core';
import {
  createUserlandRegistry,
  type UserlandCommandDefinition,
  type UserlandRegistry,
  type UserlandRegistrySnapshot,
  type UserlandServiceTemplate,
} from '../../userland/index.js';
import { SERVICE_TEMPLATES } from '../../services/templates.js';
import { installServiceTemplates } from './service-world.js';

export interface UserlandSandboxLike {
  commands: { register(name: string, handler: Command): void };
  shell?: { getRegistry(): { unregister(name: string): void } };
  kernel?: { vfs: import('@lifo-sh/core').VFS; serviceManager?: { daemonReload(): void } | null };
}

export interface UserlandApplyOptions {
  /** Lifo-visible cwd for seeded official service units. */
  workingDirectory?: string;
}

/**
 * 每个 Sandbox 都从同一份结构化注册数据重建扩展。这里不接受浏览器函数，
 * 只把已验证的数据源注册给 Lifo；因此不存在浏览器侧命令实现。
 */
export function createSandboxUserlandRegistry(snapshot?: UserlandRegistrySnapshot): UserlandRegistry {
  const registry = createUserlandRegistry();
  for (const template of SERVICE_TEMPLATES) {
    registry.registerServiceTemplate({
    name: template.name,
    runtime: template.runtime,
    command: template.command,
    description: template.description,
    ...(template.port === null ? {} : { ports: [template.port] }),
    });
  }
  if (!snapshot) return registry;
  for (const command of snapshot.commands) {
    // 描述内建能力的条目没有可执行源，不能覆盖系统命令。
    if (command.source) registry.registerCommand(command);
  }
  for (const source of snapshot.packages) registry.registerPackage(source);
  for (const template of snapshot.serviceTemplates) registry.registerServiceTemplate(template);
  return registry;
}

const hostUserlandRegistry = createSandboxUserlandRegistry();

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:+@=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function shellCommand(command: string, args: readonly string[], appendArgs = true): string {
  if (!appendArgs || args.length === 0) return command;
  return `${command} ${args.map(quoteArg).join(' ')}`;
}

async function runShellSource(ctx: CommandContext, command: string, appendArgs = true): Promise<number> {
  const line = shellCommand(command, ctx.args, appendArgs);
  if (typeof ctx.executeCaptureResult === 'function') {
    const result = await ctx.executeCaptureResult(line, { cwd: ctx.cwd });
    ctx.stdout.write(result.stdout);
    ctx.stderr.write(result.stderr);
    return result.code;
  }
  if (typeof ctx.executeCapture === 'function') {
    const stdout = await ctx.executeCapture(line, { cwd: ctx.cwd });
    ctx.stdout.write(stdout);
    return 0;
  }
  ctx.stderr.write('succinix: command source requires executeCaptureResult\n');
  return 126;
}

async function runBuiltinSource(ctx: CommandContext, id: string): Promise<number> {
  if (id === 'raw-stdin-probe') {
    if (!ctx.stdin || !ctx.setRawMode) {
      ctx.stderr.write('succinix: interactive command requires stdin and raw mode support\n');
      return 69;
    }
    ctx.setRawMode(true);
    try {
      const input = await ctx.stdin.readAll();
      ctx.stdout.write(`${input}\n`);
      return 0;
    } finally {
      ctx.setRawMode(false);
    }
  }
  ctx.stderr.write(`succinix: unsupported builtin command source: ${id}\n`);
  return 126;
}

export function compileUserlandCommand(command: UserlandCommandDefinition): Command {
  const source = command.source;
  if (!source) throw new TypeError(`command "${command.name}" requires a structured source`);
  switch (source.kind) {
    case 'shell':
      return async (ctx) => runShellSource(ctx, source.command, source.appendArgs !== false);
    case 'builtin':
      return async (ctx) => runBuiltinSource(ctx, source.id);
    default:
      throw new TypeError(`unsupported command source: ${(source as { kind?: unknown }).kind as string}`);
  }
}

export function applyUserlandRegistryToSandbox(
  sandbox: UserlandSandboxLike,
  registry: UserlandRegistry = hostUserlandRegistry,
  options: UserlandApplyOptions = {},
): () => void {
  const releases: Array<() => void> = [];
  if (sandbox.kernel) {
    installServiceTemplates(
      sandbox.kernel.vfs,
      registry.listServiceTemplates() as readonly UserlandServiceTemplate[],
      options.workingDirectory,
    );
    sandbox.kernel.serviceManager?.daemonReload();
  }
  for (const command of registry.listCommandDefinitions()) {
    if (!command.source) continue;
    const handler = compileUserlandCommand(command);
    sandbox.commands.register(command.name, handler);
    releases.push(() => {
      try { sandbox.shell?.getRegistry().unregister(command.name); } catch { /* stale registry during teardown */ }
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases.reverse()) release();
  };
}

export function userlandRegistry(): UserlandRegistry {
  return hostUserlandRegistry;
}

export function registerUserlandCommand(command: UserlandCommandDefinition): () => void {
  return hostUserlandRegistry.registerCommand(command);
}
