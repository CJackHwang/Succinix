import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { Sandbox, VFS } from '@lifo-sh/core';
import {
  SERVICE_ENABLEMENT_ROOT,
  createSystemctlCommand,
  decodeServiceCommand,
  installServiceTemplates,
  serviceEnablementMarker,
  serviceExecStart,
} from '../src/engine/host/service-world.js';
import { registerRealBinaryCommands } from '../src/engine/host/real-binaries.js';
import { createServiceCommandBridge } from '../src/engine/host/service-command-bridge.js';
import { TerminalBackpressureError } from '../src/terminal/transport-protocol.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

function context(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    ctx: {
      args,
      stdout: { write: (value: string) => void stdout.push(value) },
      stderr: { write: (value: string) => void stderr.push(value) },
    },
    stdout,
    stderr,
  };
}

function contextWithVfs(args: string[]) {
  const result = context(args);
  return { ...result, vfs: new VFS() };
}

describe('execution-world service bridge', () => {
  it('preserves quoted service commands through the Lifo runner', () => {
    const command = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(4822)"`;
    const rendered = serviceExecStart(command);
    expect(rendered.value).toMatch(/^succinix-service-run [A-Za-z0-9_-]+$/);
    expect(decodeServiceCommand(rendered.value.split(' ')[1]!)).toBe(command);
  });

  it('keeps a complex service active in the real Lifo manager', async () => {
    const sandbox = await Sandbox.create({ cwd: '/workspace', env: { HOME: '/home/guest' } });
    try {
      registerRealBinaryCommands(sandbox as never, 'service-test');
      const command = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(0)"`;
      const rendered = serviceExecStart(command);
      sandbox.kernel.vfs.writeFile('/etc/systemd/system/service-test.service', [
        '[Service]', `ExecStart=${rendered.value}`, ...(rendered.original ? [`# SuccinixCommand=${Buffer.from(rendered.original).toString('base64url')}`] : []),
        'WorkingDirectory=/workspace', '',
      ].join('\n'));
      sandbox.kernel.serviceManager?.daemonReload();
      const started = await sandbox.kernel.serviceManager?.start('service-test');
      expect(started?.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sandbox.kernel.serviceManager?.status('service-test').active).toBe('active');
      await sandbox.kernel.serviceManager?.stop('service-test');

      sandbox.commands.register('systemctl', createServiceCommandBridge(sandbox.kernel.serviceManager, 'service-test'));
      const bridged = await sandbox.commands.run('systemctl start service-test');
      expect(bridged.exitCode).toBe(0);
      expect(sandbox.kernel.serviceManager?.status('service-test').active).toBe('active');
      await sandbox.kernel.serviceManager?.stop('service-test');
    } finally {
      sandbox.destroy();
    }
  });

  it('does not accept a pre-restart preview record as service readiness', async () => {
    let observedNewReady = false;
    const manager = {
      restart: vi.fn(async () => {
        setTimeout(() => { observedNewReady = true; }, 40);
        return { ok: true, message: 'Restarted api' };
      }),
      status: vi.fn(() => ({ active: 'active' })),
    };
    const control = vi.fn(async (_action: string, _instanceId: string, options?: { args?: Record<string, unknown>; timeoutMs?: number }) => {
      if (options?.args?.mode === 'expect') return { generation: 7 };
      return {
        ports: [{
          port: 3001,
          url: 'https://api.preview',
          generation: observedNewReady ? 8 : 7,
        }],
      };
    });
    const command = createServiceCommandBridge(manager as never, 'default', control as never);
    const restart = contextWithVfs(['restart', 'api']);
    restart.vfs.mkdir('/etc/systemd/system', { recursive: true });
    restart.vfs.writeFile('/etc/systemd/system/api.service', 'ExecStart=node server.js --port 3001\n');

    expect(await command({ ...restart.ctx, vfs: restart.vfs } as never)).toBe(0);
    expect(control.mock.calls.filter(([, , options]) => options?.args?.mode === 'expect')).toHaveLength(1);
    expect(control.mock.calls.filter(([, , options]) => options?.args === undefined)).toHaveLength(2);
  });

  it('gives the browser port control bridge enough time to register ownership', async () => {
    const manager = {
      start: vi.fn(async () => ({ ok: true, message: 'Started api' })),
      status: vi.fn(() => ({ active: 'active' })),
    };
    const control = vi.fn(async (_action: string, _instanceId: string, options?: { args?: Record<string, unknown>; timeoutMs?: number }) => {
      if (options?.args?.mode === 'expect') return { generation: 2 };
      return { ports: [{ port: 3001, url: 'https://api.preview', generation: 3 }] };
    });
    const command = createServiceCommandBridge(manager as never, 'c-1', control as never);
    const start = contextWithVfs(['start', 'api']);
    start.vfs.mkdir('/etc/systemd/system', { recursive: true });
    start.vfs.writeFile('/etc/systemd/system/api.service', 'ExecStart=node server.js --port 3001\n');

    expect(await command({ ...start.ctx, vfs: start.vfs } as never)).toBe(0);
    expect(control.mock.calls.every(([, , options]) => options?.timeoutMs === 2_000)).toBe(true);
  });

  it('seeds official templates as Lifo unit files without overwriting custom units', () => {
    const vfs = new VFS();
    vfs.mkdir('/etc/systemd/system', { recursive: true });
    vfs.writeFile('/etc/systemd/system/vite.service', '[Unit]\nDescription=custom\n');
    installServiceTemplates(vfs, [
      { name: 'vite', runtime: 'node', command: 'npx vite --port ${PORT}', ports: [5173], description: 'Vite' },
      { name: 'worker', runtime: 'node', command: 'node worker.js', description: 'Worker' },
    ]);
    expect(vfs.readFileString('/etc/systemd/system/vite.service')).toContain('Description=custom');
    expect(vfs.readFileString('/etc/systemd/system/worker.service')).toContain('ExecStart=node worker.js');
  });

  it('seeds non-default service units with the instance working directory', () => {
    const vfs = new VFS();
    installServiceTemplates(vfs, [{ name: 'tinbase', runtime: 'node', command: 'npx tinbase start --data-dir .tinbase', ports: [3001], description: 'Tinbase' }], '/workspace/.succinix-c-1');
    expect(vfs.readFileString('/etc/systemd/system/tinbase.service')).toContain('WorkingDirectory=/workspace/.succinix-c-1');
  });

  it('renders an ASCII systemctl surface over the shared manager', async () => {
    const manager = {
      start: vi.fn(async () => ({ ok: true, message: 'Started worker' })),
      stop: vi.fn(async () => ({ ok: true, message: 'Stopped worker' })),
      restart: vi.fn(async () => ({ ok: true, message: 'Restarted worker' })),
      status: vi.fn(() => ({ name: 'worker', description: 'Worker', loaded: true, active: 'active', sub: 'running', enabled: false, pid: 42, startedAt: 1, exitCode: null })),
      enable: vi.fn(() => ({ ok: true, message: 'enabled' })),
      disable: vi.fn(() => ({ ok: true, message: 'disabled' })),
      listUnits: vi.fn(() => []),
      daemonReload: vi.fn(),
    };
    const command = createSystemctlCommand(manager as never);
    const started = context(['start', 'worker']);
    expect(await command(started.ctx as never)).toBe(0);
    expect(started.stdout.join('')).toContain('Started worker');
    const status = context(['status', 'worker']);
    expect(await command(status.ctx as never)).toBe(0);
    expect(status.stdout.join('')).toContain('Main PID: 42');
    const list = context(['list-units']);
    expect(await command(list.ctx as never)).toBe(0);
    expect(list.stdout.join('')).toContain('No units found.');
    expect(status.stdout.join('')).not.toMatch(/[●✅❌]/u);
  });

  it('covers help, validation, populated listing, status, and enablement command paths', async () => {
    const unavailable = context(['start', 'api']);
    expect(await createSystemctlCommand(null)(unavailable.ctx as never)).toBe(1);
    expect(unavailable.stderr.join('')).toContain('service manager unavailable');

    const enablement = vi.fn(async (_name: string, _enabled: boolean) => {});
    const manager = {
      status: vi.fn(() => ({ name: 'api', description: '', loaded: false, active: 'failed', sub: 'failed', enabled: false, pid: null, startedAt: null, exitCode: 2 })),
      enable: vi.fn(() => ({ ok: true, message: 'enabled api' })),
      disable: vi.fn(() => ({ ok: true, message: 'disabled api' })),
      listUnits: vi.fn(() => [{ name: 'api', description: 'API', loaded: true, active: 'active', sub: 'running', enabled: true, pid: null, startedAt: 1, exitCode: null }]),
      daemonReload: vi.fn(),
    };
    const command = createSystemctlCommand(manager as never, { onEnablementChange: enablement });

    const usage = context([]);
    expect(await command(usage.ctx as never)).toBe(1);
    expect(usage.stdout.join('')).toContain('Usage: systemctl');
    const help = context(['--help']);
    expect(await command(help.ctx as never)).toBe(0);
    const list = context(['list-units']);
    expect(await command(list.ctx as never)).toBe(0);
    expect(list.stdout.join('')).toContain('1 unit(s) listed.');
    const status = context(['status', 'api']);
    expect(await command(status.ctx as never)).toBe(0);
    expect(status.stdout.join('')).toContain('Exit code: 2');
    const enabled = context(['enable', 'api.service']);
    expect(await command(enabled.ctx as never)).toBe(0);
    const disabled = context(['disable', 'api']);
    expect(await command(disabled.ctx as never)).toBe(0);
    expect(enablement.mock.calls.map(([name, state]) => [name, state])).toEqual([['api', true], ['api', false]]);
    const missing = context(['start']);
    expect(await command(missing.ctx as never)).toBe(1);
    const unknown = context(['reload']);
    expect(await command(unknown.ctx as never)).toBe(1);
  });

  it('rejects invalid additions, returns a missing inspection, and removes active units after cleanup', async () => {
    const manager = {
      status: vi.fn(() => ({ name: 'api', description: 'API', loaded: true, active: 'active', sub: 'running', enabled: true, pid: null, startedAt: 1, exitCode: null })),
      stop: vi.fn(async () => ({ ok: true, message: 'Stopped api' })),
      disable: vi.fn(() => ({ ok: true, message: 'disabled api' })),
      daemonReload: vi.fn(),
      listUnits: vi.fn(() => []),
    };
    const afterStop = vi.fn(async () => {});
    const changed = vi.fn(async () => {});
    const command = createSystemctlCommand(manager as never, { afterStop, onEnablementChange: changed });

    const invalid = contextWithVfs(['add', 'not-base64']);
    expect(await command({ ...invalid.ctx, vfs: invalid.vfs } as never)).toBe(1);
    const missing = contextWithVfs(['inspect', 'missing']);
    expect(await command({ ...missing.ctx, vfs: missing.vfs } as never)).toBe(3);
    expect(missing.stdout.join('')).toBe('null\n');

    const remove = contextWithVfs(['remove', 'api']);
    remove.vfs.mkdir('/etc/systemd/system', { recursive: true });
    remove.vfs.writeFile('/etc/systemd/system/api.service', 'ExecStart=node api.js\n');
    expect(await command({ ...remove.ctx, vfs: remove.vfs } as never)).toBe(0);
    expect(remove.vfs.exists('/etc/systemd/system/api.service')).toBe(false);
    expect(manager.stop).toHaveBeenCalledWith('api');
    expect(afterStop).toHaveBeenCalledWith('api', expect.anything());
    expect(changed).toHaveBeenCalledWith('api', false, expect.anything());
  });

  it('projects service PIDs into the public ps namespace', async () => {
    const manager = {
      status: vi.fn((name: string) => ({ name, description: 'Worker', loaded: true, active: 'active', sub: 'running', enabled: false, pid: 42, startedAt: 1, exitCode: null })),
      listUnits: vi.fn(() => []),
    };
    const command = createSystemctlCommand(manager as never, { projectPid: (pid) => pid + 1_000_000_000 });
    const status = context(['status', 'worker']);
    expect(await command(status.ctx as never)).toBe(0);
    expect(status.stdout.join('')).toContain('Main PID: 1000000042');

    const inspect = contextWithVfs(['inspect']);
    inspect.vfs.mkdir('/etc/systemd/system', { recursive: true });
    inspect.vfs.writeFile('/etc/systemd/system/worker.service', 'ExecStart=node worker.js\n');
    expect(await command({ ...inspect.ctx, vfs: inspect.vfs } as never)).toBe(0);
    expect(JSON.parse(inspect.stdout.join(''))).toEqual([
      expect.objectContaining({ name: 'worker', pid: 1_000_000_042 }),
    ]);
  });

  it('keeps enablement markers inside the instance-mounted /etc state tree', () => {
    expect(SERVICE_ENABLEMENT_ROOT).toBe('/etc/succinix/service-state');
    expect(serviceEnablementMarker('api')).toBe('/etc/succinix/service-state/api.enabled');
  });

  it('waits for enablement snapshots to finish before returning', async () => {
    const control = vi.fn(async () => ({ saved: true }));
    const manager = {
      status: vi.fn(() => ({ name: 'api', description: 'API', loaded: true, active: 'inactive', sub: 'dead', enabled: false, pid: null, startedAt: null, exitCode: null })),
      enable: vi.fn(() => ({ ok: true, message: 'enabled api' })),
      daemonReload: vi.fn(),
    };
    const command = createServiceCommandBridge(manager as never, 'default', control as never);
    const result = contextWithVfs(['enable', 'api']);
    result.vfs.mkdir('/etc/systemd/system', { recursive: true });
    result.vfs.writeFile('/etc/systemd/system/api.service', 'ExecStart=node api.js\n');

    expect(await command({ ...result.ctx, vfs: result.vfs } as never)).toBe(0);
    expect(result.vfs.readFileString(serviceEnablementMarker('api'))).toBe('enabled\n');
    expect(control).toHaveBeenCalledWith('snapshot', 'default', expect.objectContaining({
      timeoutMs: 30_000,
      args: { mode: 'save' },
    }));
  });

  it.each([
    ['beforeStart throws', 'start', 'throw-before'],
    ['manager start fails', 'start', 'result-failure'],
    ['readiness times out', 'start', 'ready-failure'],
    ['manager restart fails', 'restart', 'result-failure'],
  ] as const)('cleans port ownership after %s', async (_label, operation, failure) => {
    const manager = {
      start: vi.fn(async () => failure === 'result-failure' ? { ok: false, message: 'start failed' } : { ok: true, message: 'started' }),
      restart: vi.fn(async () => failure === 'result-failure' ? { ok: false, message: 'restart failed' } : { ok: true, message: 'restarted' }),
      stop: vi.fn(async () => ({ ok: true, message: 'stopped' })),
      status: vi.fn(() => ({ active: 'active' })),
    };
    const afterStop = vi.fn(async () => {});
    const command = createSystemctlCommand(manager as never, {
      beforeStart: failure === 'throw-before' ? vi.fn(async () => { throw new Error('port reservation failed'); }) : vi.fn(async () => {}),
      waitForReady: failure === 'ready-failure' ? vi.fn(async () => false) : vi.fn(async () => true),
      afterStop,
    });
    const result = context([operation, 'api']);

    expect(await command(result.ctx as never)).toBe(1);
    expect(afterStop).toHaveBeenCalledWith('api', result.ctx);
    if (failure === 'throw-before') expect(manager.stop).not.toHaveBeenCalled();
    else expect(manager.stop).toHaveBeenCalledWith('api');
  });

  it.each([
    ['returns a failure', vi.fn(async () => ({ ok: false, message: 'stop failed' }))],
    ['throws', vi.fn(async () => { throw new Error('stop crashed'); })],
  ])('releases port ownership when systemctl stop %s', async (_label, stop) => {
    const manager = { stop };
    const afterStop = vi.fn(async () => {});
    const command = createSystemctlCommand(manager as never, { afterStop });
    const result = context(['stop', 'api']);

    expect(await command(result.ctx as never)).toBe(1);
    expect(afterStop).toHaveBeenCalledWith('api', result.ctx);
  });

  it('terminates a timed-out service package install through the shared process policy', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, {
        pid: 3009,
        kill: vi.fn((signal: string) => {
          if (signal === 'SIGKILL') child.emit('close', null);
          return true;
        }),
      });
      spawnMock.mockImplementationOnce(() => child);
      const manager = {
        start: vi.fn(async () => ({ ok: true, message: 'started' })),
        stop: vi.fn(async () => ({ ok: true, message: 'stopped' })),
      };
      const command = createServiceCommandBridge(manager as never, 'install-timeout', vi.fn() as never);
      const result = contextWithVfs(['start', 'api']);
      result.vfs.mkdir('/etc/systemd/system', { recursive: true });
      result.vfs.writeFile('/etc/systemd/system/api.service', 'ExecStart=npx succinix-missing-package-for-timeout-test\n');

      const pending = command({ ...result.ctx, vfs: result.vfs } as never);
      await vi.advanceTimersByTimeAsync(120000);
      expect(await pending).toBe(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(2001);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('escalates a cancelled Lifo real-binary command through the shared process policy', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, {
        pid: 3010,
        kill: vi.fn((signal: string) => {
          if (signal === 'SIGKILL') child.emit('close', null);
          return true;
        }),
      });
      spawnMock.mockImplementationOnce(() => child);
      const commands = new Map<string, (ctx: Record<string, unknown>) => Promise<number>>();
      registerRealBinaryCommands({
        commands: { register: (name: string, handler: (ctx: Record<string, unknown>) => Promise<number>) => { commands.set(name, handler); } },
        kernel: { vfs: new VFS(), serviceManager: null },
      } as never, 'abort-test');
      const abort = new AbortController();
      const run = commands.get('node')!({
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: '/workspace',
        signal: abort.signal,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });

      abort.abort();
      expect(child.kill).toHaveBeenCalledWith('SIGINT');
      await vi.advanceTimersByTimeAsync(2001);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(await run).toBe(-1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns terminal output backpressure into a completed real-binary command', async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { pid: 3011, stdout, stderr, kill: vi.fn(() => true) });
    spawnMock.mockImplementationOnce(() => child);
    const commands = new Map<string, (ctx: Record<string, unknown>) => Promise<number>>();
    registerRealBinaryCommands({
      commands: { register: (name: string, handler: (ctx: Record<string, unknown>) => Promise<number>) => { commands.set(name, handler); } },
      kernel: { vfs: new VFS(), serviceManager: null },
    } as never, 'backpressure-test');
    const run = commands.get('node')!({
      args: ['-e', 'console.log("large")'],
      cwd: '/workspace',
      stdout: { write: () => { throw new TerminalBackpressureError(1_200_000, 1_048_000); } },
      stderr: { write: () => {} },
    });

    stdout.emit('data', Buffer.from('large'));
    child.emit('close', 0);
    expect(await run).toBe(0);
  });

  it('keeps SDK service definitions and inspection inside Lifo units', async () => {
    const manager = {
      start: vi.fn(async () => ({ ok: true, message: 'Started api' })),
      stop: vi.fn(async () => ({ ok: true, message: 'Stopped api' })),
      restart: vi.fn(async () => ({ ok: true, message: 'Restarted api' })),
      status: vi.fn((name: string) => ({ name, description: 'API', loaded: true, active: 'inactive', sub: 'dead', enabled: false, pid: null, startedAt: null, exitCode: null })),
      enable: vi.fn(() => ({ ok: true, message: 'enabled' })),
      disable: vi.fn(() => ({ ok: true, message: 'disabled' })),
      listUnits: vi.fn(() => [{ name: 'api', description: 'API', loaded: true, active: 'inactive', sub: 'dead', enabled: false, pid: null, startedAt: null, exitCode: null }]),
      daemonReload: vi.fn(),
    };
    const command = createSystemctlCommand(manager as never);
    const add = contextWithVfs(['add', Buffer.from(JSON.stringify({ name: 'api', command: 'node server.js', port: 4321 })).toString('base64url')]);
    expect(await command({ ...add.ctx, vfs: add.vfs } as never)).toBe(0);
    expect(add.vfs.readFileString('/etc/systemd/system/api.service')).toContain('ExecStart=node server.js');

    const inspect = contextWithVfs(['inspect']);
    inspect.vfs.mkdir('/etc/systemd/system', { recursive: true });
    inspect.vfs.writeFile('/etc/systemd/system/api.service', add.vfs.readFileString('/etc/systemd/system/api.service'));
    expect(await command({ ...inspect.ctx, vfs: inspect.vfs } as never)).toBe(0);
    expect(JSON.parse(inspect.stdout.join(''))).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'api', command: 'node server.js', port: 4321 }),
    ]));
    expect(manager.daemonReload).toHaveBeenCalled();
  });
});
