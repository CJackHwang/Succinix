import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VFS } from '@lifo-sh/core';
import { mountPersistentLifoState, persistentLifoMounts } from '../src/engine/host/state-mounts.js';

describe('persistent Lifo state mounts', () => {
  it('maps package/service state per instance and preserves user files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'succinix-state-mount-'));
    try {
      const mounts = persistentLifoMounts('a', root);
      fs.mkdirSync(mounts.etc, { recursive: true });
      fs.writeFileSync(path.join(mounts.etc, 'profile'), 'custom profile\n');
      const vfs = new VFS();
      vfs.mkdir('/etc/systemd/system', { recursive: true });
      vfs.writeFile('/etc/profile', 'default profile\n');
      vfs.writeFile('/etc/systemd/system/base.service', '[Service]\nExecStart=true\n');
      const mountNative = vi.fn();
      mountPersistentLifoState({ kernel: { vfs }, mountNative } as never, mounts);

      expect(fs.readFileSync(path.join(mounts.etc, 'profile'), 'utf8')).toBe('custom profile\n');
      expect(fs.readFileSync(path.join(mounts.etc, 'systemd/system/base.service'), 'utf8')).toContain('ExecStart=true');
      expect(mountNative).toHaveBeenCalledWith('/etc', mounts.etc, { fsModule: fs });
      expect(mountNative).toHaveBeenCalledWith('/usr/lib/node_modules', mounts.packages, { fsModule: fs });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
