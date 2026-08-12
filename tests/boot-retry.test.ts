// boot.ts 重试逻辑单元测试（TASK-BOOTGATE 审计 M3）：
// R3.1 WebContainer.boot 失败重试、R3.2 host 就绪失败重试、通用 withRetry 决策
// （attempts 上限 / 成功即停 / onRetry WARN 文案 "attempt N/3"）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 脚本化外部依赖：@webcontainer/api 的 WebContainer.boot、engine 的 waitForHostReady /
// bootEngineHost。vi.hoisted 保证 mock 工厂先于被测模块 import 求值。
const wcApi = vi.hoisted(() => ({ boot: vi.fn() }));
const engineApi = vi.hoisted(() => ({
  waitForHostReady: vi.fn(),
  bootEngineHost: vi.fn(),
}));

vi.mock('@webcontainer/api', () => ({ WebContainer: { boot: wcApi.boot } }));

vi.mock('../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/index.js')>();
  return { ...actual, waitForHostReady: engineApi.waitForHostReady, bootEngineHost: engineApi.bootEngineHost };
});

import type { BootUI } from '../src/boot-ui.js';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { bootWebContainerWithRetry, withRetry, type EngineBootHooks, type TerminalClient } from '@succinix/engine';
import { waitForHostReadyWithRetry } from '../src/boot-steps.js';

function makeUI(logs: string[]): BootUI {
  return {
    log: (text: string) => void logs.push(text),
    systemInfo: () => {},
    complete: async () => {},
    fail: () => {},
  };
}

describe('withRetry（R3 重试决策纯逻辑）', () => {
  it('N=3 三次全败：抛最后一次错误，onRetry 仅对未达上限的失败触发（1、2）', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'));
    const retried: number[] = [];
    await expect(withRetry(fn, 3, { onRetry: (attempt) => void retried.push(attempt) })).rejects.toThrow('third');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(retried).toEqual([1, 2]);
  });

  it('第 2 次成功则停止重试，返回成功值', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
    const retried: number[] = [];
    await expect(withRetry(fn, 3, { onRetry: (attempt) => void retried.push(attempt) })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(retried).toEqual([1]);
  });

  it('beforeRetry 在每次重试前调用（R3.2 respawn 换源点）', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('v');
    const beforeRetry = vi.fn();
    await withRetry(fn, 3, { beforeRetry });
    expect(beforeRetry).toHaveBeenCalledTimes(1);
  });

  it('首次成功不触发任何重试回调', async () => {
    const fn = vi.fn().mockResolvedValueOnce('ok');
    const retried = vi.fn();
    const beforeRetry = vi.fn();
    await withRetry(fn, 3, { onRetry: retried, beforeRetry });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(retried).not.toHaveBeenCalled();
    expect(beforeRetry).not.toHaveBeenCalled();
  });
});

describe('R3.1 WebContainer.boot 失败重试', () => {
  beforeEach(() => {
    wcApi.boot.mockReset();
  });

  it('N=3 三次全败：返回 wc=null，WARN 含 attempt 1/3 与 2/3', async () => {
    wcApi.boot.mockRejectedValue(new Error('wc down'));
    const logs: string[] = [];
    const { wc, error } = await bootWebContainerWithRetry(makeUI(logs), { backoffMs: 0 });
    expect(wc).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect(wcApi.boot).toHaveBeenCalledTimes(3);
    expect(logs).toEqual([
      '[ WARN ] WebContainer boot failed (attempt 1/3), retrying...',
      '[ WARN ] WebContainer boot failed (attempt 2/3), retrying...',
    ]);
  });

  it('第 2 次成功则停止重试：返回 wc，仅一条 WARN', async () => {
    const fakeWc = { name: 'wc' } as unknown as WebContainer;
    wcApi.boot.mockRejectedValueOnce(new Error('first down')).mockResolvedValueOnce(fakeWc);
    const logs: string[] = [];
    const { wc, error } = await bootWebContainerWithRetry(makeUI(logs), { backoffMs: 0 });
    expect(wc).toBe(fakeWc);
    expect(error).toBeNull();
    expect(wcApi.boot).toHaveBeenCalledTimes(2);
    expect(logs).toEqual(['[ WARN ] WebContainer boot failed (attempt 1/3), retrying...']);
  });
});

describe('R3.2 host 就绪失败重试（waitForHostReadyWithRetry）', () => {
  beforeEach(() => {
    engineApi.waitForHostReady.mockReset();
    engineApi.bootEngineHost.mockReset();
  });

  function fakeProc(id: string): WebContainerProcess {
    return { pid: id, kill: vi.fn() } as unknown as WebContainerProcess;
  }

  it('N=3 全败：抛错走失败路径，WARN 含 attempt 1/3 与 2/3，重试间重新 spawn host', async () => {
    engineApi.waitForHostReady.mockRejectedValue(new Error('host not responding'));
    engineApi.bootEngineHost.mockResolvedValueOnce(fakeProc('p2')).mockResolvedValueOnce(fakeProc('p3'));
    const logs: string[] = [];
    const client = {} as unknown as TerminalClient;
    const wc = {} as unknown as WebContainer;
    const hooks: EngineBootHooks = { hostSrc: 'host', lifoCoreSrc: 'core' };

    await expect(waitForHostReadyWithRetry(makeUI(logs), wc, client, fakeProc('p1'), hooks)).rejects.toThrow(
      'host not responding'
    );

    expect(engineApi.waitForHostReady).toHaveBeenCalledTimes(3);
    // 2 次 WARN 重试 → 2 次 respawn（每次 kill 旧 host + spawn 新 host）
    expect(engineApi.bootEngineHost).toHaveBeenCalledTimes(2);
    expect(logs).toEqual([
      '[ WARN ] TerminalExecutor not ready (attempt 1/3), respawning host...',
      '[ WARN ] TerminalExecutor not ready (attempt 2/3), respawning host...',
    ]);
  });

  it('第 2 次探活成功则停止重试，返回重设后的 host 句柄', async () => {
    const initial = fakeProc('p1');
    engineApi.waitForHostReady.mockRejectedValueOnce(new Error('not yet')).mockResolvedValueOnce({ kind: 'pong' });
    const respawned = fakeProc('p2');
    engineApi.bootEngineHost.mockResolvedValueOnce(respawned);
    const logs: string[] = [];
    const client = {} as unknown as TerminalClient;
    const wc = {} as unknown as WebContainer;
    const hooks: EngineBootHooks = { hostSrc: 'host', lifoCoreSrc: 'core' };

    const result = await waitForHostReadyWithRetry(makeUI(logs), wc, client, initial, hooks);

    expect(result).toBe(respawned);
    expect(engineApi.waitForHostReady).toHaveBeenCalledTimes(2);
    expect(engineApi.bootEngineHost).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['[ WARN ] TerminalExecutor not ready (attempt 1/3), respawning host...']);
    // respawnWithKillFirst 保证 kill 旧 host 先于 spawn 新 host（单 host 不变量）
    expect(initial.kill).toHaveBeenCalledBefore(engineApi.bootEngineHost);
  });
});
