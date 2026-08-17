import { describe, expect, it, vi } from 'vitest';
import { VFS, type Command, type CommandContext } from '@lifo-sh/core';
import {
  installPackageManifestTracking,
  reconcileRegisteredUserlandPackages,
  runPackageManagement,
} from '../src/engine/host/package-world.js';
import { registerRealBinaryCommands } from '../src/engine/host/real-binaries.js';
import { readPackageManifest } from '../src/pkg/manifest.js';

function manifestFs(vfs: VFS) {
  return {
    readFile: async (path: string, _encoding: 'utf8') => vfs.readFileString(path),
    writeFile: async (path: string, data: string) => { vfs.writeFile(path, data); },
    mkdir: async (path: string, options?: { recursive?: boolean }) => { vfs.mkdir(path, options); },
    rename: async (from: string, to: string) => { vfs.rename(from, to); },
  };
}

function context(vfs: VFS, args: string[], executeCaptureResult?: CommandContext['executeCaptureResult']) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = {
    args,
    env: {},
    cwd: '/workspace',
    vfs,
    stdout: { write: (value: string) => { stdout.push(value); } },
    stderr: { write: (value: string) => { stderr.push(value); } },
    signal: new AbortController().signal,
    executeCaptureResult,
  } as CommandContext;
  return { ctx, stdout, stderr };
}

function lifoSandbox(vfs: VFS) {
  const commands = new Map<string, Command>();
  const sandbox = {
    commands: { register: (name: string, handler: Command) => { commands.set(name, handler); } },
    kernel: { vfs },
  };
  return { sandbox, commands };
}

function installPayload(vfs: VFS, name: string, version = '1.2.3'): void {
  const directory = `/usr/lib/node_modules/lifo-pkg-${name}`;
  vfs.mkdir(directory, { recursive: true });
  vfs.writeFile(`${directory}/package.json`, JSON.stringify({ name: `lifo-pkg-${name}`, version }));
}

describe('execution-world package management', () => {
  it('does not record a failed Lifo install and tracks successful install/remove', async () => {
    const vfs = new VFS();
    const lifo = vi.fn(async (ctx: CommandContext) => (
      ctx.args[1] === 'broken' ? 17 : 0
    ));
    const { sandbox, commands } = lifoSandbox(vfs);
    installPackageManifestTracking(sandbox, lifo);
    const handler = commands.get('lifo');
    expect(handler).toBeDefined();

    expect(await handler!(context(vfs, ['install', 'broken']).ctx)).toBe(17);
    expect((await readPackageManifest(manifestFs(vfs))).packages).toEqual([]);

    installPayload(vfs, 'demo');
    expect(await handler!(context(vfs, ['install', 'demo']).ctx)).toBe(0);
    expect((await readPackageManifest(manifestFs(vfs))).packages).toMatchObject([
      { name: 'demo', source: 'lifo', version: '1.2.3', persistent: true, execution: 'both' },
    ]);

    expect(await handler!(context(vfs, ['remove', 'demo']).ctx)).toBe(0);
    expect((await readPackageManifest(manifestFs(vfs))).packages).toEqual([]);
  });

  it('uses real npm only for an explicit npm: source and commits metadata after success', async () => {
    const vfs = new VFS();
    const execute = vi.fn(async (command: string) => ({
      stdout: 'npm output\n',
      stderr: '',
      code: command.includes('failed') ? 9 : 0,
    }));
    const { ctx, stdout } = context(vfs, ['install', 'npm:@scope/tool'], execute);
    const sandbox = { kernel: { vfs } };

    expect(await runPackageManagement(ctx, sandbox, ctx.args)).toBe(0);
    expect(execute).toHaveBeenCalledWith(
      'npm install @scope/tool --no-audit --no-fund',
      { cwd: '/workspace' },
    );
    expect(stdout.join('')).toContain('npm output');
    expect((await readPackageManifest(manifestFs(vfs))).packages).toMatchObject([
      { name: '@scope/tool', source: 'npm', version: 'installed', persistent: true },
    ]);

    const failedVfs = new VFS();
    const failed = context(
      failedVfs,
      ['install', 'npm:failed'],
      vi.fn(async () => ({ stdout: '', stderr: 'registry unavailable\n', code: 9 })),
    );
    expect(await runPackageManagement(failed.ctx, { kernel: { vfs: failedVfs } }, failed.ctx.args)).toBe(9);
    expect((await readPackageManifest(manifestFs(failedVfs))).packages).toEqual([]);
  });

  it('supports lock, cache, doctor, and restore against the same manifest and payload', async () => {
    const vfs = new VFS();
    installPayload(vfs, 'tool', '2.0.0');
    const { sandbox, commands } = lifoSandbox(vfs);
    installPackageManifestTracking(sandbox, async () => 0);
    await commands.get('lifo')!(context(vfs, ['install', 'tool']).ctx);

    const lock = context(vfs, ['lock']);
    expect(await runPackageManagement(lock.ctx, sandbox, lock.ctx.args)).toBe(0);
    expect(lock.stdout.join('')).toContain('Package lock written (1 package)');

    const cache = context(vfs, ['cache']);
    expect(await runPackageManagement(cache.ctx, sandbox, cache.ctx.args)).toBe(0);
    expect(cache.stdout.join('')).toContain('persistent (1 recorded)');

    const doctor = context(vfs, ['doctor']);
    expect(await runPackageManagement(doctor.ctx, sandbox, doctor.ctx.args)).toBe(0);
    expect(doctor.stdout.join('')).toContain('[  OK  ] lifo:tool@2.0.0');

    const restore = context(vfs, ['restore']);
    expect(await runPackageManagement(restore.ctx, sandbox, restore.ctx.args)).toBe(0);
    expect(restore.stdout.join('')).toContain('rehydrated');

    vfs.rmdirRecursive('/usr/lib/node_modules/lifo-pkg-tool');
    const broken = context(vfs, ['doctor']);
    expect(await runPackageManagement(broken.ctx, sandbox, broken.ctx.args)).toBe(1);
    expect(broken.stdout.join('')).toContain('[ FAIL ] lifo:tool@2.0.0');
  });

  it('routes succinix pkg through the execution-world manager', async () => {
    const vfs = new VFS();
    const commands = new Map<string, Command>();
    registerRealBinaryCommands({
      commands: { register: (name: string, command: Command) => { commands.set(name, command); } },
      kernel: { vfs, serviceManager: null },
    } as never, 'package-test');
    const execute = vi.fn(async () => ({ stdout: 'unexpected', stderr: '', code: 99 }));
    const request = context(vfs, ['pkg', 'lock'], execute);
    const succinix = commands.get('succinix');
    expect(succinix).toBeDefined();
    expect(await succinix!(request.ctx)).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(request.stdout.join('')).toContain('Package lock written (0 packages)');
  });

  it('records preinstalled third-party packages through the shared manifest', async () => {
    const vfs = new VFS();
    installPayload(vfs, 'extension', '3.2.1');
    const run = vi.fn();
    await reconcileRegisteredUserlandPackages({
      kernel: { vfs },
      commands: { run },
    }, [{ name: 'extension', source: 'lifo', version: '3.2.1', integrity: 'sha256-demo' }]);

    expect(run).not.toHaveBeenCalled();
    expect((await readPackageManifest(manifestFs(vfs))).packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'extension', source: 'lifo', version: '3.2.1', integrity: 'sha256-demo' }),
    ]));
  });
});
