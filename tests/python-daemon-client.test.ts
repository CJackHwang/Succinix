import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

import { PythonDaemonClient } from '../src/engine/python-daemon-client.js';

describe('Python daemon process lifecycle', () => {
  it('escalates a timed-out daemon that ignores SIGTERM', async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, {
        pid: 3011,
        stdout,
        stderr: new PassThrough(),
        stdin: { write: vi.fn() },
        kill: vi.fn((signal: string) => {
          if (signal === 'SIGKILL') {
            child.emit('exit', null);
            child.emit('close', null);
          }
          return true;
        }),
      });
      spawnMock.mockImplementationOnce(() => child);
      const daemon = new PythonDaemonClient();
      const command = daemon.exec(['-c', 'while True: pass'], '/workspace', 10);
      stdout.write('{"ready":true}\n');
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(11);
      await expect(command).resolves.toMatchObject({ exitCode: -1, stderr: expect.stringContaining('timed out') });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(2001);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});
