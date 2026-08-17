import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { requestRubyRuntime } from '../src/engine/host/ruby.js';
import {
  RUBY_ERROR_FILE,
  RUBY_READY_FILE,
  RUBY_REQUEST_FILE,
  createRubyRequestId,
} from '../src/engine/ruby-protocol.js';
import { wasiInfoCommand, runWasiCommand } from '../src/engine/host/wasi.js';
import { startRuntimeAssetBridge } from '../src/engine/runtime-asset-bridge.js';

function context(args: string[]) {
  let stdout = '';
  let stderr = '';
  return {
    ctx: {
      args,
      cwd: '/workspace',
      env: {},
      signal: new AbortController().signal,
      stdin: { readAll: async () => '' },
      stdout: { write: (text: string) => { stdout += text; } },
      stderr: { write: (text: string) => { stderr += text; } },
    } as never,
    output: () => ({ stdout, stderr }),
  };
}

describe('deferred Ruby runtime handshake', () => {
  it('uses random request ids and times out with complete cleanup', async () => {
    expect(createRubyRequestId(() => 1000, () => 0.5)).toMatch(/^ruby-rs-/);
    await expect(requestRubyRuntime(20)).rejects.toThrow(/timed out/);
    expect(fs.existsSync(path.join(process.cwd(), RUBY_REQUEST_FILE.slice(1)))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), RUBY_READY_FILE.slice(1)))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), RUBY_ERROR_FILE.slice(1)))).toBe(false);
  });

  it('browser bridge writes a request-matched error marker and removes request', async () => {
    const files = new Map<string, string | Uint8Array>([
      [RUBY_REQUEST_FILE, JSON.stringify({ protocolVersion: 1, requestId: 'ruby-test', requestedAt: Date.now() })],
    ]);
    const fsApi = {
      mkdir: async () => {},
      readFile: async (file: string, encoding?: string) => {
        const value = files.get(file);
        if (value === undefined) throw new Error(`ENOENT: ${file}`);
        return encoding === 'utf8' && typeof value !== 'string' ? new TextDecoder().decode(value) : value;
      },
      writeFile: async (file: string, value: string | Uint8Array) => { files.set(file, value); },
      rm: async (file: string) => { files.delete(file); },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
    const bridge = startRuntimeAssetBridge({ fs: fsApi } as never, { pollMs: 16 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    bridge.stop();
    globalThis.fetch = originalFetch;
    expect(files.has(RUBY_REQUEST_FILE)).toBe(false);
    const error = String(files.get(RUBY_ERROR_FILE));
    expect(error).toContain('ruby-test');
  });
});

describe('WASI userland command boundaries', () => {
  it('fails closed for missing module and reports a stable info error', async () => {
    const missing = context([]);
    expect(await wasiInfoCommand(missing.ctx, process.cwd())).toBe(2);
    expect(missing.output().stderr).toContain('missing WebAssembly module');
    const invalid = context(['--timeout', '0', 'missing.wasm']);
    expect(await runWasiCommand(invalid.ctx, process.cwd())).toBe(2);
    expect(invalid.output().stderr).toContain('positive number');
  });
});
