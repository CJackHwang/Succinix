// C1 包形态测试：exports 快照 / 插件对象 / 同步 schema / singleton reset / 类型增强。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Context, type Events } from '@deepseek-ai/cordis';
import { describe, expect, it, beforeEach } from 'vitest';
import plugin, { apply, Config, requiresRestart } from '../src/plugin/index.js';
import { getHostManager, resetPageSingletons } from '../src/plugin/host-manager.js';
import { checkSync, type Schema } from '../src/plugin/schema.js';
import { hostOf } from './helpers/fakes.js';

beforeEach(() => {
  resetPageSingletons();
});

describe('engine 0.7.0 package shape', () => {
  it('exports only the single-track keys', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'packages/engine/package.json'), 'utf8')) as {
      version: string;
      exports: Record<string, unknown>;
      peerDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.exports)).toEqual(['.', './host.js', './lifo-core.js', './assets/*', './package.json']);
    expect(pkg.version).toBe('0.7.0');
    expect(pkg.peerDependencies['@deepseek-ai/cordis']).toBe('^4.0.1');
    expect(pkg.dependencies['@standard-schema/spec']).toBe('^1.1.0');
  });

  it('plugin object exposes name/apply/Config', () => {
    expect(plugin).toMatchObject({ name: 'succinix', apply: expect.any(Function) });
    expect(plugin.Config).toBe(Config);
    expect(apply).toBe(plugin.apply);
  });

  it('provides dsh service keys and the internal host seam when loaded', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(plugin, {});
    await fiber;
    expect(ctx.fs).toBeDefined();
    expect(ctx.sandbox).toBeDefined();
    expect(ctx.terminals).toBeDefined();
    expect(ctx.sessionPersistence).toBeDefined();
    expect(hostOf(ctx).state.version).toBe('0.7.0');
    expect(hostOf(ctx).state.containerMode).toBe('internal');
    await fiber.dispose();
  });
});

describe('synchronous config schema', () => {
  it('accepts empty and valid configs', () => {
    const result = checkSync(Config, {});
    expect('issues' in result).toBe(false);
    const valid = checkSync(Config, {
      hostJsUrl: '/assets/host.js',
      lifoCoreUrl: '/assets/lifo-core.js',
      pythonAssetsUrl: '/assets/pyodide/',
      rubyAssetsUrl: '/assets/ruby/',
      resultTtlMs: 5000,
      container: { mode: 'external', bootRetries: 2, bootIntervalMs: 100, hostReadyDeadlineMs: 1000 },
      defaultInstance: {
        instanceId: 'default',
        statePrefix: '.succinix-default',
        home: '/workspace',
        persistence: { dbName: 'test', storeKey: 'default', includeGit: true },
      },
      capabilities: { defaultAllow: true, rules: [{ pattern: 'fs.read', allow: true }] },
      lifecycle: { disposeMode: 'soft', flushOnPageHide: true },
      assets: { integrity: true },
    });
    expect('issues' in valid).toBe(false);
  });

  it('rejects invalid and unknown fields', () => {
    const bad = checkSync(Config, { resultTtlMs: 0, mystery: true });
    expect('issues' in bad && bad.issues).toBeTruthy();
    expect('issues' in checkSync(Config, { terminal: { cwd: '/workspace' } })).toBe(true);
  });

  it('rejects async validators explicitly', () => {
    const asyncSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async () => ({ value: {} }),
      },
    } as unknown as Schema<Record<string, unknown>>;
    expect(() => checkSync(asyncSchema, {})).toThrow(TypeError);
  });

  it('derives requiresRestart from host asset/mode changes only', () => {
    expect(requiresRestart({}, { hostJsUrl: '/other-host.js' })).toBe(true);
    expect(requiresRestart({}, { lifoCoreUrl: '/other-lifo.js' })).toBe(true);
    expect(requiresRestart({}, { container: { mode: 'external' } })).toBe(true);
    expect(requiresRestart({}, { resultTtlMs: 1000 })).toBe(false);
  });
});

describe('page singletons', () => {
  it('HostManager is stable until resetPageSingletons', () => {
    const first = getHostManager();
    expect(getHostManager()).toBe(first);
    resetPageSingletons();
    expect(getHostManager()).not.toBe(first);
  });
});

describe('type augmentation', () => {
  it('dsh keys, host seam, and succinix/* events compile through cordis types', () => {
    const serviceFor = (ctx: Context): ReturnType<typeof hostOf> => hostOf(ctx);
    const fsFor = (ctx: Context): typeof ctx.fs => ctx.fs;
    const statePayload = (): Parameters<Events['succinix/state']>[0] =>
      null as unknown as Parameters<Events['succinix/state']>[0];
    expect(typeof serviceFor).toBe('function');
    expect(typeof fsFor).toBe('function');
    expect(typeof statePayload).toBe('function');
  });
});
