import { describe, expect, it, vi } from 'vitest';
import { waitForHostReady, type TerminalClient } from '../src/engine/index.js';

describe('host ready probe', () => {
  it('returns after the first pong with the deadline overload', async () => {
    const exec = vi.fn().mockResolvedValue({ kind: 'pong' });
    const client = { exec } as unknown as TerminalClient;

    await expect(waitForHostReady(client, { deadlineMs: 50 })).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledWith('ping', undefined, expect.any(Number));
  });

  it('does not let per-ping timeouts extend the configured deadline', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('not ready'));
    const client = { exec } as unknown as TerminalClient;
    const startedAt = Date.now();

    await expect(waitForHostReady(client, { deadlineMs: 20 })).rejects.toThrow('host did not respond');

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(exec.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
