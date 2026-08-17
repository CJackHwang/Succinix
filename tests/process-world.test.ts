import { describe, expect, it } from 'vitest';
import { LifoProcessProjection, lifoProcessRuntime } from '../src/engine/host/process-world.js';

function process(overrides: Partial<Parameters<LifoProcessProjection['project']>[1][number]> = {}) {
  return {
    pid: 2,
    command: 'sleep',
    args: ['sleep', '60'],
    cwd: '/workspace',
    startTime: 100,
    status: 'running' as const,
    isForeground: false,
    exitCode: null,
    ...overrides,
  };
}

describe('Lifo process projection', () => {
  it('allocates stable, host-wide PIDs for colliding per-instance PIDs', () => {
    const projection = new LifoProcessProjection();
    const a = projection.project('a', [process()])[0]!;
    const b = projection.project('b', [process()])[0]!;
    expect(a.pid).not.toBe(b.pid);
    expect(a.pid).toBe(projection.project('a', [process()])[0]!.pid);
    expect(a).toMatchObject({
      runtime: 'lifo',
      instanceId: 'a',
      scope: 'container',
      containerId: '.succinix-a',
      status: 'running',
      state: 'running',
    });
  });

  it('normalizes runtime adapters and interactive terminal ownership', () => {
    const projection = new LifoProcessProjection();
    const view = projection.project('default', [process({ pid: 3, command: 'wasi-run', args: ['wasi-run', 'module.wasm'] })], 'term-1')[0]!;
    expect(view).toMatchObject({ runtime: 'wasi', interactive: true, terminalSessionId: 'term-1' });
    expect(lifoProcessRuntime('node')).toBe('node');
    expect(lifoProcessRuntime('python3')).toBe('python');
    expect(lifoProcessRuntime('ruby')).toBe('ruby');
  });

  it('drops mappings after a process leaves the Lifo registry', () => {
    const projection = new LifoProcessProjection();
    const view = projection.project('a', [process()])[0]!;
    expect(projection.resolve(view.pid)).toEqual({ instanceId: 'a', localPid: 2 });
    projection.project('a', []);
    expect(projection.resolve(view.pid)).toBeUndefined();
  });
});
