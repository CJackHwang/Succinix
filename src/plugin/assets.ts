// invariant: asset URL resolution + SHA-256 integrity (C2 wires loader hooks).
import type { ResolvedSuccinixConfig } from './config.js';

export interface AssetManifest {
  'host.js': string;
  'lifo-core.js': string;
}

export async function sha256Hex(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function assetUrls(config: ResolvedSuccinixConfig): { host: string; lifoCore: string; python: string } {
  return {
    host: config.hostJsUrl,
    lifoCore: config.lifoCoreUrl,
    python: config.pythonAssetsUrl,
  };
}
