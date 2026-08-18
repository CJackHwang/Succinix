// bootEngineHost 端口监听器只注册一次（TASK-BOOTGATE 审计 M1）：
// R3.2 重试 bootEngineHost（kill 旧 host 再 spawn）复用同一 wc，不得叠加 server-ready/port
// 监听器；不同 wc 实例（各自 boot）仍应各自注册。直接驱动真实 bootEngineHost + 假 wc 断言。
import { describe, it, expect, vi } from 'vitest';
import { bootEngineHost } from '../src/engine/index.js';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import type { TerminalClient } from '../src/engine/index.js';

// 假 wc：只覆盖 bootEngineHost 用到的 fs / spawn / on 子集。
function makeWc() {
  const fs = {
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
  const spawn = vi.fn().mockResolvedValue({ kill: vi.fn() } as unknown as WebContainerProcess);
  const on = vi.fn();
  return { fs, spawn, on };
}

const client = { takeHostEpoch: vi.fn(() => 'boot-test') } as unknown as TerminalClient;

describe('bootEngineHost 端口监听器（M1）', () => {
  it('同一 wc 实例重复 bootEngineHost 只注册一次 server-ready/port 监听器', async () => {
    const wc = makeWc();
    for (let i = 0; i < 3; i++) {
      await bootEngineHost(wc as unknown as WebContainer, client, { hostSrc: '// host.js' });
    }
    // 首次注册 server-ready + port 各一次；重试（同 wc）不再叠加
    expect(wc.on).toHaveBeenCalledTimes(2);
    expect(wc.on).toHaveBeenCalledWith('server-ready', expect.any(Function));
    expect(wc.on).toHaveBeenCalledWith('port', expect.any(Function));
    // 每次 bootEngineHost 都重新 spawn host（重试语义），但监听器不重复
    expect(wc.spawn).toHaveBeenCalledTimes(3);
  });

  it('不同 wc 实例各自注册监听器', async () => {
    const wc1 = makeWc();
    const wc2 = makeWc();
    await bootEngineHost(wc1 as unknown as WebContainer, client, { hostSrc: '// host.js' });
    await bootEngineHost(wc2 as unknown as WebContainer, client, { hostSrc: '// host.js' });
    expect(wc1.on).toHaveBeenCalledTimes(2);
    expect(wc2.on).toHaveBeenCalledTimes(2);
  });
});
