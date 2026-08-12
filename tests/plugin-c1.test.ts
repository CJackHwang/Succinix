// C1 包形态测试：exports 快照 / 插件对象 / 同步 schema / singleton reset / 类型增强。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Context, type Events } from 'cordis';
import { describe, expect, it, beforeEach } from 'vitest';
import plugin, { apply, Config, requiresRestart } from '../src/plugin/index.js';
import { getHostManager, resetPageSingletons } from '../src/plugin/host-manager.js';
import { checkSync, type Schema } from '../src/plugin/schema.js';
import type { SuccinixService } from '../src/plugin/types.js';

beforeEach(() => {
  resetPageSingletons();
});

describe('engine 0.5.0 package shape', () => {
  it('exports only the single-track keys', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'packages/engine/package.json'), 'utf8')) as {
      version: string;
      exports: Record<string, unknown>;
      peerDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.exports)).toEqual(['.', './host.js', './lifo-core.js', './assets/*', './package.json']);
    expect(pkg.version).toBe('0.5.0');
    expect(pkg.peerDependencies.cordis).toBe('>=4.0.0-rc.8');
    expect(pkg.dependencies['@standard-schema/spec']).toBe('^1.1.0');
  });

  it('plugin object exposes name/apply/Config', () => {
    expect(plugin).toMatchObject({ name: 'succinix', apply: expect.any(Function) });
    expect(plugin.Config).toBe(Config);
    expect(apply).toBe(plugin.apply);
  });

  it('provides ctx.succinix when loaded', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(plugin, {});
    await fiber;
    expect(ctx.succinix.state.version).toBe('0.5.0');
    expect(ctx.succinix.state.containerMode).toBe('internal');
    await fiber.dispose();
  });
});

describe('synchronous config schema', () => {
  it('accepts empty and valid configs', () => {
    const result = checkSync(Config, {});
    expect('issues' in result).toBe(false);
    const valid = checkSync(Config, { resultTtlMs: 5000, container: { mode: 'external' } });
    expect('issues' in valid).toBe(false);
  });

  it('rejects invalid and unknown fields', () => {
    const bad = checkSync(Config, { resultTtlMs: 0, mystery: true });
    expect('issues' in bad && bad.issues).toBeTruthy();
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
  it('ctx.succinix and succinix/* events compile through cordis types', () => {
    const serviceFor = (ctx: Context): SuccinixService => ctx.succinix;
    const statePayload = (): Parameters<Events['succinix/state']>[0] =>
      null as unknown as Parameters<Events['succinix/state']>[0];
    expect(typeof serviceFor).toBe('function');
    expect(typeof statePayload).toBe('function');
  });
});
