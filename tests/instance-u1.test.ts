// U1：每用户 home 初始化 —— ensureUserHome（src/terminal/boot.ts）单元测试。
// 覆盖：首次启动创建 /workspace/users/<id>（mkdir + .succinix 种子）、幂等（已存在不覆写）、
// 宿主可覆盖 home 根。进程过滤 / kill 越权拒绝见 host-route.test.ts（canKillProcess）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { ensureUserHome } from '../src/boot-steps.js';
import { userHomePath } from '../src/instance/paths.js';
import { FakeFS } from './helpers/fakes.js';

describe('ensureUserHome（U1 每用户 home 初始化）', () => {
  let fs: FakeFS;
  beforeEach(() => {
    fs = new FakeFS();
    wcApi.boot.mockReset();
    engineApi.waitForHostReady.mockReset();
    engineApi.bootEngineHost.mockReset();
  });

  it('首次启动创建 home 目录与 .succinix 种子（内容 = 用户 id）', async () => {
    await ensureUserHome(fs as unknown as Parameters<typeof ensureUserHome>[0], 'a');
    expect(fs.has('/workspace/users/a')).toBe(true);
    expect(fs.raw('/workspace/users/a/.succinix')).toBe('a');
  });

  it('默认 home 路径遵循 /workspace/users/<id> 约定', async () => {
    await ensureUserHome(fs as unknown as Parameters<typeof ensureUserHome>[0], 'alice');
    expect(fs.has('/workspace/users/alice')).toBe(true);
    expect(fs.raw('/workspace/users/alice/.succinix')).toBe('alice');
  });

  it('幂等：home 已存在时保留现有种子内容（不覆写用户数据）', async () => {
    await fs.mkdir('/workspace/users/b', { recursive: true });
    await fs.writeFile('/workspace/users/b/.succinix', 'custom');
    await ensureUserHome(fs as unknown as Parameters<typeof ensureUserHome>[0], 'b');
    expect(fs.raw('/workspace/users/b/.succinix')).toBe('custom');
  });

  it('宿主可覆盖 home 根（userHomePath 第二参数）', async () => {
    const home = userHomePath('a', '/srv/homes');
    await ensureUserHome(fs as unknown as Parameters<typeof ensureUserHome>[0], 'a', home);
    expect(fs.has('/srv/homes/a')).toBe(true);
    expect(fs.raw('/srv/homes/a/.succinix')).toBe('a');
  });
});
