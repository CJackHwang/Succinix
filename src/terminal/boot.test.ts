// TerminalBoot 单测（E2）：steps 长度 = 进度总数 / 重试路径（fake wc 失败后成功）/
// testMode 透传 / 自定义步骤文案 / 环境不适配错误页。全流程经 vi.mock 脚本化
// persist/config/services/motd/log 与 engine 的 bootEngineHost/waitForHostReady。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 脚本化外部依赖（vi.hoisted 保证 mock 工厂先于被测模块 import 求值）。
const wcApi = vi.hoisted(() => ({ boot: vi.fn() }));
const engineApi = vi.hoisted(() => ({
  waitForHostReady: vi.fn(),
  bootEngineHost: vi.fn(),
}));
const persistApi = vi.hoisted(() => ({ loadSnapshot: vi.fn() }));
const configApi = vi.hoisted(() => ({
  getSetting: vi.fn(),
  readEnvFile: vi.fn(),
  isValidWorkspaceName: vi.fn(),
}));
const servicesApi = vi.hoisted(() => ({
  ensureServicesFiles: vi.fn(),
  readAutostart: vi.fn(),
  startService: vi.fn(),
}));
const motdApi = vi.hoisted(() => ({ ensureMotd: vi.fn() }));
const logApi = vi.hoisted(() => ({ initLogger: vi.fn(), log: vi.fn() }));
const restartApi = vi.hoisted(() => ({ respawnWithKillFirst: vi.fn() }));

vi.mock('@webcontainer/api', () => ({ WebContainer: { boot: wcApi.boot } }));
vi.mock('../engine/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/index.js')>();
  return { ...actual, waitForHostReady: engineApi.waitForHostReady, bootEngineHost: engineApi.bootEngineHost };
});
vi.mock('../persist.js', () => ({ loadSnapshot: persistApi.loadSnapshot }));
vi.mock('../config.js', () => configApi);
vi.mock('../services.js', () => servicesApi);
vi.mock('../motd.js', () => motdApi);
vi.mock('../log.js', () => logApi);
vi.mock('../host-restart.js', () => restartApi);

import type { BootUI } from '../boot-ui.js';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { createTerminalBoot, DEFAULT_BOOT_STEPS } from './boot.js';
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
  persistApi.loadSnapshot.mockResolvedValue(null);
  configApi.getSetting.mockResolvedValue('main');
  configApi.readEnvFile.mockResolvedValue(new Map());
  configApi.isValidWorkspaceName.mockImplementation((s: unknown) => typeof s === 'string' && s.length > 0);
  servicesApi.ensureServicesFiles.mockResolvedValue(undefined);
  servicesApi.readAutostart.mockResolvedValue([]);
  servicesApi.startService.mockResolvedValue({ ok: true });
  motdApi.ensureMotd.mockResolvedValue(undefined);
  logApi.initLogger.mockImplementation(() => {});
  logApi.log.mockImplementation(() => {});
  restartApi.respawnWithKillFirst.mockImplementation(async (_kill: () => void, spawn: () => Promise<unknown>) => spawn());
}

function makeFakeWc(): WebContainer {
  return { fs: new FakeFS() } as unknown as WebContainer;
}

beforeEach(() => {
  wcApi.boot.mockReset();
  engineApi.bootEngineHost.mockReset();
  engineApi.waitForHostReady.mockReset();
  persistApi.loadSnapshot.mockReset();
  configApi.getSetting.mockReset();
  configApi.readEnvFile.mockReset();
  servicesApi.readAutostart.mockReset();
  restartApi.respawnWithKillFirst.mockReset();
  wireHappyPath();
});

describe('createTerminalBoot', () => {
  it('steps 长度 = 进度总数：8 步固定序列精确递增到 8/8', async () => {
    wcApi.boot.mockResolvedValue(makeFakeWc());
    const logs: string[] = [];
    const result = await createTerminalBoot(makeUI(logs), { steps: [...DEFAULT_BOOT_STEPS] }).boot();
    expect(result).not.toBeNull();
    const counted = logs.filter((l) => /\[\s+OK\s+\] \d+\/\d+ /.test(l) || /\[ \.\.\.\. \] \d+\/\d+ /.test(l) || /\[ FAIL \] \d+\/\d+ /.test(l));
    // 8 步固定序列（含条件注入步与 onSpawned 两步）全部带 N/8 前缀，末行为 8/8
    expect(counted.length).toBe(DEFAULT_BOOT_STEPS.length);
    expect(counted.at(-1)).toContain('8/8 TerminalExecutor ready');
    for (const line of counted) expect(line).toMatch(/\d+\/8 /);
  });

  it('自定义步骤文案：ok() 无参时使用 opts.steps 对应标签', async () => {
    wcApi.boot.mockResolvedValue(makeFakeWc());
    const logs: string[] = [];
    await createTerminalBoot(makeUI(logs), { steps: ['Alpha', 'Beta', 'Gamma'] }).boot();
    expect(logs.some((l) => l.includes('[  OK  ] 1/3 Alpha'))).toBe(true);
  });

  it('testMode 透传', () => {
    const ui = makeUI([]);
    expect(createTerminalBoot(ui, { steps: ['A'], testMode: true }).testMode).toBe(true);
    expect(createTerminalBoot(ui, { steps: ['A'] }).testMode).toBe(false);
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
