import type { FileSystemAPI } from '@webcontainer/api';
import type { BinarySnapshotManifest } from './binary-v2.js';
import type { PersistOptions } from './types.js';

export interface SnapshotTreePaths {
  files: string[];
  dirs: string[];
  emptyDirs: string[];
}

export async function listSnapshotTreePaths(
  fs: FileSystemAPI,
  root: string,
  skip: (path: string) => boolean,
): Promise<SnapshotTreePaths> {
  const files: string[] = [];
  const dirs: string[] = [];
  const emptyDirs: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.length === 0) {
      dirs.push(dir);
      emptyDirs.push(dir);
    }
    for (const entry of entries) {
      const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
      if (skip(path)) continue;
      if (entry.isDirectory()) { dirs.push(path); await visit(path); }
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return { files, dirs, emptyDirs };
}

export async function removeStaleSnapshotPaths(
  fs: FileSystemAPI,
  scopeRoot: string,
  skip: (path: string) => boolean,
  manifest: BinarySnapshotManifest,
): Promise<void> {
  if (!manifest.filePaths) return;
  const desiredFiles = new Set(manifest.filePaths);
  const desiredDirs = new Set(manifest.emptyDirs ?? []);
  for (const file of manifest.filePaths) {
    let parent = file.slice(0, file.lastIndexOf('/')) || '/';
    while (parent && parent !== '/') {
      desiredDirs.add(parent);
      parent = parent.slice(0, parent.lastIndexOf('/')) || '/';
    }
  }
  const current = await listSnapshotTreePaths(fs, scopeRoot, skip);
  for (const file of current.files) if (!desiredFiles.has(file)) await fs.rm(file);
  for (const dir of current.dirs.sort((a, b) => b.length - a.length)) {
    if (dir !== scopeRoot && !desiredDirs.has(dir)) {
      try { await fs.rm(dir, { recursive: true }); } catch { /* best effort */ }
    }
  }
}

export async function collectBinaryInstanceExcludes(
  fs: FileSystemAPI,
  scopeRoot: string,
  instanceScope: PersistOptions['instanceScope'],
): Promise<string[]> {
  if (!instanceScope || scopeRoot !== '/workspace') return [];
  const excludes: string[] = [];
  try {
    const entries = await fs.readdir('/workspace', { withFileTypes: true });
    for (const entry of entries as Array<{ name: string; isDirectory?: () => boolean }>) {
      if (!entry.name.startsWith('.succinix-') || (entry.isDirectory && !entry.isDirectory())) continue;
      const path = `/workspace/${entry.name}`;
      if (instanceScope.stateRoot && (path === instanceScope.stateRoot || path.startsWith(`${instanceScope.stateRoot}/`))) continue;
      excludes.push(`**/${entry.name}/**`);
    }
    if (!instanceScope.home) return [...excludes, '**/users/**'];
    const users = await fs.readdir('/workspace/users', { withFileTypes: true }).catch(() => []);
    for (const entry of users as Array<{ name: string; isDirectory?: () => boolean }>) {
      if (entry.isDirectory && !entry.isDirectory()) continue;
      const path = `/workspace/users/${entry.name}`;
      if (path === instanceScope.home || path.startsWith(`${instanceScope.home}/`)) continue;
      excludes.push(`**/users/${entry.name}/**`);
    }
  } catch {
    // Inventory filtering remains authoritative if directory enumeration is unavailable.
  }
  return excludes;
}
