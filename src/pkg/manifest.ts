/** Persistent package manifest shared by Lifo tools and real npm packages.
 *
 * The manifest is deliberately metadata-only: npm keeps the actual dependency
 * tree in node_modules and Lifo keeps its package payload in the execution
 * world.  A failed install never reaches this file, and writes use a temporary
 * file followed by an atomic rename so refresh cannot observe half a record.
 */

export interface InstalledPackage {
  name: string;
  source: 'lifo' | 'npm';
  version: string;
  integrity?: string;
  installedAt: number;
  persistent: boolean;
  execution?: 'batch' | 'interactive' | 'both';
}

export interface PackageManifest {
  formatVersion: 1;
  updatedAt: number;
  packages: InstalledPackage[];
}

export interface PackageManifestFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export const PACKAGE_MANIFEST_VERSION = 1 as const;
export const PACKAGE_MANIFEST_PATH = '/etc/succinix.packages.json';

const EMPTY: PackageManifest = { formatVersion: PACKAGE_MANIFEST_VERSION, updatedAt: 0, packages: [] };

function cloneManifest(value: PackageManifest): PackageManifest {
  return { ...value, packages: value.packages.map((entry) => ({ ...entry })) };
}

function validEntry(value: unknown): value is InstalledPackage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === 'string' && item.name.length > 0 &&
    (item.source === 'lifo' || item.source === 'npm') &&
    typeof item.version === 'string' && typeof item.installedAt === 'number' &&
    typeof item.persistent === 'boolean';
}

export async function readPackageManifest(fs: PackageManifestFs, path = PACKAGE_MANIFEST_PATH): Promise<PackageManifest> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
    if (parsed.formatVersion !== PACKAGE_MANIFEST_VERSION || !Array.isArray(parsed.packages)) return cloneManifest(EMPTY);
    const packages = parsed.packages.filter(validEntry).map((item) => ({
      name: item.name,
      source: item.source,
      version: item.version,
      ...(item.integrity ? { integrity: item.integrity } : {}),
      installedAt: item.installedAt,
      persistent: item.persistent,
      ...(item.execution ? { execution: item.execution } : {}),
    }));
    return { formatVersion: PACKAGE_MANIFEST_VERSION, updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0, packages };
  } catch {
    return cloneManifest(EMPTY);
  }
}

export async function writePackageManifest(fs: PackageManifestFs, manifest: PackageManifest, path = PACKAGE_MANIFEST_PATH): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf('/')) || '/';
  await fs.mkdir(parent, { recursive: true });
  const next: PackageManifest = {
    formatVersion: PACKAGE_MANIFEST_VERSION,
    updatedAt: Date.now(),
    packages: manifest.packages.map((entry) => ({ ...entry })),
  };
  const temp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(temp, JSON.stringify(next, null, 2) + '\n');
  await fs.rename(temp, path);
}

export async function recordPackageInstall(
  fs: PackageManifestFs,
  entry: Omit<InstalledPackage, 'installedAt' | 'persistent'> & Partial<Pick<InstalledPackage, 'installedAt' | 'persistent'>>,
  path = PACKAGE_MANIFEST_PATH,
): Promise<PackageManifest> {
  const manifest = await readPackageManifest(fs, path);
  const next: InstalledPackage = {
    ...entry,
    installedAt: entry.installedAt ?? Date.now(),
    persistent: entry.persistent ?? true,
  };
  const index = manifest.packages.findIndex((item) => item.name === next.name && item.source === next.source);
  if (index >= 0) manifest.packages[index] = next;
  else manifest.packages.push(next);
  await writePackageManifest(fs, manifest, path);
  return readPackageManifest(fs, path);
}

export async function recordPackageRemove(
  fs: PackageManifestFs,
  name: string,
  source?: InstalledPackage['source'],
  path = PACKAGE_MANIFEST_PATH,
): Promise<PackageManifest> {
  const manifest = await readPackageManifest(fs, path);
  manifest.packages = manifest.packages.filter((item) => item.name !== name || (source !== undefined && item.source !== source));
  await writePackageManifest(fs, manifest, path);
  return readPackageManifest(fs, path);
}

export function packageManifestJson(manifest: PackageManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}
