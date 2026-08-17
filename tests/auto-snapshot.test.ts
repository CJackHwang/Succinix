import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAutoSnapshot } from '../src/app/auto-snapshot.js';

const SAVED = { meta: { version: 1 as const, savedAt: 1, fileCount: 1, totalBytes: 1 }, skipped: false, reason: 'changed' as const };

afterEach(() => {
  vi.useRealTimers();
});

function dirtyPersist() {
  let notify: (() => void) | undefined;
  const save = vi.fn(async () => SAVED);
  return {
    persist: {
      save,
      onDirty(listener: () => void) {
        notify = listener;
        return () => { notify = undefined; };
      },
    },
    save,
    dirty: () => notify?.(),
  };
}

describe('dirty snapshot scheduling', () => {
  it('flushes five seconds after the final execution-world mutation', async () => {
    vi.useFakeTimers();
    const fixture = dirtyPersist();
    const fs = {} as never;
    const controller = startAutoSnapshot(fs, fixture.persist);

    fixture.dirty();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fixture.save).not.toHaveBeenCalled();
    fixture.dirty();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fixture.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.save).toHaveBeenCalledTimes(1);
    expect(fixture.save).toHaveBeenLastCalledWith(fs, true);
    controller.stop();
  });

  it('forces a snapshot after thirty seconds of continuous mutations', async () => {
    vi.useFakeTimers();
    const fixture = dirtyPersist();
    const controller = startAutoSnapshot({} as never, fixture.persist);

    for (let elapsed = 0; elapsed < 30_000; elapsed += 4_000) {
      fixture.dirty();
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(fixture.save).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('does not save after the controller is stopped', async () => {
    vi.useFakeTimers();
    const fixture = dirtyPersist();
    const controller = startAutoSnapshot({} as never, fixture.persist);

    fixture.dirty();
    controller.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.save).not.toHaveBeenCalled();
  });
});
