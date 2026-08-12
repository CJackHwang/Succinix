// invariant: asset URL resolution + SHA-256 integrity (C2 wires loader hooks).
import type { FileSystemAPI } from '@webcontainer/api';
import type { ResolvedSuccinixConfig } from './config.js';
import { invariantObject } from './invariant.js';

export interface AssetManifest {
  'host.js': string;
  'lifo-core.js': string;
}

export async function sha256Hex(source: string | Uint8Array): Promise<string> {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : Uint8Array.from(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function assetUrls(config: ResolvedSuccinixConfig): { host: string; lifoCore: string; python: string } {
  return {
    host: config.hostJsUrl,
    lifoCore: config.lifoCoreUrl,
    python: config.pythonAssetsUrl,
  };
}

export interface AssetInjectOptions {
  integrity?: boolean;
  manifest?: AssetManifest;
  manifestUrl?: string;
}

export async function loadAssetManifest(url = '/assets/sha256.json'): Promise<AssetManifest> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`asset manifest fetch failed: ${url} (HTTP ${response.status})`);
  const manifest = (await response.json()) as unknown;
  invariantObject(manifest, 'asset manifest');
  const record = manifest as Partial<AssetManifest>;
  if (typeof record['host.js'] !== 'string' || typeof record['lifo-core.js'] !== 'string') {
    throw new Error(`asset manifest is missing host.js/lifo-core.js: ${url}`);
  }
  return { 'host.js': record['host.js'], 'lifo-core.js': record['lifo-core.js'] };
}

async function verifySha(source: string | Uint8Array, expectedSha: string | undefined, label: string): Promise<string | Uint8Array> {
  if (expectedSha && (await sha256Hex(source)) !== expectedSha) {
    throw new Error(`asset integrity check failed: ${label}`);
  }
  return source;
}

export async function fetchAssetText(url: string, expectedSha?: string, integrity = true): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`asset fetch failed: ${url} (HTTP ${response.status})`);
  const source = await response.text();
  return (await verifySha(source, integrity ? expectedSha : undefined, url)) as string;
}

async function fetchAssetBinary(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`asset fetch failed: ${url} (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function assetExists(fs: FileSystemAPI, path: string): Promise<boolean> {
  try {
    await fs.readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAsset(fs: FileSystemAPI, path: string, data: string | Uint8Array): Promise<void> {
  const idx = path.lastIndexOf('/');
  if (idx > 0) await fs.mkdir(path.slice(0, idx), { recursive: true });
  await fs.writeFile(path, data);
}

export async function injectAssetOnce(
  fs: FileSystemAPI,
  path: string,
  url: string,
  expectedSha?: string,
  integrity = true
): Promise<boolean> {
  if (await assetExists(fs, path)) return false;
  const source = await fetchAssetText(url, expectedSha, integrity);
  await writeAsset(fs, path, source);
  return true;
}

export async function injectHostAssets(
  fs: FileSystemAPI,
  config: ResolvedSuccinixConfig,
  options: AssetInjectOptions = {}
): Promise<{ host: boolean; lifoCore: boolean }> {
  const integrity = options.integrity ?? config.assets.integrity;
  let manifest: AssetManifest | undefined = options.manifest;
  if (!manifest && integrity && options.manifestUrl) manifest = await loadAssetManifest(options.manifestUrl);
  const host = await injectAssetOnce(fs, '/host.js', config.hostJsUrl, manifest?.['host.js'], integrity);
  const lifoCore = await injectAssetOnce(fs, '/lifo-core.js', config.lifoCoreUrl, manifest?.['lifo-core.js'], integrity);
  return { host, lifoCore };
}

const PYTHON_ASSETS = [
  'python-daemon.js',
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
] as const;

export async function injectPythonAssets(
  fs: FileSystemAPI,
  config: ResolvedSuccinixConfig
): Promise<string[]> {
  const base = config.pythonAssetsUrl.replace(/\/+$/, '');
  const written: string[] = [];
  for (const file of PYTHON_ASSETS) {
    const path = `/usr/lib/succinix/python/${file}`;
    if (await assetExists(fs, path)) continue;
    const data = await fetchAssetBinary(`${base}/${file}`);
    await writeAsset(fs, path, data);
    written.push(path);
  }
  return written;
}
