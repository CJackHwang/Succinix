// M4：service/ports 按实例视图 + db 数据目录 + reboot 实例级语义（纯逻辑单测）。
import { describe, it, expect } from 'vitest';
import { processBelongsToInstance } from '../src/services/index.js';
import { InstancePortRegistry } from '../src/instance/ports.js';
import { tinbaseDataDir, DEFAULT_INSTANCE_ID } from '../src/instance/paths.js';
import { rebootMode } from '../src/commands.js';

describe('service 进程归属过滤（M4）', () => {
  const own = { scope: 'container', containerId: '.succinix-c-1' };
  const other = { scope: 'container', containerId: '.succinix-c-2' };
  const legacy = { scope: 'container', containerId: 'c-9' };
  const sys = { scope: 'system' };
  const unknown = { scope: 'unknown' };

  it('non-default instance matches only its own state root / system', () => {
    expect(processBelongsToInstance(own, 'c-1')).toBe(true);
    expect(processBelongsToInstance(other, 'c-1')).toBe(false);
    expect(processBelongsToInstance(legacy, 'c-9')).toBe(true); // CISOL 同 id
    expect(processBelongsToInstance(sys, 'c-1')).toBe(true);
    expect(processBelongsToInstance(unknown, 'c-1')).toBe(false);
  });

  it('default instance excludes other instances state-root processes (组织性隔离)', () => {
    expect(processBelongsToInstance(own, DEFAULT_INSTANCE_ID)).toBe(false);
    expect(processBelongsToInstance(other, DEFAULT_INSTANCE_ID)).toBe(false);
    expect(processBelongsToInstance(legacy, DEFAULT_INSTANCE_ID)).toBe(true); // CISOL 现状
    expect(processBelongsToInstance(sys, DEFAULT_INSTANCE_ID)).toBe(true);
    expect(processBelongsToInstance(unknown, DEFAULT_INSTANCE_ID)).toBe(true); // 现状：unknown 照旧匹配
  });
});

describe('实例端口视图（M4，InstancePortRegistry）', () => {
  it('default instance view = page-level ports (现状全等)', () => {
    const reg = new InstancePortRegistry();
    const page = new Map([[3001, 'url-3001'], [4000, 'url-4000']]);
    expect(reg.portsFor(DEFAULT_INSTANCE_ID, page)).toBe(page);
  });

  it('instance view = expected ports ∩ ready ports; unattributable ports stay page-level only', () => {
    const reg = new InstancePortRegistry();
    reg.expect('c-1', 3001);
    reg.expect('c-1', 4000);
    const page = new Map([[3001, 'url-3001'], [9999, 'url-9999']]); // 4000 未就绪；9999 无人期望
    const view = reg.portsFor('c-1', page);
    expect([...view.entries()]).toEqual([[3001, 'url-3001']]);
    // 9999 只在页面级 registry，不进实例视图（如实标注）。
    expect(view.has(9999)).toBe(false);
  });

  it('release removes the expectation; instances are independent', () => {
    const reg = new InstancePortRegistry();
    reg.expect('c-1', 3001);
    reg.expect('c-2', 3001); // 不同实例可各自期望同一端口（跨容器天然隔离）
    expect(reg.hasConflict('c-1', 3001)).toBe('c-2');
    expect(reg.hasConflict('c-2', 3001)).toBe('c-1');
    reg.release('c-2', 3001);
    expect(reg.hasConflict('c-1', 3001)).toBeNull();
    expect(reg.expectedFor('c-1')).toEqual([3001]);
    expect(reg.expectedFor('c-2')).toEqual([]);
  });
});

describe('db 数据目录（M4）', () => {
  it('instance data dir lives under the instance state root', () => {
    expect(tinbaseDataDir('c-1')).toBe('/workspace/.succinix-c-1/tinbase');
    expect(tinbaseDataDir('user-a')).toBe('/workspace/.succinix-user-a/tinbase');
  });

  it('default instance keeps the current data location', () => {
    expect(tinbaseDataDir(DEFAULT_INSTANCE_ID)).toBe('/workspace/.tinbase');
  });
});

describe('reboot 实例级语义（M4）', () => {
  it('non-default instance reboots at instance level; default/page reboots the page', () => {
    expect(rebootMode('c-1')).toBe('instance');
    expect(rebootMode('default')).toBe('page');
    expect(rebootMode(undefined)).toBe('page');
  });
});
