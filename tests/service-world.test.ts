import { describe, expect, it, vi } from 'vitest';
import { Sandbox, VFS } from '@lifo-sh/core';
import { createSystemctlCommand, decodeServiceCommand, installServiceTemplates, serviceExecStart } from '../src/engine/host/service-world.js';
import { registerRealBinaryCommands } from '../src/engine/host/real-binaries.js';
import { createServiceCommandBridge } from '../src/engine/host/service-command-bridge.js';

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
