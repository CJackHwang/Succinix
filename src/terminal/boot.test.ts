// TerminalBoot 单测（E2 / D1）：steps 长度 = 进度总数 / 重试路径（fake wc 失败后成功）/
// testMode 透传 / 自定义步骤文案 / 环境不适配错误页。D1 后 SDK 不再 import 应用层
// （persist/config/services/motd/log），快照恢复与应用级步骤由 restore / appSteps /
// dynamicStepCount 钩子注入 —— 本测试用脚本化钩子覆盖这些契约点。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 脚本化外部依赖（vi.hoisted 保证 mock 工厂先于被测模块 import 求值）。
const wcApi = vi.hoisted(() => ({ boot: vi.fn() }));
const engineApi = vi.hoisted(() => ({
  waitForHostReady: vi.fn(),
  bootEngineHost: vi.fn(),
}));

vi.mock('@webcontainer/api', () => ({ WebContainer: { boot: wcApi.boot } }));
vi.mock('../engine/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/index.js')>();
  return { ...actual, waitForHostReady: engineApi.waitForHostReady, bootEngineHost: engineApi.bootEngineHost };
});

import type { BootUI } from './ui.js';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { createTerminalBoot, DEFAULT_BOOT_STEPS, type TerminalBoot, type TerminalBootAppContext } from './boot.js';
import { FakeFS } from '../../tests/helpers/fakes.js';

vi.stubGlobal('window', {
  crossOriginIsolated: true,
  screen: { width: 1280, height: 800 },
  __bootTimes: { phases: {} },
} as unknown as Window & typeof globalThis);
vi.stubGlobal('navigator', {
  userAgent: 'Mozilla/5.0 Chrome/120.0',
  hardwareConcurrency: 8,
  language: 'en-US',
} as unknown as Navigator);

function makeUI(logs: string[]): BootUI {
  return {
    log: (text: string) => void logs.push(text),
    systemInfo: () => {},
    complete: async () => {},
    fail: (reasons: string[], _opts?: { header?: string; footer?: string }) => void logs.push(`FAIL:${reasons.join('|')}`),
  };
}

function fakeProc(id: string): WebContainerProcess {
  return { pid: id, kill: vi.fn() } as unknown as WebContainerProcess;
}

// 全流程脚本化：bootEngineHost 触发 onInjected/onSpawned（模拟真实首次 boot 的
// 条件计步），waitForHostReady 直接成功。
function wireHappyPath(): void {
  engineApi.bootEngineHost.mockImplementation(async (_wc, _client, hooks) => {
    hooks.onInjected?.();
    hooks.onSpawned?.();
    return fakeProc('host1');
  });
  engineApi.waitForHostReady.mockResolvedValue(undefined);
}

// 模拟独立应用的应用级步骤（workspace / env / ready 三步，与 runApplicationBootSteps 同款计数）。
interface AppHookOverrides {
  restore?: (wc: WebContainer) => Promise<{ fileCount: number; totalBytes: number } | null>;
  appSteps?: (boot: TerminalBoot, ctx: TerminalBootAppContext) => Promise<WebContainerProcess | null | undefined>;
}

function wireAppHooks(overrides: AppHookOverrides = {}) {
  return {
    restore: overrides.restore ?? (async () => null),
    appSteps: overrides.appSteps ?? (async (boot: TerminalBoot) => {
      boot.ok('Initialized default workspace');
      boot.ok('Loaded environment variables');
      boot.ok('TerminalExecutor ready');
      return null;
    }),
    dynamicStepCount: async () => 0,
    logLine: vi.fn(),
  };
}

function makeFakeWc(): WebContainer {
  return { fs: new FakeFS() } as unknown as WebContainer;
}

beforeEach(() => {
  wcApi.boot.mockReset();
  engineApi.bootEngineHost.mockReset();
  engineApi.waitForHostReady.mockReset();
  wireHappyPath();
});

describe('createTerminalBoot', () => {
  it('steps 长度 = 进度总数：8 步固定序列精确递增到 8/8', async () => {
    wcApi.boot.mockResolvedValue(makeFakeWc());
    const logs: string[] = [];
    const hooks = wireAppHooks();
    const result = await createTerminalBoot(makeUI(logs), { steps: [...DEFAULT_BOOT_STEPS], ...hooks }).boot();
    expect(result).not.toBeNull();
    const counted = logs.filter((l) => /\[\s+OK\s+\] \d+\/\d+ /.test(l) || /\[ \.\.\.\. \] \d+\/\d+ /.test(l) || /\[ FAIL \] \d+\/\d+ /.test(l));
    // 8 步固定序列（含条件注入步与 onSpawned 两步）全部带 N/8 前缀，末行为 8/8
    expect(counted.length).toBe(DEFAULT_BOOT_STEPS.length);
    expect(counted.at(-1)).toContain('8/8 TerminalExecutor ready');
    for (const line of counted) expect(line).toMatch(/\d+\/8 /);
  });

  it('restore 钩子注入：恢复成功时步骤文案带文件数与 KB', async () => {
    wcApi.boot.mockResolvedValue(makeFakeWc());
    const logs: string[] = [];
    const hooks = wireAppHooks({ restore: async () => ({ fileCount: 42, totalBytes: 2048 }) });
    const result = await createTerminalBoot(makeUI(logs), { steps: [...DEFAULT_BOOT_STEPS], ...hooks }).boot();
    expect(result).not.toBeNull();
    expect(logs.some((l) => l.includes('Restored workspace from persistent storage (42 files, 2 KB)'))).toBe(true);
  });

  it('appSteps 钩子注入：ctx 携带引擎级 boot 产物（wc/client/ports/hostProc/hostHooks）', async () => {
    wcApi.boot.mockResolvedValue(makeFakeWc());
    const logs: string[] = [];
    let seen: unknown = null;
    const hooks = wireAppHooks({
      appSteps: async (boot, ctx) => {
        seen = ctx;
        boot.ok('app step');
        return null;
      },
    });
    const result = await createTerminalBoot(makeUI(logs), { steps: [...DEFAULT_BOOT_STEPS], ...hooks }).boot();
    expect(result).not.toBeNull();
    const ctx = seen as { wc: unknown; client: unknown; ports: Map<number, string>; hostProc: unknown; hostHooks: unknown };
    expect(ctx.wc).toBeDefined();
    expect(ctx.client).toBeDefined();
    expect(ctx.ports).toBeInstanceOf(Map);
    expect(ctx.hostProc).toBeDefined();
    expect(ctx.hostHooks).toBeDefined();
  });

  it('自定义步骤文案：ok() 无参时使用 opts.steps 对应标签', async () => {
    wcApi.boot.mockResolvedValue(makeFakeWc());
    const logs: string[] = [];
    await createTerminalBoot(makeUI(logs), { steps: ['Alpha', 'Beta', 'Gamma'] }).boot();
    expect(logs.some((l) => l.includes('[  OK  ] 1/3 Alpha'))).toBe(true);
  });

  it('testMode 透传', () => {
    const ui = makeUI([]);
    expect(createTerminalBoot(ui, { steps: ['A', 'B'], testMode: true }).testMode).toBe(true);
    expect(createTerminalBoot(ui, { steps: ['A', 'B'] }).testMode).toBe(false);
  });

  it('retry 参数：fake wc 失败后成功，WARN 文案按 attempts 上限', async () => {
    const fakeWc = makeFakeWc();
    wcApi.boot.mockRejectedValueOnce(new Error('first down')).mockResolvedValueOnce(fakeWc);
    const logs: string[] = [];
    const result = await createTerminalBoot(makeUI(logs), {
      steps: [...DEFAULT_BOOT_STEPS],
      retry: { attempts: 2, intervalMs: 0 },
    }).boot();
    expect(result).not.toBeNull();
    expect(wcApi.boot).toHaveBeenCalledTimes(2);
    expect(logs).toContain('[ WARN ] WebContainer boot failed (attempt 1/2), retrying...');
  });

  it('环境不适配：checkEnvironment 失败 → 返回 null 且错误页文案进入 ui.fail', async () => {
    vi.stubGlobal('window', { crossOriginIsolated: false, screen: {} } as unknown as Window & typeof globalThis);
    const logs: string[] = [];
    const result = await createTerminalBoot(makeUI(logs), { steps: ['A'] }).boot();
    expect(result).toBeNull();
    expect(logs.some((l) => l.startsWith('FAIL:Cross-origin isolation'))).toBe(true);
  });
});
