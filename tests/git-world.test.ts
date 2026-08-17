import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGitCommand, type GitApi, type GitCommandContext } from '../src/engine/host/git-world.js';

function context(args: string[], env: Record<string, string> = {}, signal: AbortSignal = new AbortController().signal): { ctx: GitCommandContext; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    ctx: {
      args,
      env,
      signal,
      stdout: { write: (text: string) => { stdout.push(text); } },
      stderr: { write: (text: string) => { stderr.push(text); } },
    },
    stdout,
    stderr,
  };
}

function gitApi(overrides: Partial<GitApi> = {}): GitApi {
  return {
    init: vi.fn(async () => undefined),
    statusMatrix: vi.fn(async () => []),
    add: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    commit: vi.fn(async () => 'abc123def456'),
    log: vi.fn(async () => []),
    listBranches: vi.fn(async () => []),
    currentBranch: vi.fn(async () => 'main'),
    branch: vi.fn(async () => undefined),
    checkout: vi.fn(async () => undefined),
    clone: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
    push: vi.fn(async () => ({ ok: true })),
    getConfig: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('execution-world Git HTTPS adapter', () => {
  it('executes the local workflow against the real shared node filesystem', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'succinix-git-'));
    const run = (args: string[]) => runGitCommand(context(args).ctx, { dir });
    try {
      expect(await run(['init'])).toBe(0);
      await fs.writeFile(path.join(dir, 'file.txt'), 'first\n');
      expect(await run(['add', 'file.txt'])).toBe(0);
      expect(await run(['commit', '-m', 'Initial commit'])).toBe(0);
      expect(await run(['branch', 'feature'])).toBe(0);
      expect(await run(['checkout', 'feature'])).toBe(0);
      await fs.writeFile(path.join(dir, 'file.txt'), 'second\n');
      const status = context(['status']);
      expect(await runGitCommand(status.ctx, { dir })).toBe(0);
      expect(status.stdout.join('')).toContain(' M file.txt');
      const log = context(['log', '--oneline']);
      expect(await runGitCommand(log.ctx, { dir })).toBe(0);
      expect(log.stdout.join('')).toContain('Initial commit');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('clones HTTPS through the cancellable transport and keeps the token out of output', async () => {
    const api = gitApi();
    const request = context(
      ['clone', 'https://github.com/example/repository.git', 'repository'],
      { GIT_HTTP_TOKEN: 'private-token', GIT_CORS_PROXY: 'https://proxy.example' },
    );
    const http = { request: vi.fn(async () => ({ statusCode: 200 })) };

    expect(await runGitCommand(request.ctx, { dir: '/workspace', fs: {}, git: api, http })).toBe(0);
    expect(api.clone).toHaveBeenCalledOnce();
    const options = vi.mocked(api.clone).mock.calls[0]![0];
    expect(options).toMatchObject({
      dir: '/workspace/repository',
      url: 'https://github.com/example/repository.git',
      corsProxy: 'https://proxy.example',
    });
    expect(options.onAuth()).toEqual({ username: 'private-token' });
    await options.onProgress({ phase: 'Receiving objects', loaded: 1, total: 2 });
    expect(request.stderr.join('')).toContain('Receiving objects 1/2');
    expect(request.stdout.join('')).toContain("Cloned 'https://github.com/example/repository.git'");
    expect(request.stdout.join('')).not.toContain('private-token');

    await options.http!.request({ url: 'https://proxy.example/https://github.com/example/repository.git' });
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({
      fetchOptions: expect.objectContaining({ signal: request.ctx.signal }),
    }));
  });

  it('maps an absolute Lifo workspace destination to the host filesystem', async () => {
    const api = gitApi();
    const request = context(['clone', 'https://github.com/example/repository.git', '/workspace/project']);
    const resolveAbsolutePath = vi.fn((requested: string) => requested === '/workspace/project' ? '/host-root/project' : null);

    expect(await runGitCommand(request.ctx, {
      dir: '/host-root/current', fs: {}, git: api, http: { request: vi.fn() }, resolveAbsolutePath,
    })).toBe(0);

    expect(resolveAbsolutePath).toHaveBeenCalledWith('/workspace/project');
    expect(api.clone).toHaveBeenCalledWith(expect.objectContaining({ dir: '/host-root/project' }));
  });

  it('uses direct HTTPS unless a CORS proxy is explicitly configured', async () => {
    const api = gitApi();
    const request = context(['clone', 'https://github.com/example/repository.git', 'repository']);

    expect(await runGitCommand(request.ctx, { dir: '/workspace', fs: {}, git: api, http: { request: vi.fn() } })).toBe(0);

    expect(vi.mocked(api.clone).mock.calls[0]![0].corsProxy).toBeUndefined();
  });

  it('supports init, add, commit, branch, checkout, status, and log in the same host filesystem', async () => {
    const api = gitApi({
      statusMatrix: vi.fn(async () => [['file.txt', 1, 2, 1]]),
      log: vi.fn(async () => [{ oid: 'abc123def456', commit: { message: 'Initial commit', author: { name: 'Guest' } } }]),
    });
    const deps = { dir: '/workspace/project', fs: {}, git: api, http: { request: vi.fn() } };

    for (const args of [['init'], ['add', 'file.txt'], ['commit', '-m', 'Initial commit'], ['branch', 'feature'], ['checkout', 'feature']]) {
      expect(await runGitCommand(context(args).ctx, deps)).toBe(0);
    }
    const status = context(['status']);
    expect(await runGitCommand(status.ctx, deps)).toBe(0);
    expect(status.stdout.join('')).toContain(' M file.txt');
    const log = context(['log', '--oneline']);
    expect(await runGitCommand(log.ctx, deps)).toBe(0);
    expect(log.stdout.join('')).toContain('abc123d Initial commit');
    expect(api.commit).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Initial commit',
      author: { name: 'guest', email: 'guest@succinix.local' },
    }));
  });

  it('forwards fetch, pull, and push through HTTPS with progress and token authentication', async () => {
    const api = gitApi();
    const deps = {
      dir: '/workspace/project',
      fs: {},
      git: api,
      http: { request: vi.fn() },
    };
    for (const args of [['fetch'], ['pull'], ['push']]) {
      expect(await runGitCommand(context(args, { GIT_HTTP_TOKEN: 'private-token' }).ctx, deps)).toBe(0);
    }
    for (const operation of [api.fetch, api.pull, api.push]) {
      const options = vi.mocked(operation).mock.calls[0]![0];
      expect(options.onAuth()).toEqual({ username: 'private-token' });
      expect(options.http).toBeDefined();
    }
    expect(vi.mocked(api.pull).mock.calls[0]![0]).toMatchObject({
      author: { name: 'guest', email: 'guest@succinix.local' },
      committer: { name: 'guest', email: 'guest@succinix.local' },
    });
  });

  it('fails closed for SSH and credentials embedded in a remote URL', async () => {
    for (const remote of ['git@github.com:example/repository.git', 'ssh://git@github.com/example/repository.git', 'https://user:token@github.com/example/repository.git']) {
      const request = context(['clone', remote]);
      expect(await runGitCommand(request.ctx, { dir: '/workspace', fs: {}, git: gitApi(), http: { request: vi.fn() } })).toBe(126);
      expect(request.stderr.join('')).toMatch(/SSH transport is unsupported|credentials in remote URLs are unsupported/);
    }
  });

  it('returns exit 130 when a network transport does not settle after cancellation', async () => {
    const controller = new AbortController();
    const request = context(['clone', 'https://github.com/example/repository.git'], {}, controller.signal);
    const api = gitApi({ clone: vi.fn(() => new Promise(() => {})) });
    const pending = runGitCommand(request.ctx, { dir: '/workspace', fs: {}, git: api, http: { request: vi.fn() } });

    controller.abort();

    await expect(pending).resolves.toBe(130);
    expect(request.stderr.join('')).toContain('operation cancelled');
  });
});
