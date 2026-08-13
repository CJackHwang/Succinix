// S0.5: dsh ctx.sandbox execution-world confinement seam.
import { describe, it, expect } from 'vitest';
import {
  SandboxUnavailableError,
  type SandboxPolicy,
} from '../src/plugin/dsh-types.js';
import {
  SuccinixSandboxService,
  writableRoots,
} from '../src/plugin/sandbox-service.js';

function service(available = true): SuccinixSandboxService {
  return new SuccinixSandboxService({ available, workspaceRoot: '/workspace' });
}

function policy(mode: 'read-only' | 'workspace-write', workspaceRoot = '/workspace'): SandboxPolicy {
  return { mode, workspaceRoot };
}

describe('ctx.sandbox confine', () => {
  it('returns a synchronous Lifo wrapper with full enforcement and evidence', () => {
    const confined = service().confine(['echo', 'a b', 'c'], policy('read-only'));
    expect(confined.argv).toEqual(['succinix-sandbox', '--mode', 'read-only', '--workspace', '/workspace', 'echo', 'a b', 'c']);
    expect(confined.enforcement).toBe('full');
    expect(confined.denialSignatures).toContain('EACCES');
    expect(confined.denialSignatures).toContain('EROFS');
    expect(confined.denialSignatures).not.toContain('EPERM');
    expect(confined.runnerFailureRules[0]).toMatchObject({
      allowedExitCodes: [126, 127],
      fatalSignatures: ['command not found', 'sandbox unavailable'],
    });
  });

  it('canonicalizes workspace-write roots and maps writable roots into the execution world', () => {
    const serviceInstance = service();
    const confined = serviceInstance.confine(['ls'], policy('workspace-write', '/workspace/sub/../sub'));
    expect(confined.argv).toContain('/workspace/sub');
    expect(writableRoots(policy('read-only'))).toEqual([]);
    const roots = writableRoots(policy('workspace-write', '/workspace/sub'));
    expect(roots).toContain('/workspace/sub');
    expect(roots).toContain('/tmp');
  });

  it('treats argv as an exact argv, never a shell string', () => {
    const confined = service().confine(['printf', '%s', 'a b'], policy('workspace-write'));
    expect(confined.argv).toEqual(['succinix-sandbox', '--mode', 'workspace-write', '--workspace', '/workspace', 'printf', '%s', 'a b']);
  });

  it('fails closed for real node/npm/npx subprocesses', () => {
    const sandbox = service();
    for (const command of ['node', 'npm', 'npx']) {
      expect(() => sandbox.confine([command, '-e', 'console.log(1)'], policy('read-only'))).toThrowError(SandboxUnavailableError);
      expect(() => sandbox.confine([command, '--version'], policy('workspace-write'))).toThrowError(SandboxUnavailableError);
    }
  });

  it('rejects danger-full-access and empty argv synchronously', () => {
    const sandbox = service();
    const danger = { mode: 'danger-full-access', workspaceRoot: '/workspace' } as unknown as SandboxPolicy;
    expect(() => sandbox.confine(['echo', 'x'], danger)).toThrowError(SandboxUnavailableError);
    expect(() => sandbox.confine([], policy('read-only'))).toThrowError(SandboxUnavailableError);
    expect(() => sandbox.confine([''], policy('read-only'))).toThrowError(SandboxUnavailableError);
  });

  it('is unavailable when the host runtime is not ready', () => {
    const sandbox = service(false);
    expect(() => sandbox.confine(['echo', 'x'], policy('read-only'))).toThrowError(SandboxUnavailableError);
  });

  it('does not let consumers mutate shared runner evidence', () => {
    const confined = service().confine(['echo'], policy('read-only'));
    (confined.runnerFailureRules[0]!.allowedExitCodes as number[]).push(1);
    const again = service().confine(['echo'], policy('read-only'));
    expect(again.runnerFailureRules[0]!.allowedExitCodes).toEqual([126, 127]);
  });
});
