import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CommandContext } from '@lifo-sh/core';
import { lifoSpawndCwd } from '../host-route.js';

const DEFAULT_WASI_TIMEOUT_MS = 30_000;
const MAX_WASI_MODULE_BYTES = 32 * 1024 * 1024;
const MAX_WASI_STDIN_BYTES = 1024 * 1024;
const MAX_WASI_OUTPUT_BYTES = 1024 * 1024;
const WASI_WORKER_OLD_SPACE_MB = 96;

interface WasiArgs {
  file: string;
  argv: string[];
  timeoutMs: number;
}

function parseArgs(args: string[]): WasiArgs | string {
  let timeoutMs = DEFAULT_WASI_TIMEOUT_MS;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === '--timeout') {
      const parsed = Number(args[++index]);
      if (!Number.isFinite(parsed) || parsed <= 0) return 'wasi-run: --timeout requires a positive number of milliseconds';
      timeoutMs = Math.floor(parsed);
    } else {
      rest.push(value);
    }
  }
  if (!rest[0]) return 'wasi-run: missing WebAssembly module';
  return { file: rest[0], argv: rest.slice(1), timeoutMs };
}

function realModulePath(file: string, cwd: string, hostRoot: string): string {
  if (file === '/workspace') return hostRoot;
  if (file.startsWith('/workspace/')) return path.join(hostRoot, file.slice('/workspace/'.length));
  if (file.startsWith('/')) throw new Error(`wasi-run: path is not mapped to the shared workspace: ${file}`);
  const realCwd = lifoSpawndCwd(cwd, hostRoot, hostRoot);
  if (!realCwd) throw new Error(`wasi-run: cwd is outside the shared workspace: ${cwd}`);
  return path.resolve(realCwd, file);
}

function capUtf8(value: string, limit = MAX_WASI_OUTPUT_BYTES): string {
  const bytes = Buffer.from(value);
  return bytes.byteLength <= limit ? value : bytes.subarray(bytes.byteLength - limit).toString('utf8');
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { WASI } = require('node:wasi');
(async () => {
  try {
    const wasi = new WASI({
      version: 'preview1',
      returnOnExit: true,
      args: [workerData.file, ...workerData.argv],
      env: workerData.env,
      preopens: { '/workspace': workerData.hostRoot },
    });
    const module = await WebAssembly.compile(workerData.bytes);
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    const code = wasi.start(instance);
    parentPort.postMessage({ ok: true, code: typeof code === 'number' ? code : 0 });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String(error) });
  }
})().catch((error) => parentPort.postMessage({ ok: false, error: String(error) }));
`;

export async function runWasiCommand(ctx: CommandContext, hostRoot: string): Promise<number> {
  const parsed = parseArgs(ctx.args);
  if (typeof parsed === 'string') {
    ctx.stderr.write(`${parsed}\n`);
    return 2;
  }
  let moduleBytes: Uint8Array;
  let file: string;
  try {
    file = realModulePath(parsed.file, ctx.cwd, hostRoot);
    moduleBytes = fs.readFileSync(file);
    if (moduleBytes.byteLength > MAX_WASI_MODULE_BYTES) {
      ctx.stderr.write(`wasi-run: module exceeds ${MAX_WASI_MODULE_BYTES} byte limit\n`);
      return 1;
    }
  } catch (error) {
    ctx.stderr.write(`wasi-run: ${String(error)}\n`);
    return 1;
  }
  const stdin = await ctx.stdin?.readAll() ?? '';
  if (Buffer.byteLength(stdin) > MAX_WASI_STDIN_BYTES) {
    ctx.stderr.write(`wasi-run: stdin exceeds ${MAX_WASI_STDIN_BYTES} byte limit\n`);
    return 1;
  }
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    stdin: true,
    stdout: true,
    stderr: true,
    resourceLimits: {
      maxOldGenerationSizeMb: WASI_WORKER_OLD_SPACE_MB,
      maxYoungGenerationSizeMb: 16,
    },
    workerData: {
      bytes: moduleBytes,
      file: parsed.file,
      argv: parsed.argv,
      env: ctx.env,
      hostRoot,
    },
  });
  let stdout = '';
  let stderr = '';
  worker.stdout?.on('data', (chunk: Buffer) => { stdout = capUtf8(stdout + chunk.toString()); });
  worker.stderr?.on('data', (chunk: Buffer) => { stderr = capUtf8(stderr + chunk.toString()); });
  if (stdin) worker.stdin?.end(stdin);
  else worker.stdin?.end();

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = async (code: number, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ctx.signal.removeEventListener('abort', abort);
      ctx.stdout.write(stdout);
      ctx.stderr.write(stderr);
      if (error) ctx.stderr.write(`${error}\n`);
      await worker.terminate().catch(() => undefined);
      resolve(code);
    };
    const timeout = setTimeout(() => {
      void finish(124, `wasi-run: timed out after ${parsed.timeoutMs}ms`);
    }, parsed.timeoutMs);
    const abort = () => { void finish(130, 'wasi-run: interrupted'); };
    ctx.signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (result: { ok?: boolean; code?: number; error?: string }) => {
      ctx.signal.removeEventListener('abort', abort);
      void finish(result.ok ? result.code ?? 0 : 1, result.error);
    });
    worker.once('error', (error) => {
      void finish(1, `wasi-run: ${String(error)}`);
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) void finish(1, `wasi-run: worker exited unexpectedly (${code})`);
    });
  });
}

export async function wasiInfoCommand(ctx: CommandContext, hostRoot: string): Promise<number> {
  const file = ctx.args[0];
  if (!file) {
    ctx.stderr.write('wasi-info: missing WebAssembly module\n');
    return 2;
  }
  try {
    const bytes = fs.readFileSync(realModulePath(file, ctx.cwd, hostRoot));
    if (bytes.byteLength > MAX_WASI_MODULE_BYTES) {
      ctx.stderr.write(`wasi-info: module exceeds ${MAX_WASI_MODULE_BYTES} byte limit\n`);
      return 1;
    }
    const module = await WebAssembly.compile(bytes);
    ctx.stdout.write(`module: ${file}\n`);
    ctx.stdout.write(`bytes: ${bytes.byteLength}\n`);
    ctx.stdout.write('runtime: WASI preview1 via node:wasi\n');
    ctx.stdout.write(`limits: module=${MAX_WASI_MODULE_BYTES} stdin=${MAX_WASI_STDIN_BYTES} stdout/stderr=${MAX_WASI_OUTPUT_BYTES} timeout=${DEFAULT_WASI_TIMEOUT_MS}\n`);
    ctx.stdout.write('imports:\n');
    for (const item of WebAssembly.Module.imports(module)) ctx.stdout.write(`  ${item.module}.${item.name} ${item.kind}\n`);
    ctx.stdout.write('exports:\n');
    for (const item of WebAssembly.Module.exports(module)) ctx.stdout.write(`  ${item.name} ${item.kind}\n`);
    return 0;
  } catch (error) {
    ctx.stderr.write(`wasi-info: ${String(error)}\n`);
    return 1;
  }
}
