// Execution-world workspace manager. The pointer and project files live in
// the host-mounted workspace so browser persistence and real runtimes observe
// the same state.
import type { Command, VFS } from '@lifo-sh/core';

const WORKSPACE_ROOT = '/workspace/ws';
const CURRENT_FILE = `${WORKSPACE_ROOT}/.current`;
const DEFAULT_WORKSPACE = 'main';

export interface WorkspaceSandbox {
  kernel: { vfs: VFS };
  cwd: string;
}

export interface WorkspaceCommandOptions {
  sandbox: WorkspaceSandbox;
  /** Persist/synchronize the selected VFS cwd before reporting success. */
  onSwitch?(cwd: string): Promise<void> | void;
  /** Native workspace mounts require their provider-specific removal path. */
  remove?(name: string): void;
}

function validName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function workspacePath(name: string): string {
  return `${WORKSPACE_ROOT}/${name}`;
}

function list(vfs: VFS): string[] {
  if (!vfs.exists(WORKSPACE_ROOT)) return [];
  return vfs.readdir(WORKSPACE_ROOT)
    .filter((entry) => entry.type === 'directory' && validName(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function readCurrent(vfs: VFS, names = list(vfs)): string | null {
  if (!vfs.exists(CURRENT_FILE)) return null;
  try {
    const name = vfs.readFileString(CURRENT_FILE).trim();
    return names.includes(name) ? name : null;
  } catch {
    return null;
  }
}

function ensure(vfs: VFS): void {
  vfs.mkdir(WORKSPACE_ROOT, { recursive: true });
  if (!vfs.exists(workspacePath(DEFAULT_WORKSPACE))) vfs.mkdir(workspacePath(DEFAULT_WORKSPACE), { recursive: true });
  const names = list(vfs);
  if (!readCurrent(vfs, names)) vfs.writeFile(CURRENT_FILE, `${DEFAULT_WORKSPACE}\n`);
}

function usage(ctx: Parameters<Command>[0]): number {
  ctx.stderr.write('usage: succinix workspace | succinix workspace create <name> | succinix workspace switch <name> | succinix workspace rm <name> --yes\n');
  return 2;
}

/** Create the `succinix workspace` command over the canonical Lifo VFS. */
export function createWorkspaceCommand(options: WorkspaceCommandOptions): Command {
  return async (ctx) => {
    const vfs = options.sandbox.kernel.vfs;
    ensure(vfs);
    const [operation = '', rawName, confirmation] = ctx.args;
    const names = list(vfs);
    const current = readCurrent(vfs, names);

    if (operation === '') {
      ctx.stdout.write('Workspaces\n');
      for (const name of names) ctx.stdout.write(`  ${name}${name === current ? '  (current)' : ''}\n`);
      return 0;
    }

    if (operation === 'create') {
      if (!rawName) return usage(ctx);
      if (!validName(rawName)) {
        ctx.stderr.write(`succinix workspace: invalid workspace name: ${rawName}\n`);
        return 2;
      }
      if (names.includes(rawName)) {
        ctx.stderr.write(`succinix workspace: workspace '${rawName}' already exists\n`);
        return 1;
      }
      vfs.mkdir(workspacePath(rawName), { recursive: false });
      ctx.stdout.write(`Workspace '${rawName}' created. Switch with: succinix workspace switch ${rawName}\n`);
      return 0;
    }

    if (operation === 'switch') {
      if (!rawName) return usage(ctx);
      if (!names.includes(rawName)) {
        ctx.stderr.write(`succinix workspace: workspace '${rawName}' does not exist\n`);
        return 1;
      }
      const cwd = workspacePath(rawName);
      vfs.writeFile(CURRENT_FILE, `${rawName}\n`);
      options.sandbox.cwd = cwd;
      await options.onSwitch?.(cwd);
      ctx.stdout.write(`Switched to workspace '${rawName}' (${cwd})\n`);
      return 0;
    }

    if (operation === 'rm') {
      if (!rawName) return usage(ctx);
      if (rawName === DEFAULT_WORKSPACE) {
        ctx.stderr.write("succinix workspace: cannot remove 'main'\n");
        return 1;
      }
      if (rawName === current) {
        ctx.stderr.write(`succinix workspace: cannot remove current workspace '${rawName}'\n`);
        return 1;
      }
      if (!names.includes(rawName)) {
        ctx.stderr.write(`succinix workspace: workspace '${rawName}' does not exist\n`);
        return 1;
      }
      if (confirmation !== '--yes') {
        ctx.stderr.write(`succinix workspace: confirm removal with: succinix workspace rm ${rawName} --yes\n`);
        return 2;
      }
      if (options.remove) options.remove(rawName);
      else vfs.rmdirRecursive(workspacePath(rawName));
      ctx.stdout.write(`Workspace '${rawName}' removed\n`);
      return 0;
    }

    return usage(ctx);
  };
}
