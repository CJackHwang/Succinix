// Host-backed state for Lifo-owned package and service registries. The virtual
// paths stay conventional while the payload lives in each WebContainer
// instance root, so host respawn rebuilds registries from the same filesystem.
import fs from 'node:fs';
import { instanceStateRootFor } from '../host-route.js';

interface VfsLike {
  exists(path: string): boolean;
  readdir(path: string): Array<{ name: string; type: 'file' | 'directory' }>;
  readFile(path: string): Uint8Array;
}
interface MountableSandbox {
  kernel: { vfs: VfsLike };
  mountNative(virtualPath: string, hostPath: string, options: { fsModule: typeof fs }): void;
}

export interface PersistentLifoMounts {
  etc: string;
  packages: string;
}

export function persistentLifoMounts(instanceId: string, hostRoot: string): PersistentLifoMounts {
  const root = instanceStateRootFor(instanceId, hostRoot);
  return {
    etc: `${root}/etc`,
    packages: `${root}/var/lib/lifo/packages`,
  };
}

function copyMissingTree(vfs: VfsLike, virtualPath: string, hostPath: string): void {
  fs.mkdirSync(hostPath, { recursive: true });
  if (!vfs.exists(virtualPath)) return;
  for (const entry of vfs.readdir(virtualPath)) {
    const source = `${virtualPath}/${entry.name}`;
    const target = `${hostPath}/${entry.name}`;
    if (entry.type === 'directory') {
      copyMissingTree(vfs, source, target);
    } else if (!fs.existsSync(target)) {
      fs.writeFileSync(target, vfs.readFile(source));
    }
  }
}

/** Mount after Sandbox.create(): Lifo currently installs option mounts only
 * after its initial package/service boot, so the caller must rehydrate after
 * this function returns. */
export function mountPersistentLifoState(sandbox: MountableSandbox, mounts: PersistentLifoMounts): void {
  // Preserve Lifo's default profile/hosts/systemd directories on the first
  // mount while never overwriting a user-authored host-backed file.
  copyMissingTree(sandbox.kernel.vfs, '/etc', mounts.etc);
  fs.mkdirSync(mounts.packages, { recursive: true });
  sandbox.mountNative('/etc', mounts.etc, { fsModule: fs });
  sandbox.mountNative('/usr/lib/node_modules', mounts.packages, { fsModule: fs });
}
