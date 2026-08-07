// host-procs.ts 单元测试（TASK-CISOL R1）：进程归属判定 + 登记时记录 cwd → ps() 附加 scope/containerId。
import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { classifyProcess, registerProcess, listProcesses } from '../src/engine/host-procs.js';

/** 最小 ChildProcess 替身（registerProcess 只依赖 pid / on / kill）。 */
function fakeChild(pid: number): ChildProcess {
  const child: Partial<ChildProcess> = {
    pid,
    on: vi.fn() as unknown as ChildProcess['on'],
    kill: vi.fn(() => true) as unknown as ChildProcess['kill'],
  };
  return child as ChildProcess;
}

describe('classifyProcess（归属判定）', () => {
  it('classifies host / python daemon / /usr/lib/succinix launches as system', () => {
    expect(classifyProcess('node host.js')).toEqual({ scope: 'system' });
    expect(classifyProcess('node /home/workspace/host.js', '/home/workspace')).toEqual({ scope: 'system' });
    expect(classifyProcess('node python-daemon.js')).toEqual({ scope: 'system' });
    expect(classifyProcess('node /usr/lib/succinix/python/python-daemon.js', '/home/workspace/c-1')).toEqual({ scope: 'system' });
    expect(classifyProcess('node /usr/lib/succinix/some-binary')).toEqual({ scope: 'system' });
  });

  it('classifies container-launched processes from a c-<id> cwd segment (agent cd-prefixed commands)', () => {
    // VFS 视角 cwd（/workspace/c-1）与 host 真实路径（/home/workspace/c-1）都命中。
    expect(classifyProcess('node server.js', '/workspace/c-1')).toEqual({ scope: 'container', containerId: 'c-1' });
    expect(classifyProcess('node server.js', '/home/workspace/c-1')).toEqual({ scope: 'container', containerId: 'c-1' });
    // 容器内子目录：cwd 落在容器根下仍归该容器（取路径中首个 c-<id> 段）。
    expect(classifyProcess('npm test', '/home/workspace/c-2/project')).toEqual({ scope: 'container', containerId: 'c-2' });
    // 容器 id 允许数字/下划线/连字符（c- 前缀后）。
    expect(classifyProcess('node app.js', '/home/workspace/c-ab_12')).toEqual({ scope: 'container', containerId: 'c-ab_12' });
    expect(classifyProcess('node app.js', '/home/workspace/c-12')).toEqual({ scope: 'container', containerId: 'c-12' });
  });

  it('classifies processes without a resolvable container cwd as unknown (R5 如实标注)', () => {
    expect(classifyProcess('node server.js')).toEqual({ scope: 'unknown' });
    expect(classifyProcess('node server.js', '/workspace')).toEqual({ scope: 'unknown' });
    expect(classifyProcess('node server.js', '/home/workspace')).toEqual({ scope: 'unknown' });
    expect(classifyProcess('grep foo', '/tmp/whatever')).toEqual({ scope: 'unknown' });
    expect(classifyProcess('')).toEqual({ scope: 'unknown' });
    // 用户目录恰好叫 c-x 但不在容器根下？容器根是 /workspace / /home/workspace 下的 c-*——
    // 启发式如实记录：任何含 c-<id> 段的 cwd 都归 container（R5 盲区如实，不硬造）。
    expect(classifyProcess('node x.js', '/home/workspace/c-1/c-2')).toEqual({ scope: 'container', containerId: 'c-1' });
  });

  it('prefers system classification over a container cwd (python daemon under a container-ish cwd)', () => {
    expect(classifyProcess('node /usr/lib/succinix/python/python-daemon.js', '/home/workspace/c-1')).toEqual({ scope: 'system' });
  });
});

describe('registerProcess + listProcesses（登记记录 cwd → ps 附带归属）', () => {
  it('attaches scope/containerId from the registered spawn cwd', () => {
    const child = fakeChild(1001);
    registerProcess('node server.js', child, '/home/workspace/c-1');
    const view = listProcesses().find((entry) => entry.pid === 1001);
    expect(view).toBeDefined();
    expect(view?.scope).toBe('container');
    expect(view?.containerId).toBe('c-1');
  });

  it('attaches scope=system for a system command regardless of cwd', () => {
    registerProcess('node host.js', fakeChild(1002), '/home/workspace/c-1');
    const view = listProcesses().find((entry) => entry.pid === 1002);
    expect(view?.scope).toBe('system');
    expect(view?.containerId).toBeUndefined();
  });

  it('attaches scope=unknown when no cwd was recorded at registration', () => {
    registerProcess('node server.js', fakeChild(1003));
    const view = listProcesses().find((entry) => entry.pid === 1003);
    expect(view?.scope).toBe('unknown');
    expect(view?.containerId).toBeUndefined();
  });

  it('marks the entry exited and keeps the ownership fields on close', () => {
    let onClose: ((code?: number | null) => void) | undefined;
    const child = fakeChild(1004);
    child.on = vi.fn((event: string, cb: (code?: number | null) => void) => { if (event === 'close') onClose = cb; return child; });
    registerProcess('node server.js', child, '/home/workspace/c-7');
    onClose?.(0);
    const view = listProcesses().find((entry) => entry.pid === 1004);
    expect(view?.status).toBe('exited');
    expect(view?.exitCode).toBe(0);
    expect(view?.scope).toBe('container');
    expect(view?.containerId).toBe('c-7');
  });
});
