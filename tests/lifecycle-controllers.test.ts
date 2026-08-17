import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAutoSnapshot } from '../src/app/auto-snapshot.js';
import { startHostWatchdog } from '../src/app/watchdog.js';

const watchdogOutput = vi.hoisted(() => ({ writeln: vi.fn() }));

vi.mock('../src/app/xterm.js', () => ({ getTerm: () => watchdogOutput }));
vi.mock('../src/log.js', () => ({ log: vi.fn() }));

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: (() => void) | undefined;
  return {
    promise: new Promise<void>((done) => { resolve = done; }),
    resolve: () => resolve?.(),
  };
}

describe('lifecycle controllers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces dirty snapshots', async () => {
    let notifyDirty: (() => void) | undefined;
    const save = vi.fn(async () => ({
      meta: { version: 1 as const, savedAt: Date.now(), fileCount: 0, totalBytes: 0 },
      skipped: false,
      reason: 'changed' as const,
    }));
    const controller = startAutoSnapshot({} as never, {
      save,
      onDirty: (listener) => {
        notifyDirty = listener;
        return () => { notifyDirty = undefined; };
      },
    });

    notifyDirty?.();
    await vi.advanceTimersByTimeAsync(4999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('forces a save after 30 seconds of continuous dirty notifications', async () => {
    let notifyDirty: (() => void) | undefined;
    const save = vi.fn(async () => ({
      meta: { version: 1 as const, savedAt: Date.now(), fileCount: 0, totalBytes: 0 },
      skipped: false,
      reason: 'changed' as const,
    }));
    const controller = startAutoSnapshot({} as never, {
      save,
      onDirty: (listener) => {
        notifyDirty = listener;
        return () => { notifyDirty = undefined; };
      },
    });

    notifyDirty?.();
    for (let index = 0; index < 7; index += 1) {
      await vi.advanceTimersByTimeAsync(4000);
      notifyDirty?.();
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('stops probing after the watchdog controller is released', async () => {
    const executor = { pingDirect: vi.fn(async () => true) };
    const controller = startHostWatchdog(executor as never, {} as never);

    await vi.advanceTimersByTimeAsync(30000);
    expect(executor.pingDirect).toHaveBeenCalledTimes(1);
    expect(controller.running()).toBe(true);
    controller.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(executor.pingDirect).toHaveBeenCalledTimes(1);
    expect(controller.running()).toBe(false);
  });

  it('does not renew the terminal nonce after a stopped in-flight restart completes', async () => {
    const respawn = deferred();
    const executor = { respawn: vi.fn(() => respawn.promise) };
    const renewBootNonce = vi.fn(async () => {});
    const wc = {
      fs: {
        readFile: vi.fn(async () => new Uint8Array()),
        writeFile: vi.fn(async () => {}),
      },
    };
    const controller = startHostWatchdog(executor as never, wc as never, renewBootNonce);

    const restart = controller.restartNow();
    await vi.waitFor(() => expect(executor.respawn).toHaveBeenCalledTimes(1));
    controller.stop();
    respawn.resolve();
    await restart;

    expect(renewBootNonce).not.toHaveBeenCalled();
  });

  it('retries a failed restart with exponential backoff while still active', async () => {
    const executor = {
      respawn: vi.fn()
        .mockRejectedValueOnce(new Error('first restart failed'))
        .mockResolvedValueOnce(undefined),
    };
    const wc = {
      fs: {
        readFile: vi.fn(async () => new Uint8Array()),
        writeFile: vi.fn(async () => {}),
      },
    };
    const controller = startHostWatchdog(executor as never, wc as never);

    await controller.restartNow();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(executor.respawn).toHaveBeenCalledTimes(2);
    controller.stop();
  });
});
