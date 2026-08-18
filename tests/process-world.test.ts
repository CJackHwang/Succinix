import { describe, expect, it, vi } from 'vitest';
import { LifoProcessProjection, lifoProcessRuntime } from '../src/engine/host/process-world.js';
import { killProjectedLifoProcess, listProjectedLifoProcesses } from '../src/engine/host/process-commands.js';

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
    const view = projection.project('default', [process({ pid: 3, command: 'wasi-run', args: ['wasi-run', 'module.wasm'], isForeground: true })], 'term-1')[0]!;
    expect(view).toMatchObject({ runtime: 'wasi', interactive: true, terminalSessionId: 'term-1' });
    expect(lifoProcessRuntime('node')).toBe('node');
    expect(lifoProcessRuntime('python3')).toBe('python');
    expect(lifoProcessRuntime('ruby')).toBe('ruby');
  });

  it('marks only the foreground process interactive when an instance has a terminal session', () => {
    const projection = new LifoProcessProjection();
    const [foreground, batch, background] = projection.project('default', [
      process({ pid: 3, isForeground: true }),
      process({ pid: 4, isForeground: false, command: 'find', args: ['find', '.'] }),
      process({ pid: 5, isForeground: false, command: 'sleep', args: ['sleep', '60'] }),
    ], 'term-1');

    expect(foreground).toMatchObject({ interactive: true, terminalSessionId: 'term-1' });
    expect(batch).toMatchObject({ interactive: false });
    expect(batch?.terminalSessionId).toBeUndefined();
    expect(background).toMatchObject({ interactive: false });
    expect(background?.terminalSessionId).toBeUndefined();
  });

  it('drops mappings after a process leaves the Lifo registry', () => {
    const projection = new LifoProcessProjection();
    const view = projection.project('a', [process()])[0]!;
    expect(projection.resolve(view.pid)).toEqual({ kind: 'process', instanceId: 'a', localPid: 2 });
    projection.project('a', []);
    expect(projection.resolve(view.pid)).toBeUndefined();
  });

  it('projects ServiceManager PIDs into ps and stops the same public PID', async () => {
    const projection = new LifoProcessProjection();
    const stop = vi.fn(async () => ({ ok: true, message: '' }));
    const serviceManager = {
      listUnits: () => [{ name: 'api', pid: 42, startedAt: 123, active: 'active' as const }],
      status: () => ({ pid: 42, active: 'active' as const }),
      stop,
    };
    const contexts = new Map([['svc-instance', Promise.resolve({
      sandbox: {
        kernel: {
          processRegistry: { getAll: () => [], get: () => undefined, kill: () => false },
          serviceManager,
          vfs: { exists: () => true, readFileString: () => 'ExecStart=node api.js\n' },
        },
      },
    })]]);

    const publicPid = projection.projectServicePid('svc-instance', 'api', 42)!;
    const processes = await listProjectedLifoProcesses(contexts as never, projection, 'svc-instance', false);

    expect(processes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: publicPid, cmd: 'node api.js', instanceId: 'svc-instance', status: 'running' }),
    ]));
    expect(projection.resolve(publicPid)).toEqual({ kind: 'service', instanceId: 'svc-instance', localPid: 42, name: 'api' });
    expect(await killProjectedLifoProcess(contexts as never, projection, publicPid)).toEqual({
      killed: true,
      message: `SIGTERM sent to service ${publicPid}`,
    });
    expect(stop).toHaveBeenCalledWith('api');
  });
});
