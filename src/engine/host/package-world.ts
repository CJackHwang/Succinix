// Package manifest and management helpers that run inside the Lifo execution
// world. Package payload, command registry, and /etc manifest all share the
// same per-instance Sandbox and host-backed filesystem mounts.
import type { Command, CommandContext, VFS } from '@lifo-sh/core';
import {
  readPackageManifest,
  recordPackageInstall,
  recordPackageRemove,
  writePackageManifest,
  type InstalledPackage,
  type PackageManifestFs,
} from '../../pkg/manifest.js';
import type { UserlandPackageSource } from '../../userland/index.js';

interface PackageRegistrySandbox {
  commands: { register(name: string, command: Command): void };
  kernel: { vfs: VFS };
}

interface PackageVfsSandbox {
  kernel: { vfs: VFS };
}

interface RegisteredPackageSandbox extends PackageVfsSandbox {
  commands: {
    run(command: string, options?: { cwd?: string; timeout?: number }): Promise<{ exitCode: number; stderr: string }>;
  };
}

const PACKAGE_ROOT = '/usr/lib/node_modules';

function manifestFs(vfs: VFS): PackageManifestFs {
  return {
    readFile: async (path) => vfs.readFileString(path),
    writeFile: async (path, data) => { vfs.writeFile(path, data); },
    mkdir: async (path, options) => { vfs.mkdir(path, options); },
    rename: async (from, to) => { vfs.rename(from, to); },
  };
}

function baseName(raw: string): string {
  return raw.startsWith('lifo-pkg-') ? raw.slice('lifo-pkg-'.length) : raw;
}

function packageDirectory(vfs: VFS, raw: string): string | undefined {
  const candidates = raw.startsWith('lifo-pkg-') ? [raw] : [`lifo-pkg-${raw}`, raw];
  return candidates.map((name) => `${PACKAGE_ROOT}/${name}`).find((path) => vfs.exists(path));
}

function installedVersion(vfs: VFS, raw: string): string {
  const directory = packageDirectory(vfs, raw);
  if (!directory) return 'unknown';
  try {
    return String((JSON.parse(vfs.readFileString(`${directory}/package.json`)) as { version?: unknown }).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:+@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

async function updateManifestAfterLifo(vfs: VFS, args: readonly string[]): Promise<void> {
  const operation = args[0];
  const rawName = args[1];
  if (!rawName) return;
  const fs = manifestFs(vfs);
  if (operation === 'install' || operation === 'i' || operation === 'add') {
    await recordPackageInstall(fs, {
      name: baseName(rawName),
      source: 'lifo',
      version: installedVersion(vfs, rawName),
      execution: 'both',
    });
  } else if (operation === 'remove' || operation === 'rm' || operation === 'uninstall') {
    await recordPackageRemove(fs, baseName(rawName), 'lifo');
  }
}

/** Wrap Lifo's own command rather than implementing package installation. */
export function installPackageManifestTracking(sandbox: PackageRegistrySandbox, lifoCommand: Command): void {
  sandbox.commands.register('lifo', async (ctx) => {
    const code = await lifoCommand(ctx);
    if (code === 0) await updateManifestAfterLifo(sandbox.kernel.vfs, ctx.args);
    return code;
  });
}

function packageExists(vfs: VFS, entry: InstalledPackage): boolean {
  if (entry.source === 'lifo') return packageDirectory(vfs, entry.name) !== undefined;
  return vfs.exists(`/workspace/node_modules/${entry.name}/package.json`);
}

function registeredPackageSpec(source: UserlandPackageSource): string {
  return source.version ? `${source.name}@${source.version}` : source.name;
}

/**
 * 第三方注册只声明包来源；实际安装仍通过当前 Sandbox 的 Lifo 或真实 npm
 * 命令完成。成功后才写入共享 /etc manifest，host 重启由既有 rehydrate 路径恢复。
 */
export async function reconcileRegisteredUserlandPackages(
  sandbox: RegisteredPackageSandbox,
  sources: readonly UserlandPackageSource[],
): Promise<void> {
  const vfs = sandbox.kernel.vfs;
  const manifest = manifestFs(vfs);
  for (const source of sources) {
    const existing: InstalledPackage = {
      name: source.name,
      source: source.source,
      version: source.version ?? 'installed',
      ...(source.integrity ? { integrity: source.integrity } : {}),
      installedAt: 0,
      persistent: true,
      execution: 'both',
    };
    if (!packageExists(vfs, existing)) {
      const command = source.source === 'lifo'
        ? `lifo install ${quoteArg(registeredPackageSpec(source))}`
        : `npm install ${quoteArg(registeredPackageSpec(source))} --no-audit --no-fund`;
      const result = await sandbox.commands.run(command, { cwd: '/workspace', timeout: 120_000 });
      if (result.exitCode !== 0 || !packageExists(vfs, existing)) {
        throw new Error(`userland package install failed: ${source.source}:${source.name}${result.stderr ? ` (${result.stderr.slice(0, 160)})` : ''}`);
      }
    }
    const version = source.source === 'lifo' ? installedVersion(vfs, source.name) : source.version ?? 'installed';
    await recordPackageInstall(manifest, {
      name: source.name,
      source: source.source,
      version,
      ...(source.integrity ? { integrity: source.integrity } : {}),
      execution: 'both',
    });
  }
}

async function runCaptured(ctx: CommandContext, command: string): Promise<number> {
  if (typeof ctx.executeCaptureResult !== 'function') {
    ctx.stderr.write('succinix pkg: execution bridge unavailable\n');
    return 126;
  }
  const result = await ctx.executeCaptureResult(command, { cwd: ctx.cwd });
  ctx.stdout.write(result.stdout);
  ctx.stderr.write(result.stderr);
  return result.code;
}

async function manageExplicitNpm(ctx: CommandContext, vfs: VFS, operation: string, spec: string): Promise<number> {
  const name = spec.slice('npm:'.length);
  if (!name) {
    ctx.stderr.write(`succinix pkg ${operation}: npm: requires a package name\n`);
    return 2;
  }
  const command = operation === 'remove'
    ? `npm uninstall ${quoteArg(name)} --no-audit --no-fund`
    : `npm install ${quoteArg(name)} --no-audit --no-fund`;
  const code = await runCaptured(ctx, command);
  if (code !== 0) return code;
  const fs = manifestFs(vfs);
  if (operation === 'remove') await recordPackageRemove(fs, name, 'npm');
  else await recordPackageInstall(fs, { name, source: 'npm', version: 'installed', execution: 'both' });
  return 0;
}

async function doctor(ctx: CommandContext, vfs: VFS): Promise<number> {
  const manifest = await readPackageManifest(manifestFs(vfs));
  let missing = 0;
  for (const entry of manifest.packages) {
    const present = packageExists(vfs, entry);
    ctx.stdout.write(`${present ? '[  OK  ]' : '[ FAIL ]'} ${entry.source}:${entry.name}@${entry.version}\n`);
    if (!present) missing++;
  }
  if (manifest.packages.length === 0) ctx.stdout.write('[SKIP] package manifest is empty\n');
  ctx.stdout.write(`Package doctor: ${missing === 0 ? 'consistent' : `${missing} missing`}\n`);
  return missing === 0 ? 0 : 1;
}

/** `succinix pkg` adds manifest operations around Lifo's package command. */
export async function runPackageManagement(ctx: CommandContext, sandbox: PackageVfsSandbox, args: readonly string[]): Promise<number> {
  const operation = args[0] ?? 'list';
  const spec = args[1];
  if ((operation === 'install' || operation === 'remove' || operation === 'update') && spec?.startsWith('npm:')) {
    return manageExplicitNpm(ctx, sandbox.kernel.vfs, operation === 'update' ? 'install' : operation, spec);
  }
  if (operation === 'lock') {
    const fs = manifestFs(sandbox.kernel.vfs);
    const manifest = await readPackageManifest(fs);
    await writePackageManifest(fs, manifest);
    ctx.stdout.write(`Package lock written (${manifest.packages.length} package${manifest.packages.length === 1 ? '' : 's'})\n`);
    return 0;
  }
  if (operation === 'doctor') return doctor(ctx, sandbox.kernel.vfs);
  if (operation === 'cache') {
    const manifest = await readPackageManifest(manifestFs(sandbox.kernel.vfs));
    ctx.stdout.write(`Lifo package payload: persistent (${manifest.packages.filter((entry) => entry.source === 'lifo').length} recorded)\n`);
    ctx.stdout.write('npm cache: managed by the real Node runtime\n');
    return 0;
  }
  if (operation === 'restore') {
    ctx.stdout.write('Package commands were rehydrated from the persistent execution-world payload at Sandbox boot.\n');
    return doctor(ctx, sandbox.kernel.vfs);
  }
  const lifoOperation = operation === 'update' ? 'install' : operation;
  return runCaptured(ctx, `lifo ${[lifoOperation, ...args.slice(1)].map(quoteArg).join(' ')}`.trim());
}
