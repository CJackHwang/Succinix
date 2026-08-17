import { describe, expect, it, vi } from 'vitest';
import { VFS, type CommandContext } from '@lifo-sh/core';
import { createProjectCommand } from '../src/engine/host/project-world.js';

function context(vfs: VFS, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    ctx: {
      args, cwd: '/workspace', env: {}, vfs,
      stdout: { write: (value: string) => void stdout.push(value) },
      stderr: { write: (value: string) => void stderr.push(value) },
      signal: new AbortController().signal,
    } as CommandContext,
    stdout,
    stderr,
  };
}

describe('execution-world project commands', () => {
  it('detects a Vite project from the Lifo VFS', async () => {
    const vfs = new VFS();
    vfs.mkdir('/workspace', { recursive: true });
    vfs.writeFile('/workspace/package.json', JSON.stringify({ name: 'demo', scripts: { dev: 'vite' } }));
    vfs.writeFile('/workspace/vite.config.ts', 'export default {}');
    const command = createProjectCommand({ kernel: { vfs, serviceManager: null } }, async () => 0);
    const call = context(vfs, ['init']);

    expect(await command(call.ctx)).toBe(0);
    expect(call.stdout.join('')).toContain('vite (demo)');
    expect(call.stdout.join('')).toContain('npm run dev');
  });

  it('creates a Lifo unit and starts it for a Node project', async () => {
    const vfs = new VFS();
    vfs.mkdir('/workspace', { recursive: true });
    vfs.writeFile('/workspace/package.json', JSON.stringify({ name: 'demo', scripts: { start: 'node server.js' } }));
    const manager = { daemonReload: vi.fn(), start: vi.fn(async () => ({ ok: true, message: 'Started succinix-project.' })) };
    const command = createProjectCommand({ kernel: { vfs, serviceManager: manager as never } }, async () => 0);

    expect(await command(context(vfs, ['run']).ctx)).toBe(0);
    expect(manager.daemonReload).toHaveBeenCalledOnce();
    expect(manager.start).toHaveBeenCalledWith('succinix-project');
    expect(vfs.readFileString('/etc/systemd/system/succinix-project.service')).toContain('ExecStart=npm start');
  });

  it('delegates preview opening to the browser bridge only after selecting a port', async () => {
    const vfs = new VFS();
    vfs.mkdir('/workspace', { recursive: true });
    vfs.writeFile('/workspace/index.html', '<main>demo</main>');
    const open = vi.fn(async () => 0);
    const command = createProjectCommand({ kernel: { vfs, serviceManager: null } }, open);

    expect(await command(context(vfs, ['open', '3000']).ctx)).toBe(0);
    expect(open).toHaveBeenCalledWith(expect.any(Object), 3000);
  });
});
