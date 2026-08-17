import { describe, expect, it, vi } from 'vitest';
import { VFS } from '@lifo-sh/core';
import { runShellScript } from '../src/engine/host/real-binaries.js';

function scriptContext(source: string) {
  const vfs = new VFS();
  vfs.mkdir('/workspace', { recursive: true });
  vfs.writeFile('/workspace/script.sh', source);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const executeCaptureResult = vi.fn(async () => ({ stdout: 'script output\n', stderr: '', code: 0 }));
  return {
    ctx: {
      args: ['script.sh'], env: {}, cwd: '/workspace', vfs,
      stdout: { write: (text: string) => stdout.push(text) },
      stderr: { write: (text: string) => stderr.push(text) },
      signal: new AbortController().signal, executeCaptureResult,
    },
    stdout,
    stderr,
    executeCaptureResult,
  };
}

describe('execution-world shell scripts', () => {
  it('rejects an unsupported here-document before executing the script', async () => {
    const fixture = scriptContext('#!/bin/sh\ncat <<EOF\nvalue\nEOF\n');

    expect(await runShellScript(fixture.ctx as never, 'sh')).toBe(2);
    expect(fixture.stderr).toEqual(['succinix: here-document: unsupported\n']);
    expect(fixture.executeCaptureResult).not.toHaveBeenCalled();
  });

  it('executes a supported script in the current Lifo shell and forwards output', async () => {
    const fixture = scriptContext('#!/bin/sh\necho value\n');

    expect(await runShellScript(fixture.ctx as never, 'sh')).toBe(0);
    expect(fixture.executeCaptureResult).toHaveBeenCalledWith('#!/bin/sh\necho value\n', { cwd: '/workspace' });
    expect(fixture.stdout).toEqual(['script output\n']);
  });
});
