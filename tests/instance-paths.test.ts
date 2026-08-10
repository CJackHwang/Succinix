// M2：实例状态路径参数化 —— 浏览器侧 statePath / host 侧 instanceStateFile 与
// instanceId 归一化（纯函数，跨容器 host 视角与浏览器 wc.fs 视角对齐）。
import { describe, it, expect } from 'vitest';
import { DEFAULT_INSTANCE_ID, INSTANCE_STATE_ROOT_PREFIX, instanceStateRoot, statePath } from '../src/instance/paths.js';
import {
  DEFAULT_INSTANCE_ID as HOST_DEFAULT_INSTANCE_ID,
  normalizeInstanceId,
  instanceStateRootFor,
  instanceStateFile,
} from '../src/engine/host-route.js';

describe('browser statePath (M2)', () => {
  it('default instance keeps the current /etc paths unchanged', () => {
    expect(instanceStateRoot(DEFAULT_INSTANCE_ID)).toBe('');
    expect(statePath(DEFAULT_INSTANCE_ID, 'etc/succinix.env')).toBe('/etc/succinix.env');
    expect(statePath(DEFAULT_INSTANCE_ID, '/etc/succinix.settings')).toBe('/etc/succinix.settings');
    expect(statePath('default', 'etc/succinix.cwd')).toBe('/etc/succinix.cwd');
  });

  it('instance paths live under the state root with a .succinix-<id> prefix', () => {
    expect(instanceStateRoot('c-1')).toBe('/workspace/.succinix-c-1');
    expect(statePath('c-1', 'etc/succinix.env')).toBe('/workspace/.succinix-c-1/etc/succinix.env');
    expect(statePath('c-1', '/etc/succinix.env')).toBe('/workspace/.succinix-c-1/etc/succinix.env');
    expect(statePath('user-a', 'etc/succinix.motd')).toBe('/workspace/.succinix-user-a/etc/succinix.motd');
    expect(INSTANCE_STATE_ROOT_PREFIX).toBe('/workspace/.succinix-');
  });
});

describe('host instance state paths (M2, host-route)', () => {
  it('normalizeInstanceId maps missing/empty to the default instance', () => {
    expect(normalizeInstanceId(undefined)).toBe(HOST_DEFAULT_INSTANCE_ID);
    expect(normalizeInstanceId(null)).toBe(HOST_DEFAULT_INSTANCE_ID);
    expect(normalizeInstanceId('')).toBe(HOST_DEFAULT_INSTANCE_ID);
    expect(normalizeInstanceId('c-1')).toBe('c-1');
    expect(HOST_DEFAULT_INSTANCE_ID).toBe('default');
  });

  it('default instance state root is process cwd (current /etc semantics)', () => {
    expect(instanceStateRootFor('default', '/home/workspace')).toBe('/home/workspace');
    expect(instanceStateFile('default', '/home/workspace', 'etc/succinix.env')).toBe('/home/workspace/etc/succinix.env');
    // 引擎配置（M2：host 从请求 instanceId 解析自身配置路径，禁止全局单份串扰）。
    expect(instanceStateFile('default', '/home/workspace', 'etc/succinix.engine.json')).toBe('/home/workspace/etc/succinix.engine.json');
  });

  it('instance state root maps to the host real path of /workspace/.succinix-<id>', () => {
    expect(instanceStateRootFor('c-1', '/home/workspace')).toBe('/home/workspace/workspace/.succinix-c-1');
    expect(instanceStateFile('c-1', '/home/workspace', 'etc/succinix.env')).toBe('/home/workspace/workspace/.succinix-c-1/etc/succinix.env');
    expect(instanceStateFile('c-1', '/home/workspace', 'etc/succinix.cwd')).toBe('/home/workspace/workspace/.succinix-c-1/etc/succinix.cwd');
    expect(instanceStateFile('c-1', '/home/workspace', '/etc/succinix.env')).toBe('/home/workspace/workspace/.succinix-c-1/etc/succinix.env');
  });
});
