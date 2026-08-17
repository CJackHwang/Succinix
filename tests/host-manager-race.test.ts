import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';

const engineApi = vi.hoisted(() => ({
  bootEngineHost: vi.fn(),
  waitForHostReady: vi.fn(),
}));

vi.mock('../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/index.js')>();
  return {
    ...actual,
    bootEngineHost: engineApi.bootEngineHost,
    waitForHostReady: engineApi.waitForHostReady,
  };
});

import { HostManager, type HostManagerBootOptions } from '../src/plugin/host-manager.js';

const OPTIONS: HostManagerBootOptions = {
  mode: 'internal',
  bootRetries: 1,
  bootIntervalMs: 0,
  hostReadyDeadlineMs: 500,
  hostJsUrl: '/host.js',
  lifoCoreUrl: '/lifo-core.js',
};

function fakeWebContainer(): WebContainer {
  return { spawn: vi.fn() } as unknown as WebContainer;
}

function fakeProcess(): WebContainerProcess {
  return { kill: vi.fn() } as unknown as WebContainerProcess;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: (() => void) | undefined;
  return {
    promise: new Promise<void>((done) => { resolve = done; }),
    resolve: () => resolve?.(),
  };
}

describe('HostManager ready-probe lifecycle races', () => {
  beforeEach(() => {
    engineApi.bootEngineHost.mockReset();
    engineApi.waitForHostReady.mockReset();
  });

  it('does not restore ready after shutdown while the ready probe is pending', async () => {
    const manager = new HostManager();
    const wc = fakeWebContainer();
    const host = fakeProcess();
    const ready = deferred();
    engineApi.bootEngineHost.mockResolvedValue(host);
    engineApi.waitForHostReady.mockReturnValue(ready.promise);

    const boot = manager.boot(wc, OPTIONS);
    await vi.waitFor(() => expect(engineApi.waitForHostReady).toHaveBeenCalledTimes(1));
    manager.shutdownSync();
    ready.resolve();

    await expect(boot).rejects.toThrow('superseded');
    expect(host.kill).toHaveBeenCalled();
    expect(manager.handle()).toMatchObject({ state: 'disposed', wc: null, startedAt: null });
  });

  it('keeps a replacement host when an old ready probe resolves late', async () => {
    const manager = new HostManager();
    const wc = fakeWebContainer();
    const firstHost = fakeProcess();
    const secondHost = fakeProcess();
    const firstReady = deferred();
    engineApi.bootEngineHost.mockResolvedValueOnce(firstHost).mockResolvedValueOnce(secondHost);
    engineApi.waitForHostReady.mockReturnValueOnce(firstReady.promise).mockResolvedValueOnce(undefined);

    const firstBoot = manager.boot(wc, OPTIONS);
    await vi.waitFor(() => expect(engineApi.waitForHostReady).toHaveBeenCalledTimes(1));
    manager.shutdownSync();

    await manager.boot(wc, OPTIONS);
    firstReady.resolve();

    await expect(firstBoot).rejects.toThrow('superseded');
    expect(manager.handle()).toMatchObject({ state: 'ready', wc });
    expect(manager.getHostProc()).toBe(secondHost);
    expect(secondHost.kill).not.toHaveBeenCalled();
  });
});
