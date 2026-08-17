import fs from 'node:fs';
import path from 'node:path';
import * as isomorphicGit from 'isomorphic-git';
import httpWeb from 'isomorphic-git/http/web';

export interface GitCommandContext {
  args: string[];
  env: Record<string, string>;
  signal: AbortSignal;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
}

export interface GitProgress {
  phase: string;
  loaded: number;
  total: number;
}

export interface GitHttpRequest {
  url: string;
  fetchOptions?: Record<string, unknown>;
}

export interface GitHttp {
  request(request: GitHttpRequest): Promise<unknown>;
}

export interface GitOperationOptions {
  fs: unknown;
  dir?: string;
  filepath?: string;
  message?: string;
  author?: { name: string; email: string };
  committer?: { name: string; email: string };
  ref?: string;
  remote?: string;
  url?: string;
  corsProxy?: string;
  http?: GitHttp;
  depth?: number;
  singleBranch?: boolean;
  onAuth(): { username: string } | undefined;
  onProgress(progress: GitProgress): void | Promise<void>;
  [key: string]: unknown;
}

export interface GitApi {
  init(options: GitOperationOptions): Promise<unknown>;
  statusMatrix(options: GitOperationOptions): Promise<unknown>;
  add(options: GitOperationOptions): Promise<unknown>;
  remove(options: GitOperationOptions): Promise<unknown>;
  commit(options: GitOperationOptions): Promise<unknown>;
  log(options: GitOperationOptions): Promise<unknown>;
  listBranches(options: GitOperationOptions): Promise<unknown>;
  currentBranch(options: GitOperationOptions): Promise<unknown>;
  branch(options: GitOperationOptions): Promise<unknown>;
  checkout(options: GitOperationOptions): Promise<unknown>;
  clone(options: GitOperationOptions): Promise<unknown>;
  fetch(options: GitOperationOptions): Promise<unknown>;
  pull(options: GitOperationOptions): Promise<unknown>;
  push(options: GitOperationOptions): Promise<unknown>;
  getConfig(options: GitOperationOptions & { path: string }): Promise<unknown>;
}

export interface GitCommandDeps {
  dir: string;
  fs?: unknown;
  git?: GitApi;
  http?: GitHttp;
  resolveAbsolutePath?(requested: string): string | null;
}

const productionGit = isomorphicGit as unknown as GitApi;
const productionHttp = httpWeb as unknown as GitHttp;

function usage(ctx: GitCommandContext): number {
  ctx.stderr.write('usage: git <init|status|add|rm|commit|log|diff|branch|checkout|clone|fetch|pull|push> [arguments]\n');
  return 2;
}

function commandError(ctx: GitCommandContext, operation: string, error: unknown): number {
  if (ctx.signal.aborted) {
    ctx.stderr.write(`git: ${operation}: operation cancelled\n`);
    return 130;
  }
  const token = ctx.env.GIT_HTTP_TOKEN;
  const message = String(error instanceof Error ? error.message : error);
  ctx.stderr.write(`git: ${operation}: ${token ? message.replaceAll(token, '[REDACTED]') : message}\n`);
  return 1;
}

function abortable<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('operation cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('operation cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function httpWithAbort(http: GitHttp, signal: AbortSignal): GitHttp {
  return {
    request(request) {
      if (signal.aborted) return Promise.reject(new Error('operation cancelled'));
      return http.request({ ...request, fetchOptions: { ...request.fetchOptions, signal } });
    },
  };
}

function isSshRemote(remote: string): boolean {
  return remote.startsWith('git@') || remote.startsWith('ssh://') || remote.startsWith('git+ssh://');
}

function validRemote(ctx: GitCommandContext, remote: string): string | null {
  if (isSshRemote(remote)) {
    ctx.stderr.write('git: SSH transport is unsupported\n');
    return null;
  }
  try {
    const parsed = new URL(remote);
    if (parsed.username || parsed.password) {
      ctx.stderr.write('git: credentials in remote URLs are unsupported; use GIT_HTTP_TOKEN\n');
      return null;
    }
    if (parsed.protocol !== 'https:') {
      ctx.stderr.write('git: only HTTPS remotes are supported\n');
      return null;
    }
    return remote;
  } catch {
    ctx.stderr.write('git: remote URL must use HTTPS\n');
    return null;
  }
}

type ResolvedGitDeps = Required<Pick<GitCommandDeps, 'fs' | 'git' | 'http'>> & Pick<GitCommandDeps, 'dir' | 'resolveAbsolutePath'>;

function gitOptions(ctx: GitCommandContext, deps: ResolvedGitDeps): GitOperationOptions {
  const token = ctx.env.GIT_HTTP_TOKEN;
  const author = { name: ctx.env.GIT_AUTHOR_NAME ?? 'guest', email: ctx.env.GIT_AUTHOR_EMAIL ?? 'guest@succinix.local' };
  return {
    fs: deps.fs,
    dir: deps.dir,
    http: httpWithAbort(deps.http, ctx.signal),
    ...(ctx.env.GIT_CORS_PROXY ? { corsProxy: ctx.env.GIT_CORS_PROXY } : {}),
    author,
    committer: author,
    onAuth: () => token ? { username: token } : undefined,
    onProgress: (progress) => { ctx.stderr.write(`git: ${progress.phase} ${progress.loaded}/${progress.total}\n`); },
  };
}

function destination(deps: ResolvedGitDeps, requested: string): string | null {
  if (!requested || requested.startsWith('-')) return null;
  if (requested.startsWith('/') && deps.resolveAbsolutePath) return deps.resolveAbsolutePath(requested);
  return path.resolve(deps.dir, requested);
}

function branchName(value: unknown): string {
  return typeof value === 'string' && value ? value : 'HEAD';
}

function statusCode(head: number, worktree: number, stage: number): string {
  if (head === 0 && worktree === 2 && stage === 0) return '??';
  return `${head === stage ? ' ' : 'M'}${worktree === stage ? ' ' : 'M'}`;
}

async function configuredRemote(ctx: GitCommandContext, deps: ResolvedGitDeps): Promise<boolean> {
  try {
    const remote = await deps.git.getConfig({ ...gitOptions(ctx, deps), path: 'remote.origin.url' });
    return typeof remote !== 'string' || validRemote(ctx, remote) !== null;
  } catch (error) {
    commandError(ctx, 'remote', error);
    return false;
  }
}

async function runNetwork(ctx: GitCommandContext, deps: ResolvedGitDeps, operation: 'fetch' | 'pull' | 'push', requested?: string): Promise<number> {
  const options = gitOptions(ctx, deps);
  if (requested?.includes('://') || requested?.startsWith('git@')) {
    const url = validRemote(ctx, requested);
    if (!url) return 126;
    options.url = url;
  } else if (requested) {
    options.remote = requested;
  } else if (!await configuredRemote(ctx, deps)) {
    return 126;
  }
  try {
    await abortable(ctx.signal, deps.git[operation](options));
    ctx.stdout.write(`${operation[0]!.toUpperCase()}${operation.slice(1)} completed\n`);
    return 0;
  } catch (error) {
    return commandError(ctx, operation, error);
  }
}

export async function runGitCommand(ctx: GitCommandContext, injected: GitCommandDeps): Promise<number> {
  const deps: ResolvedGitDeps = {
    dir: injected.dir,
    fs: injected.fs ?? fs,
    git: injected.git ?? productionGit,
    http: injected.http ?? productionHttp,
    resolveAbsolutePath: injected.resolveAbsolutePath,
  };
  const [operation, ...args] = ctx.args;
  if (!operation || operation === '--help' || operation === '-h') return usage(ctx);

  if (operation === 'init') {
    const dir = args.length === 0 ? deps.dir : destination(deps, args[0]!);
    if (!dir || args.length > 1) return usage(ctx);
    try {
      await deps.git.init({ ...gitOptions(ctx, deps), dir });
      ctx.stdout.write(`Initialized empty Git repository in ${dir}/.git\n`);
      return 0;
    } catch (error) {
      return commandError(ctx, 'init', error);
    }
  }

  if (operation === 'status' || operation === 'diff') {
    if (args.length > 0) return usage(ctx);
    try {
      const matrix = await deps.git.statusMatrix(gitOptions(ctx, deps));
      const rows = Array.isArray(matrix) ? matrix : [];
      const changed = rows.filter((entry): entry is [string, number, number, number] =>
        Array.isArray(entry) && typeof entry[0] === 'string' && entry.slice(1).some((value) => typeof value !== 'number' || value !== 1),
      );
      if (operation === 'diff') {
        for (const [file] of changed) ctx.stdout.write(`diff --git a/${file} b/${file}\n`);
        return 0;
      }
      const current = branchName(await deps.git.currentBranch(gitOptions(ctx, deps)));
      ctx.stdout.write(`On branch ${current}\n`);
      if (changed.length === 0) ctx.stdout.write('nothing to commit, working tree clean\n');
      for (const [file, head, worktree, stage] of changed) ctx.stdout.write(`${statusCode(head, worktree, stage)} ${file}\n`);
      return 0;
    } catch (error) {
      return commandError(ctx, operation, error);
    }
  }

  if (operation === 'add' || operation === 'rm') {
    if (args.length === 0 || args.some((arg) => arg.startsWith('-'))) return usage(ctx);
    try {
      for (const filepath of args) await (operation === 'add' ? deps.git.add : deps.git.remove)({ ...gitOptions(ctx, deps), filepath });
      return 0;
    } catch (error) {
      return commandError(ctx, operation, error);
    }
  }

  if (operation === 'commit') {
    const messageIndex = args.findIndex((arg) => arg === '-m' || arg === '--message');
    const message = messageIndex >= 0 ? args[messageIndex + 1] : undefined;
    if (!message || args.length !== 2 || messageIndex !== 0) return usage(ctx);
    try {
      const oid = String(await deps.git.commit({ ...gitOptions(ctx, deps), message }));
      const current = branchName(await deps.git.currentBranch(gitOptions(ctx, deps)));
      ctx.stdout.write(`[${current} ${oid.slice(0, 7)}] ${message}\n`);
      return 0;
    } catch (error) {
      return commandError(ctx, 'commit', error);
    }
  }

  if (operation === 'log') {
    if (args.some((arg) => arg !== '--oneline')) return usage(ctx);
    try {
      const entries = await deps.git.log({ ...gitOptions(ctx, deps), depth: 50 });
      for (const entry of Array.isArray(entries) ? entries : []) {
        const record = entry as { oid?: unknown; commit?: { message?: unknown; author?: { name?: unknown } } };
        const line = args.includes('--oneline')
          ? `${String(record.oid ?? '').slice(0, 7)} ${String(record.commit?.message ?? '').split('\n')[0] ?? ''}`
          : `commit ${String(record.oid ?? '')}\nAuthor: ${String(record.commit?.author?.name ?? '')}\n\n    ${String(record.commit?.message ?? '').replace(/\n/g, '\n    ')}`;
        ctx.stdout.write(`${line}\n`);
      }
      return 0;
    } catch (error) {
      return commandError(ctx, 'log', error);
    }
  }

  if (operation === 'branch') {
    if (args.length > 1) return usage(ctx);
    try {
      if (args[0]) {
        if (args[0].startsWith('-')) return usage(ctx);
        await deps.git.branch({ ...gitOptions(ctx, deps), ref: args[0] });
        return 0;
      }
      const current = branchName(await deps.git.currentBranch(gitOptions(ctx, deps)));
      const branches = await deps.git.listBranches(gitOptions(ctx, deps));
      for (const name of Array.isArray(branches) ? branches : []) ctx.stdout.write(`${name === current ? '* ' : '  '}${String(name)}\n`);
      return 0;
    } catch (error) {
      return commandError(ctx, 'branch', error);
    }
  }

  if (operation === 'checkout') {
    const create = args[0] === '-b';
    const ref = create ? args[1] : args[0];
    if (!ref || args.length !== (create ? 2 : 1) || ref.startsWith('-')) return usage(ctx);
    try {
      if (create) await deps.git.branch({ ...gitOptions(ctx, deps), ref });
      await deps.git.checkout({ ...gitOptions(ctx, deps), ref });
      ctx.stdout.write(`Switched to branch '${ref}'\n`);
      return 0;
    } catch (error) {
      return commandError(ctx, 'checkout', error);
    }
  }

  if (operation === 'clone') {
    const remote = args[0];
    const dir = args[1] ? destination(deps, args[1]) : remote ? destination(deps, path.basename(remote).replace(/\.git$/, '')) : null;
    if (!remote || !dir || args.length > 2) return usage(ctx);
    const url = validRemote(ctx, remote);
    if (!url) return 126;
    try {
      await abortable(ctx.signal, deps.git.clone({ ...gitOptions(ctx, deps), dir, url, singleBranch: true, depth: 50 }));
      ctx.stdout.write(`Cloned '${url}' into '${dir}'\n`);
      return 0;
    } catch (error) {
      return commandError(ctx, 'clone', error);
    }
  }

  if (operation === 'fetch' || operation === 'pull' || operation === 'push') return runNetwork(ctx, deps, operation, args[0]);
  return usage(ctx);
}
