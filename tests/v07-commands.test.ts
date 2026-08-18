// v0.7 command-surface tests: succinix capabilities / doctor / net /
// init / run / serve / open, plus project detection.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { FakeFS, FakeClient, installFakeIDB } from './helpers/fakes.js';
import type { FileSystemAPI, WebContainer } from '@webcontainer/api';
import { instancePorts } from '../src/instance/ports.js';
import { clearDbActivePorts } from '../src/services/index.js';
import {
  formatCapabilities,
  succinixDoctor,
  netCmd,
  projectCmd,
  detectProject,
  type CommandContext,
} from '../src/commands/index.js';
import { USERLAND_PROFILE } from '../src/userland/index.js';

beforeEach(() => {
  instancePorts.clear();
  clearDbActivePorts('default');
  vi.stubGlobal('indexedDB', installFakeIDB().indexedDB);
});

function captureTerm(): Terminal & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    writeln: (l: unknown) => void lines.push(String(l)),
    write: (d: unknown) => void lines.push(String(d)),
    clear: () => {},
  } as unknown as Terminal & { lines: string[] };
}

function linesOf(ctx: CommandContext): string[] {
  return (ctx.term as unknown as Terminal & { lines: string[] }).lines;
}

function ctxOf(overrides: Partial<CommandContext> = {}): CommandContext {
  const fs = new FakeFS() as unknown as WebContainer;
  return {
    wc: fs,
    client: new FakeClient() as unknown as CommandContext['client'],
    ports: new Map<number, string>(),
    term: captureTerm() as unknown as Terminal,
    fit: () => {},
    ...overrides,
  };
}

describe('succinix capabilities (v0.7)', () => {
  it('lists the userland profile with 40+ commands and the denylist', () => {
    const lines = formatCapabilities();
    expect(lines[0]).toContain(USERLAND_PROFILE);
    const commandLines = lines.slice(3, lines.indexOf('Denylisted'));
    expect(commandLines.length).toBeGreaterThanOrEqual(40);
    expect(commandLines.some((l) => l.startsWith('  git'))).toBe(true);
    expect(commandLines.some((l) => l.startsWith('  vi'))).toBe(true);
    const denylist = lines.find((l) => l.startsWith('Denylisted'));
    expect(denylist).toContain('exit code 126');
    expect(lines.some((l) => l.includes('chmod') && l.includes('chown'))).toBe(true);
  });

  it('renders every denylisted command as unsupported with the fail-closed code', () => {
    const text = formatCapabilities().join('\n');
    for (const name of ['sudo', 'ssh', 'gcc', 'ping', 'mount']) {
      expect(text).toContain(name);
    }
  });
});

describe('succinix doctor (v0.7)', () => {
  it('reports ok when host ping and persistence are healthy', async () => {
    const client = new FakeClient() as unknown as CommandContext['client'];
    (client as unknown as { exec: unknown }).exec = async () => ({ kind: 'pong' });
    const ctx = ctxOf({
      client,
      persist: { meta: async () => ({ version: 1, savedAt: 0, fileCount: 2, totalBytes: 3 }) } as unknown as CommandContext['persist'],
      engineState: {
        version: '0.7.0', containerMode: 'new', containerState: 'ready', host: { pid: 1, startedAt: 0 },
        instances: [], capabilities: [], configRevision: 0, lastError: null, plugins: [],
      } as unknown as CommandContext['engineState'],
    });
    await succinixDoctor(ctx);
    const text = linesOf(ctx).join('\n');
    expect(text).toContain('[  OK  ] host RPC ping');
    expect(text).toContain('[  OK  ] persistence: format v1 2 files');
    expect(text).toContain('[  OK  ] userland profile');
    expect(text).toContain('[  OK  ] engine state: ready');
  });

  it('fails closed when host ping is unreachable and persistence is absent', async () => {
    const client = new FakeClient() as unknown as CommandContext['client'];
    (client as unknown as { exec: unknown }).exec = async () => { throw new Error('host down'); };
    await succinixDoctor(ctxOf({ client }));
    const ctx = ctxOf({ client });
    await succinixDoctor(ctx);
    const out = linesOf(ctx).join('\n');
    expect(out).toContain('[ FAIL ] host RPC ping');
    expect(out).toContain('[SKIP] persistence');
    expect(out).toContain('[SKIP] engine state');
  });
});

describe('succinix net (v0.7)', () => {
  it('net preview lists virtual preview ports', async () => {
    const ctx = ctxOf({ ports: new Map([[3001, 'https://preview/3001'], [5173, 'https://preview/5173']]) });
    await netCmd(ctx, ['preview']);
    const out = linesOf(ctx).join('\n');
    expect(out).toContain('Preview ports (virtual)');
    expect(out).toContain('3001  https://preview/3001  (preview)');
    expect(out).toContain('5173');
  });

  it('net doctor reports the honest capability boundary', async () => {
    const ctx = ctxOf();
    await netCmd(ctx, ['doctor']);
    const out = linesOf(ctx).join('\n');
    expect(out).toContain('Network capability report');
    expect(out).toContain('[  OK  ] preview URLs');
    expect(out).toContain('[SKIP]  inbound sockets');
    expect(out).toContain('[SKIP]  tunnels');
  });

  it('net tunnel fails closed with a stable message', async () => {
    const ctx = ctxOf();
    await netCmd(ctx, ['tunnel']);
    expect(linesOf(ctx).join('\n')).toContain('unavailable in this environment');
  });
});

describe('project detection and succinix init/run/serve/open (v0.7)', () => {
  it('detects vite, node, python, static, and none', async () => {
    const vite = new FakeFS() as unknown as FileSystemAPI;
    await vite.writeFile('/workspace/package.json', JSON.stringify({ name: 'app', scripts: { dev: 'vite' } }));
    await vite.writeFile('/workspace/vite.config.ts', 'export default {}');
    expect(await detectProject(vite, '/workspace')).toMatchObject({ kind: 'vite', devCommand: 'npm run dev', serveTemplate: 'vite' });

    const node = new FakeFS() as unknown as FileSystemAPI;
    await node.writeFile('/workspace/package.json', JSON.stringify({ name: 'svc', scripts: { start: 'node server.js' } }));
    expect(await detectProject(node, '/workspace')).toMatchObject({ kind: 'node', devCommand: 'npm start' });

    const py = new FakeFS() as unknown as FileSystemAPI;
    await py.writeFile('/workspace/pyproject.toml', '[project]');
    await py.writeFile('/workspace/main.py', 'print(1)');
    expect(await detectProject(py, '/workspace')).toMatchObject({ kind: 'python', devCommand: 'python main.py', serveTemplate: 'static-http' });

    const staticFs = new FakeFS() as unknown as FileSystemAPI;
    await staticFs.writeFile('/workspace/index.html', '<html></html>');
    expect(await detectProject(staticFs, '/workspace')).toMatchObject({ kind: 'static', serveTemplate: 'static-http' });

    expect(await detectProject(new FakeFS() as unknown as FileSystemAPI, '/workspace')).toMatchObject({ kind: 'none' });
  });

  it('init prints the detected project', async () => {
    const wc = new FakeFS() as unknown as WebContainer & { writeFile(p: string, c: string): Promise<void> };
    await wc.writeFile('/workspace/package.json', JSON.stringify({ name: 'demo', scripts: { dev: 'vite' } }));
    await wc.writeFile('/workspace/vite.config.js', 'export default {}');
    const ctx = ctxOf({ wc });
    await projectCmd(ctx, ['init']);
    const out = linesOf(ctx).join('\n');
    expect(out).toContain('vite');
    expect(out).toContain('demo');
    expect(out).toContain('succinix run');
  });

  it('run spawns the detected dev command through the execution world', async () => {
    const wc = new FakeFS() as unknown as WebContainer;
    await (wc as unknown as { writeFile(p: string, c: string): Promise<void> }).writeFile('/workspace/package.json', JSON.stringify({ name: 'demo', scripts: { start: 'node server.js' } }));
    const client = new FakeClient() as unknown as CommandContext['client'];
    const ctx = ctxOf({ wc, client });
    await projectCmd(ctx, ['run']);
    const out = linesOf(ctx).join('\n');
    expect(out).toContain("started 'npm start' (pid 123)");
    expect((client as unknown as { spawnCalls: Array<{ command: string }> }).spawnCalls.at(-1)?.command).toBe('npm start');
  });

  it('run gives interactive guidance for python projects', async () => {
    const wc = new FakeFS() as unknown as WebContainer & { writeFile(p: string, c: string): Promise<void> };
    await wc.writeFile('/workspace/pyproject.toml', '[project]');
    await wc.writeFile('/workspace/main.py', 'print(1)');
    const ctx = ctxOf({ wc });
    await projectCmd(ctx, ['run']);
    expect(linesOf(ctx).join('\n')).toContain('run \'python main.py\' in the shell');
  });

  it('serve registers and starts the static-http service', async () => {
    const fs = new FakeFS();
    await fs.writeFile('/workspace/index.html', '<html></html>');
    const wc = { fs } as unknown as WebContainer;
    const client = new FakeClient({
      terminal: (command) => {
        if (command.includes("'inspect'")) {
          return {
            ok: true,
            stdout: JSON.stringify({
              name: 'static-http', command: 'npx serve -s . -l ${PORT}', port: 3001,
              description: 'Static HTTP server', enabled: false, state: 'running', pid: 123,
            }),
          };
        }
        return { ok: true, stdout: 'ok' };
      },
    });
    const ctx = ctxOf({ wc, client: client as unknown as CommandContext['client'], ports: new Map([[3001, 'https://preview/3001']]) });
    await projectCmd(ctx, ['serve']);
    const out = linesOf(ctx).join('\n');
    expect(out).toContain("started 'static-http'");
    expect(out).toContain('preview: https://preview/3001');
  });

  it('open prints the preview URL for the requested port', async () => {
    const ctx = ctxOf({ ports: new Map([[3001, 'https://preview/3001']]) });
    await projectCmd(ctx, ['open', '3001']);
    expect(linesOf(ctx).join('\n')).toContain('https://preview/3001');
  });
});
