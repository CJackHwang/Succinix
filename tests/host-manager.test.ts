import { describe, expect, it, vi } from 'vitest';

const sleepApi = vi.hoisted(() => ({ sleep: vi.fn() }));

vi.mock('../src/engine/sleep.js', () => ({ sleep: sleepApi.sleep }));

import { HostManager, type HostManagerBootOptions } from '../src/plugin/host-manager.js';
import { FakeWebContainer, asWebContainer } from './helpers/fake-webcontainer.js';

const OPTIONS: HostManagerBootOptions = {
  mode: 'internal',
  bootRetries: 1,
  bootIntervalMs: 0,
  hostReadyDeadlineMs: 500,
  hostJsUrl: '/host.js',
  lifoCoreUrl: '/lifo-core.js',
  hostSrc: '// host',
  lifoCoreSrc: '// lifo',
};

describe('HostManager boot lifecycle', () => {
  it('coalesces concurrent boots for the same WebContainer', async () => {
    const manager = new HostManager();
    const wc = new FakeWebContainer();

    await Promise.all([
      manager.boot(asWebContainer(wc), OPTIONS),
      manager.boot(asWebContainer(wc), OPTIONS),
    ]);

    expect(wc.spawn).toHaveBeenCalledTimes(1);
    expect(manager.handle()).toMatchObject({ state: 'ready', wc: asWebContainer(wc) });
  });

  it('coalesces concurrent attaches for the same WebContainer', async () => {
    const manager = new HostManager();
    const wc = new FakeWebContainer();

    await Promise.all([
      manager.attach(asWebContainer(wc), OPTIONS),
      manager.attach(asWebContainer(wc), OPTIONS),
    ]);

    expect(wc.spawn).toHaveBeenCalledTimes(1);
    expect(manager.handle()).toMatchObject({ mode: 'external', state: 'ready', wc: asWebContainer(wc) });
  });

  it('kills a late boot and leaves shutdown state intact', async () => {
    const manager = new HostManager();
    const wc = new FakeWebContainer();
    let releaseSpawn: ((value: typeof wc.hostProc) => void) | undefined;
    wc.spawn.mockImplementationOnce(() => new Promise((resolve) => { releaseSpawn = resolve; }));

    const boot = manager.boot(asWebContainer(wc), OPTIONS);
    await vi.waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(1));
    manager.shutdownSync();
    releaseSpawn?.(wc.hostProc);

    await expect(boot).rejects.toThrow('superseded');
    expect(wc.hostProc.kill).toHaveBeenCalledTimes(1);
    expect(manager.handle()).toMatchObject({ state: 'disposed', wc: null, startedAt: null });
  });

  it('fails fast on a mode mismatch while the first boot is in flight', async () => {
    const manager = new HostManager();
    const wc = new FakeWebContainer();
    let releaseSpawn: ((value: typeof wc.hostProc) => void) | undefined;
    wc.spawn.mockImplementationOnce(() => new Promise((resolve) => { releaseSpawn = resolve; }));

    const boot = manager.boot(asWebContainer(wc), OPTIONS);
    await vi.waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(1));

    await expect(manager.attach(asWebContainer(wc), OPTIONS)).rejects.toThrow('ERR_MODE_MISMATCH');
    expect(wc.spawn).toHaveBeenCalledTimes(1);

    manager.shutdownSync();
    releaseSpawn?.(wc.hostProc);
    await expect(boot).rejects.toThrow('superseded');
  });

  it('invalidates a late boot when resetForTests clears the manager', async () => {
    const manager = new HostManager();
    const wc = new FakeWebContainer();
    let releaseSpawn: ((value: typeof wc.hostProc) => void) | undefined;
    wc.spawn.mockImplementationOnce(() => new Promise((resolve) => { releaseSpawn = resolve; }));

    const boot = manager.boot(asWebContainer(wc), OPTIONS);
    await vi.waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(1));
    manager.resetForTests();
    releaseSpawn?.(wc.hostProc);

    await expect(boot).rejects.toThrow('superseded');
    expect(wc.hostProc.kill).toHaveBeenCalledTimes(1);
    expect(manager.handle()).toMatchObject({ state: 'unattached', wc: null, startedAt: null });
  });

  it('does not spawn a retry after shutdown invalidates the boot generation', async () => {
    const manager = new HostManager();
    const wc = new FakeWebContainer();
    wc.spawn.mockRejectedValueOnce(new Error('first spawn failed'));
    let releaseRetry: (() => void) | undefined;
    sleepApi.sleep.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseRetry = resolve; }));
    const options = { ...OPTIONS, bootRetries: 2, bootIntervalMs: 25 };

    const boot = manager.boot(asWebContainer(wc), options);
    await vi.waitFor(() => expect(sleepApi.sleep).toHaveBeenCalledTimes(1));
    manager.shutdownSync();
    releaseRetry?.();

    await expect(boot).rejects.toThrow('superseded');
    expect(wc.spawn).toHaveBeenCalledTimes(1);
    expect(manager.handle()).toMatchObject({ state: 'disposed', wc: null, startedAt: null });
  });

  it('waits for a ready host exit acknowledgement before killing it', async () => {
    const manager = new HostManager();
    const wc = new FakeWebContainer();
    let releaseExit: ((code: number) => void) | undefined;
    Object.assign(wc.hostProc, {
      exit: new Promise<number>((resolve) => { releaseExit = resolve; }),
    });
    await manager.boot(asWebContainer(wc), OPTIONS);

    const shuttingDown = manager.shutdown();
    await vi.waitFor(() => expect(wc.fs.requests.some((request) => request.cmd === 'exit')).toBe(true));
    expect(wc.hostProc.kill).not.toHaveBeenCalled();

    releaseExit?.(0);
    await shuttingDown;
    expect(wc.hostProc.kill).toHaveBeenCalledTimes(1);
    expect(manager.handle()).toMatchObject({ state: 'disposed', wc: null });
  });

  it('allows an external attach only after an awaited shutdown releases the old host', async () => {
    const manager = new HostManager();
    const wc = new FakeWebContainer();
    await manager.boot(asWebContainer(wc), OPTIONS);

    await manager.shutdown();
    await manager.attach(asWebContainer(wc), { ...OPTIONS, mode: 'external' });

    expect(wc.spawn).toHaveBeenCalledTimes(2);
    expect(manager.handle()).toMatchObject({ mode: 'external', state: 'ready', wc: asWebContainer(wc) });
  });
});
