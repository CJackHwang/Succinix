import type { FileSystemAPI } from '@webcontainer/api';
import { BinarySnapshotCorruptionError, type BinarySnapshotManifest } from './binary-v2.js';
import { listSnapshotTreePaths, removeStaleSnapshotPaths } from './snapshot-tree.js';
import type { BinarySnapshotContainer } from './types.js';

export interface VerifiedBinaryRestoreOptions {
  container: BinarySnapshotContainer;
  restoreFs: FileSystemAPI;
  scopeRoot: string;
  exportRoot: string;
  exportOptions: () => { format: 'binary'; excludes: string[] };
  shouldSkip: (path: string) => boolean;
}

function restoreStageRoot(scopeRoot: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return scopeRoot === '/' ? `/.succinix-restore-stage-${suffix}` : `${scopeRoot}/.succinix-restore-stage-${suffix}`;
}

function stagedManifest(manifest: BinarySnapshotManifest, stageRoot: string, scopeRoot: string): BinarySnapshotManifest {
  const files = manifest.filePaths;
  if (!files) throw new BinarySnapshotCorruptionError('snapshot inventory is missing');
  const mapPath = (path: string): string => {
    if (path === scopeRoot) return stageRoot;
    if (scopeRoot === '/') return `${stageRoot}${path}`;
    if (!path.startsWith(`${scopeRoot}/`)) throw new BinarySnapshotCorruptionError('snapshot inventory escapes its workspace root');
    return `${stageRoot}${path.slice(scopeRoot.length)}`;
  };
  return {
    ...manifest,
    workspaceRoot: stageRoot,
    filePaths: files.map(mapPath),
    emptyDirs: (manifest.emptyDirs ?? []).map(mapPath),
  };
}

function isGeneratedStagePath(path: string, stageRoot: string): boolean {
  if (path === stageRoot || !path.startsWith(`${stageRoot}/`)) return false;
  return path.slice(stageRoot.length + 1).split('/').some((segment) => segment.startsWith('.succinix-'));
}

async function removeTree(fs: FileSystemAPI, path: string): Promise<void> {
  try { await fs.rm(path, { recursive: true, force: true }); } catch { /* 临时导入目录清理失败不应掩盖原始恢复错误 */ }
}

export async function importVerifiedBinary(
  data: Uint8Array,
  manifest: BinarySnapshotManifest,
  options: VerifiedBinaryRestoreOptions,
): Promise<void> {
  const { container, restoreFs, scopeRoot, exportRoot, exportOptions, shouldSkip } = options;
  const stageRoot = restoreStageRoot(scopeRoot);
  const staged = stagedManifest(manifest, stageRoot, scopeRoot);
  try {
    await restoreFs.mkdir(stageRoot, { recursive: true });
    await container.mount(data.slice(), { mountPoint: stageRoot });
    const actual = await listSnapshotTreePaths(restoreFs, stageRoot, () => false);
    const expected = [...(staged.filePaths ?? [])].sort();
    const actualFiles = actual.files.filter((path) => !isGeneratedStagePath(path, stageRoot)).sort();
    if (actualFiles.join('\u0000') !== expected.join('\u0000')) {
      const missing = expected.find((path) => !actualFiles.includes(path));
      const unexpected = actualFiles.find((path) => !expected.includes(path));
      throw new BinarySnapshotCorruptionError(
        `snapshot import inventory does not match its manifest${missing ? `; missing ${missing}` : ''}${unexpected ? `; unexpected ${unexpected}` : ''}`,
      );
    }
    if (manifest.emptyDirs !== undefined) {
      const expectedEmptyDirs = [...(staged.emptyDirs ?? [])].sort();
      const actualEmptyDirs = actual.emptyDirs
        .filter((path) => !isGeneratedStagePath(path, stageRoot))
        .filter((path) => path !== stageRoot || expectedEmptyDirs.includes(stageRoot))
        .sort();
      if (actualEmptyDirs.join('\u0000') !== expectedEmptyDirs.join('\u0000')) {
        const missing = expectedEmptyDirs.find((path) => !actualEmptyDirs.includes(path));
        const unexpected = actualEmptyDirs.find((path) => !expectedEmptyDirs.includes(path));
        throw new BinarySnapshotCorruptionError(
          `snapshot import empty-directory inventory does not match its manifest${missing ? `; missing ${missing}` : ''}${unexpected ? `; unexpected ${unexpected}` : ''}`,
        );
      }
    }

    const beforeData = await container.export(exportRoot, exportOptions());
    const before = await listSnapshotTreePaths(restoreFs, scopeRoot, shouldSkip);
    const beforeManifest = { ...manifest, filePaths: before.files, emptyDirs: before.dirs };
    try {
      await container.mount(data, { mountPoint: scopeRoot });
      await removeStaleSnapshotPaths(restoreFs, scopeRoot, shouldSkip, manifest);
    } catch (error) {
      try {
        await container.mount(beforeData, { mountPoint: scopeRoot });
        await removeStaleSnapshotPaths(restoreFs, scopeRoot, shouldSkip, beforeManifest);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'snapshot restore and rollback both failed', { cause: rollbackError });
      }
      throw error;
    }
  } finally {
    await removeTree(restoreFs, stageRoot);
  }
}
