// M3：host 协议实例上下文（additive instanceId）—— 纯逻辑协议层单测。
// 覆盖：ps 按实例过滤（该实例 + system，缺省不过滤）、interrupt 按实例分键
// （A 的 run 不被 B 的 interrupt 误杀）、进程归属关联（.succinix-<id> / c-<id>）。
// 说明（MASTER-PLAN M3 验证盲区）：双 tab demo 各自独立 host，不会向共享 host 发送
// instanceId —— 同页按实例路由（Map 分键 / ps 过滤）以本协议级单测为证，跨容器隔离
// 由阶段验证点 e2e 覆盖。如实标注，不把双 tab 全绿误判为同页已通。
import { describe, it, expect } from 'vitest';
import { filterProcessesForInstance, CurrentRunRegistry } from '../src/engine/host-route.js';

describe('ps 按实例过滤（M3）', () => {
  const procs = [
    { scope: 'system', containerId: undefined },
    { scope: 'container', containerId: '.succinix-c-1' },
    { scope: 'container', containerId: '.succinix-c-2' },
    { scope: 'container', containerId: 'c-3' }, // CISOL 兼容命名空间
    { scope: 'unknown', containerId: undefined },
  ] as Array<{ scope: string; containerId?: string }>;

  it('default instance (no instanceId) sees all processes — current behavior unchanged', () => {
    expect(filterProcessesForInstance(procs, 'default')).toHaveLength(5);
  });

  it('instance request returns only its own processes plus system', () => {
    const view = filterProcessesForInstance(procs, 'c-1');
    expect(view).toHaveLength(2);
    expect(view.map((p) => p.containerId)).toEqual([undefined, '.succinix-c-1']);
  });

  it('legacy c-<id> container processes match the same instance id (DM-12 coexistence)', () => {
    const view = filterProcessesForInstance(procs, 'c-3');
    expect(view.map((p) => p.containerId)).toEqual([undefined, 'c-3']);
  });

  it('unattributed processes are excluded from instance views', () => {
    const view = filterProcessesForInstance(procs, 'c-1');
    expect(view.some((p) => p.scope === 'unknown')).toBe(false);
  });
});

describe('interrupt 按实例分键（M3）', () => {
  it('registers runs per instance and interrupts only the requested instance', () => {
    const runs = new CurrentRunRegistry();
    runs.register('a', 1001);
    runs.register('b', 1002);

    // A 的 interrupt 只命中 A 的 run。
    expect(runs.get('a')).toBe(1001);
    expect(runs.get('b')).toBe(1002);

    // A 的 run settle 后清除，不影响 B。
    runs.clearIf('a', 1001);
    expect(runs.get('a')).toBeNull();
    expect(runs.get('b')).toBe(1002);

    // 无当前 run 的实例 → null（浏览器如实提示）。
    expect(runs.get('c')).toBeNull();
  });

  it('clearIf only clears its own pid (防串号)', () => {
    const runs = new CurrentRunRegistry();
    runs.register('a', 1001);
    // 误传别的 pid：不清除（保护 A 的 run 不被 B 的 settle 误删）。
    runs.clearIf('a', 9999);
    expect(runs.get('a')).toBe(1001);
    runs.clearIf('a', 1001);
    expect(runs.get('a')).toBeNull();
  });

  it('default instance key behaves like the single-value semantics', () => {
    const runs = new CurrentRunRegistry();
    expect(runs.get('default')).toBeNull();
    runs.register('default', 500);
    expect(runs.get('default')).toBe(500);
    runs.clearIf('default', 500);
    expect(runs.get('default')).toBeNull();
  });
});

describe('进程登记归属关联（M3，host-procs）', () => {
  it('state-root .succinix-<id> cwd associates the process with the instance', async () => {
    const { registerProcess, listProcesses, instanceIdFromPath } = await import('../src/engine/host-procs.js');
    const child = { pid: 7001, on: () => child, kill: () => true } as never;
    registerProcess('node server.js', child, '/home/workspace/workspace/.succinix-c-1/project');
    const entry = listProcesses().find((p) => p.pid === 7001);
    expect(entry?.scope).toBe('container');
    expect(entry?.containerId).toBe('.succinix-c-1');
    expect(instanceIdFromPath('/home/workspace/workspace/.succinix-c-1/project')).toBe('c-1');
  });
});
