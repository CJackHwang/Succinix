// 项目工作流命令（v0.7）：succinix init / run / serve / open。
// 检测在浏览器读取 wc.fs 的声明文件；执行永远走执行世界（node 子进程或声明式 service），
// 浏览器不实现第二套启动器。
import {
  addServiceDef,
  serviceTemplate,
  startService,
  type ServiceContext,
} from '@succinix/engine';
import type { FileSystemAPI, WebContainer } from '@webcontainer/api';
import { AMBER, RED, RESET } from '../theme.js';
import type { CommandContext } from './types.js';

export interface ProjectDetection {
  kind: 'vite' | 'node' | 'python' | 'static' | 'none';
  name: string;
  files: string[];
  devCommand?: string;
  serveTemplate?: string;
  port?: number;
}

// 接受 WebContainer（wc.fs）或测试用的裸 fs 表面两种形态。
function fsOf(wc: WebContainer | FileSystemAPI): FileSystemAPI {
  return ('fs' in wc && wc.fs !== undefined ? wc.fs : wc) as FileSystemAPI;
}

// 识别 package.json / pyproject.toml / requirements.txt / Vite 配置 / index.html。
export async function detectProject(wc: WebContainer | FileSystemAPI, cwd: string): Promise<ProjectDetection> {
  const fs = fsOf(wc);
  const read = async (path: string): Promise<string | null> => {
    try { return await fs.readFile(path, 'utf8'); } catch { return null; }
  };
  let names: string[] = [];
  try {
    const entries = (await fs.readdir(cwd)) as unknown as Array<string | { name: string }>;
    names = entries.map((entry) => (typeof entry === 'string' ? entry : entry.name));
  } catch {
    names = [];
  }
  const has = (name: string) => names.includes(name);
  if (has('package.json')) {
    const files = ['package.json'];
    let pkg: { name?: string; scripts?: Record<string, string>; main?: string } = {};
    try { pkg = JSON.parse((await read(`${cwd}/package.json`)) ?? '{}') as typeof pkg; } catch { pkg = {}; }
    const viteConfig = names.find((name) => name.startsWith('vite.config.'));
    if (viteConfig) files.push(viteConfig);
    const scripts = pkg.scripts ?? {};
    const devCommand = scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : pkg.main ? `node ${pkg.main}` : undefined;
    return {
      kind: viteConfig ? 'vite' : 'node',
      name: pkg.name ?? (viteConfig ? 'vite project' : 'node project'),
      files,
      devCommand,
      serveTemplate: viteConfig ? 'vite' : undefined,
      port: viteConfig ? 5173 : undefined,
    };
  }
  if (has('pyproject.toml') || has('requirements.txt')) {
    const files: string[] = [];
    if (has('pyproject.toml')) files.push('pyproject.toml');
    if (has('requirements.txt')) files.push('requirements.txt');
    if (has('main.py')) files.push('main.py');
    return {
      kind: 'python',
      name: 'python project',
      files,
      devCommand: has('main.py') ? 'python main.py' : undefined,
      serveTemplate: 'static-http',
      port: 3000,
    };
  }
  if (has('index.html')) {
    return { kind: 'static', name: 'static site', files: ['index.html'], serveTemplate: 'static-http', port: 3000 };
  }
  return { kind: 'none', name: 'no project detected', files: [] };
}

function formatDetection(det: ProjectDetection): string[] {
  const lines = ['Project detected', `  kind    ${det.kind} (${det.name})`];
  if (det.files.length > 0) lines.push(`  files   ${det.files.join(', ')}`);
  if (det.devCommand) lines.push(`  run     ${det.devCommand}`);
  if (det.serveTemplate) lines.push(`  serve   ${det.serveTemplate}`);
  if (det.port) lines.push(`  port    ${det.port}`);
  lines.push('  next    succinix run | succinix serve | succinix open');
  return lines;
}

export async function projectCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === '' || sub === '--help' || sub === '-h') {
    term.writeln('usage: succinix init | succinix run | succinix serve | succinix open [port]');
    return;
  }
  let cwd = '/workspace';
  try {
    const r = await ctx.client.terminal('cwd');
    cwd = String(r.cwd ?? '/workspace');
  } catch {
    /* 会话 cwd 不可达：回落默认工作区根 */
  }
  const det = await detectProject(ctx.wc, cwd);

  if (sub === 'init') {
    for (const line of formatDetection(det)) term.writeln(line);
    return;
  }

  if (sub === 'run') {
    if (!det.devCommand) {
      term.writeln(det.kind === 'none' ? 'succinix: run: no project detected in this directory' : `succinix: run: no dev command detected (use 'succinix serve' for ${det.kind})`);
      return;
    }
    if (det.kind === 'python') {
      term.writeln(`project is Python; run '${det.devCommand}' in the shell (interactive), or 'succinix serve' to preview static files`);
      return;
    }
    const r = await ctx.client.spawn(det.devCommand);
    if (r.ok && r.pid) {
      term.writeln(`started '${det.devCommand}' (pid ${r.pid}); watch 'ports' for the preview URL`);
    } else {
      term.writeln(`${RED}succinix: run: failed to start '${det.devCommand}': ${String(r.error ?? r.stderr ?? 'spawn failure').slice(0, 300)}${RESET}`);
    }
    return;
  }

  if (sub === 'serve') {
    if (!det.serveTemplate) {
      term.writeln(det.kind === 'none' ? 'succinix: serve: no project detected in this directory' : `succinix: serve: no static/vite project detected (kind=${det.kind})`);
      return;
    }
    const tpl = serviceTemplate(det.serveTemplate);
    if (!tpl) {
      term.writeln(`${RED}succinix: serve: unknown template '${det.serveTemplate}'${RESET}`);
      return;
    }
    try {
      await addServiceDef(fsOf(ctx.wc), tpl.name, tpl.command, tpl.port, ctx.instanceId, ctx.statePrefix);
    } catch (error) {
      term.writeln(`${RED}succinix: serve: failed to register service: ${String(error)}${RESET}`);
      return;
    }
    const svc: ServiceContext = { wc: ctx.wc, client: ctx.client, ports: ctx.ports, instanceId: ctx.instanceId, statePrefix: ctx.statePrefix };
    const r = await startService(svc, tpl.name);
    if (r.ok) {
      const portMatch = /port (\d+)/.exec(r.message);
      const readyPort = portMatch ? Number(portMatch[1]) : undefined;
      const url = readyPort !== undefined ? ctx.ports.get(readyPort) : undefined;
      term.writeln(`started '${tpl.name}' (${r.message})`);
      term.writeln(url ? `preview: ${url}` : `preview: run 'ports' or 'succinix net preview' once the port is ready`);
    } else {
      term.writeln(`${RED}succinix: serve: ${r.message}${RESET}`);
    }
    return;
  }

  if (sub === 'open') {
    let port = args[1] !== undefined ? Number(args[1]) : det.port;
    if (!Number.isInteger(port) || port === undefined) port = undefined;
    const url = port !== undefined ? ctx.ports.get(port) : undefined;
    if (url) {
      term.writeln(`${AMBER}[preview]${RESET} ${url}`);
    } else {
      term.writeln(port !== undefined ? `no preview URL ready for port ${port}; run 'succinix net preview'` : 'no preview URL ready; run \'ports\' or \'succinix net preview\'');
    }
    return;
  }

  term.writeln('usage: succinix init | succinix run | succinix serve | succinix open [port]');
}
