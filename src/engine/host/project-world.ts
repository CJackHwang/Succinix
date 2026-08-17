// Execution-world project workflow for `succinix init|run|serve`.  Detection
// and generated unit files stay inside the Lifo VFS; browser code only opens
// the preview URL after the service exposes one.
import type { Command, CommandContext, ServiceManager, VFS } from '@lifo-sh/core';

const UNIT_ROOT = '/etc/systemd/system';
const PROJECT_UNIT = 'succinix-project';
const PREVIEW_UNIT = 'succinix-preview';

type ProjectKind = 'vite' | 'node' | 'python' | 'static' | 'none';

interface Project {
  kind: ProjectKind;
  name: string;
  files: string[];
  devCommand?: string;
  serveCommand?: string;
  port?: number;
}

interface ProjectSandbox {
  kernel: { vfs: VFS; serviceManager: ServiceManager | null };
}

function names(vfs: VFS, cwd: string): string[] {
  try { return vfs.readdir(cwd).map((entry) => entry.name); } catch { return []; }
}

function readJson(vfs: VFS, path: string): { name?: unknown; main?: unknown; scripts?: unknown } {
  try { return JSON.parse(vfs.readFileString(path)) as { name?: unknown; main?: unknown; scripts?: unknown }; } catch { return {}; }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && !/[\r\n\0]/.test(value) ? value : undefined;
}

function detectProject(vfs: VFS, cwd: string): Project {
  const entries = names(vfs, cwd);
  if (entries.includes('package.json')) {
    const pkg = readJson(vfs, `${cwd}/package.json`);
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts as Record<string, unknown> : {};
    const viteConfig = entries.find((name) => name.startsWith('vite.config.'));
    const devCommand = stringField(scripts.dev) ? 'npm run dev'
      : stringField(scripts.start) ? 'npm start'
        : stringField(pkg.main) ? `node ${pkg.main}` : undefined;
    return {
      kind: viteConfig ? 'vite' : 'node',
      name: stringField(pkg.name) ?? (viteConfig ? 'vite project' : 'node project'),
      files: ['package.json', ...(viteConfig ? [viteConfig] : [])],
      devCommand,
      ...(viteConfig ? { serveCommand: 'npx vite --host 0.0.0.0 --port 5173', port: 5173 } : {}),
    };
  }
  if (entries.includes('pyproject.toml') || entries.includes('requirements.txt')) {
    return {
      kind: 'python', name: 'python project',
      files: ['pyproject.toml', 'requirements.txt', 'main.py'].filter((name) => entries.includes(name)),
      ...(entries.includes('main.py') ? { devCommand: 'python main.py' } : {}),
      serveCommand: 'npx serve . --listen 3000', port: 3000,
    };
  }
  if (entries.includes('index.html')) {
    return { kind: 'static', name: 'static site', files: ['index.html'], serveCommand: 'npx serve . --listen 3000', port: 3000 };
  }
  return { kind: 'none', name: 'no project detected', files: [] };
}

function writeUnit(vfs: VFS, name: string, command: string, cwd: string): void {
  vfs.mkdir(UNIT_ROOT, { recursive: true });
  vfs.writeFile(`${UNIT_ROOT}/${name}.service`, [
    '[Unit]', `Description=Succinix ${name}`, '', '[Service]', `ExecStart=${command}`,
    'Type=simple', 'Restart=no', `WorkingDirectory=${cwd}`, '', '[Install]',
    'WantedBy=multi-user.target', '',
  ].join('\n'));
}

async function startProjectService(
  ctx: CommandContext,
  sandbox: ProjectSandbox,
  name: string,
  command: string,
): Promise<number> {
  const manager = sandbox.kernel.serviceManager;
  if (!manager) {
    ctx.stderr.write('succinix: service manager unavailable\n');
    return 69;
  }
  writeUnit(sandbox.kernel.vfs, name, command, ctx.cwd);
  manager.daemonReload();
  const result = await manager.start(name);
  if (!result.ok) {
    ctx.stderr.write(`succinix: failed to start ${name}: ${result.message}\n`);
    return 1;
  }
  ctx.stdout.write(`${result.message}\n`);
  return 0;
}

function printDetection(ctx: CommandContext, project: Project): void {
  ctx.stdout.write('Project detected\n');
  ctx.stdout.write(`  kind    ${project.kind} (${project.name})\n`);
  if (project.files.length) ctx.stdout.write(`  files   ${project.files.join(', ')}\n`);
  if (project.devCommand) ctx.stdout.write(`  run     ${project.devCommand}\n`);
  if (project.serveCommand) ctx.stdout.write(`  serve   ${project.serveCommand}\n`);
  if (project.port) ctx.stdout.write(`  port    ${project.port}\n`);
  ctx.stdout.write('  next    succinix run | succinix serve | succinix open\n');
}

/** Commands whose execution and service lifecycle remain inside Lifo. */
export function createProjectCommand(sandbox: ProjectSandbox, openPreview: (ctx: CommandContext, port?: number) => Promise<number>): Command {
  return async (ctx) => {
    const [operation = '', portArg] = ctx.args;
    const project = detectProject(sandbox.kernel.vfs, ctx.cwd);
    if (operation === 'init') {
      printDetection(ctx, project);
      return 0;
    }
    if (operation === 'run') {
      if (!project.devCommand) {
        ctx.stderr.write(project.kind === 'none'
          ? 'succinix: run: no project detected in this directory\n'
          : 'succinix: run: no dev command detected\n');
        return 1;
      }
      if (project.kind === 'python') {
        ctx.stdout.write(`project is Python; run '${project.devCommand}' in the shell, or use 'succinix serve' for static files\n`);
        return 0;
      }
      return startProjectService(ctx, sandbox, PROJECT_UNIT, project.devCommand);
    }
    if (operation === 'serve') {
      if (!project.serveCommand) {
        ctx.stderr.write(project.kind === 'none'
          ? 'succinix: serve: no project detected in this directory\n'
          : `succinix: serve: no preview service for ${project.kind}\n`);
        return 1;
      }
      return startProjectService(ctx, sandbox, PREVIEW_UNIT, project.serveCommand);
    }
    if (operation === 'open') {
      const port = portArg === undefined ? project.port : Number(portArg);
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        ctx.stderr.write(`succinix: open: invalid port: ${portArg}\n`);
        return 2;
      }
      return openPreview(ctx, port);
    }
    ctx.stderr.write('usage: succinix init | succinix run | succinix serve | succinix open [port]\n');
    return 2;
  };
}
