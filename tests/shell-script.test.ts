import { describe, expect, it, vi } from 'vitest';
import { VFS } from '@lifo-sh/core';
import { runShellScript } from '../src/engine/host/real-binaries.js';
import { registerRuntimeCommands } from '../src/engine/host/runtime-commands.js';

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

  it('resolves a relative script path from the current Lifo cwd', async () => {
    const fixture = scriptContext('#!/bin/sh\necho value\n');
    fixture.ctx.args = ['./script.sh'];

    expect(await runShellScript(fixture.ctx as never, 'sh')).toBe(0);
    expect(fixture.executeCaptureResult).toHaveBeenCalledWith('#!/bin/sh\necho value\n', { cwd: '/workspace' });
  });

  it('rejects missing, flag, and extra script arguments without executing', async () => {
    for (const args of [[], ['--help'], ['script.sh', 'extra']]) {
      const fixture = scriptContext('#!/bin/sh\necho value\n');
      fixture.ctx.args = args;

      expect(await runShellScript(fixture.ctx as never, 'sh')).toBe(2);
      expect(fixture.stderr).toEqual(['usage: sh script\n']);
      expect(fixture.executeCaptureResult).not.toHaveBeenCalled();
    }
  });

  it('rejects a bash here-document before executing the script', async () => {
    const fixture = scriptContext('#!/bin/bash\ncat <<EOF\nvalue\nEOF\n');

    expect(await runShellScript(fixture.ctx as never, 'bash')).toBe(2);
    expect(fixture.stderr).toEqual(['succinix: here-document: unsupported\n']);
    expect(fixture.executeCaptureResult).not.toHaveBeenCalled();
  });

  it('forwards complex script output and preserves the shell exit code', async () => {
    const source = [
      '#!/bin/sh',
      'printf "alpha\\nbeta\\n" | grep beta > relative.txt',
      'NAME=world',
      'printf "hello %s\\n" "$NAME" >> relative.txt',
      'printf "%s\\n" contract-glob/*.txt >> relative.txt',
    ].join('\n');
    const fixture = scriptContext(source);
    fixture.ctx.args = ['./script.sh'];
    fixture.executeCaptureResult.mockResolvedValueOnce({ stdout: 'beta\nhello world\n', stderr: 'script failure\n', code: 17 });

    expect(await runShellScript(fixture.ctx as never, 'bash')).toBe(17);
    expect(fixture.executeCaptureResult).toHaveBeenCalledWith(source, { cwd: '/workspace' });
    expect(fixture.stdout).toEqual(['beta\nhello world\n']);
    expect(fixture.stderr).toEqual(['script failure\n']);
  });

  it('keeps bash without a script as an explicit compatibility banner', async () => {
    const commands = new Map<string, (ctx: never) => Promise<number>>();
    registerRuntimeCommands({
      commands: { register: (name: string, handler: unknown) => { commands.set(name, handler as never); } },
      kernel: { vfs: new VFS(), serviceManager: null },
    } as never, 'shell-contract', () => null, async () => 1);
    const stdout: string[] = [];

    const code = await commands.get('bash')!({
      args: [], env: {}, cwd: '/workspace', vfs: new VFS(),
      stdout: { write: (text: string) => stdout.push(text) },
      stderr: { write: () => undefined },
      signal: new AbortController().signal,
    } as never);

    expect(code).toBe(0);
    expect(stdout).toEqual(['Succinix shell: bash-compatible userland subset\n']);
  });
});
