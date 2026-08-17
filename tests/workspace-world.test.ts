import { describe, expect, it, vi } from 'vitest';
import { VFS, type CommandContext } from '@lifo-sh/core';
import { createWorkspaceCommand } from '../src/engine/host/workspace-world.js';

function context(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    ctx: {
      args,
      cwd: '/workspace',
      env: {},
      vfs: new VFS(),
      stdout: { write: (text: string) => void stdout.push(text) },
      stderr: { write: (text: string) => void stderr.push(text) },
      signal: new AbortController().signal,
    } as CommandContext,
    stdout,
    stderr,
  };
}

describe('execution-world workspace command', () => {
  it('creates isolated workspace directories and synchronizes the sandbox cwd on switch', async () => {
    const vfs = new VFS();
    const sandbox = { kernel: { vfs }, cwd: '/workspace' };
    const switched: string[] = [];
    const command = createWorkspaceCommand({ sandbox, onSwitch: (cwd) => { switched.push(cwd); } });

    const create = context(['create', 'proj-a']);
    expect(await command(create.ctx)).toBe(0);
    expect(vfs.exists('/workspace/ws/proj-a')).toBe(true);

    const select = context(['switch', 'proj-a']);
    expect(await command(select.ctx)).toBe(0);
    expect(sandbox.cwd).toBe('/workspace/ws/proj-a');
    expect(switched).toEqual(['/workspace/ws/proj-a']);
    expect(vfs.readFileString('/workspace/ws/.current')).toBe('proj-a\n');

    vfs.writeFile('/workspace/ws/proj-a/a.txt', 'only-a');
    expect(vfs.exists('/workspace/ws/main/a.txt')).toBe(false);
  });

  it('protects the active and default workspaces from removal', async () => {
    const vfs = new VFS();
    const sandbox = { kernel: { vfs }, cwd: '/workspace' };
    const command = createWorkspaceCommand({ sandbox });
    await command(context(['create', 'temporary']).ctx);
    await command(context(['switch', 'temporary']).ctx);

    const active = context(['rm', 'temporary', '--yes']);
    expect(await command(active.ctx)).toBe(1);
    expect(active.stderr.join('')).toContain('cannot remove current workspace');

    const main = context(['rm', 'main', '--yes']);
    expect(await command(main.ctx)).toBe(1);
    expect(main.stderr.join('')).toContain("cannot remove 'main'");
  });

  it('uses the supplied native mount remover only after validation and confirmation', async () => {
    const vfs = new VFS();
    const sandbox = { kernel: { vfs }, cwd: '/workspace' };
    const remove = vi.fn();
    const command = createWorkspaceCommand({ sandbox, remove });
    await command(context(['create', 'temporary']).ctx);

    expect(await command(context(['rm', 'temporary', '--yes']).ctx)).toBe(0);
    expect(remove).toHaveBeenCalledWith('temporary');
  });
});
