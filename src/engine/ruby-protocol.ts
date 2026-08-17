// Deferred Ruby asset handshake shared by the browser device plane and the
// WebContainer host.  It contains no browser or Node APIs by design.

export const RUNTIME_REQUEST_ROOT = '/.succinix-runtime';
export const RUBY_REQUEST_FILE = `${RUNTIME_REQUEST_ROOT}/ruby.request.json`;
export const RUBY_READY_FILE = `${RUNTIME_REQUEST_ROOT}/ruby.ready.json`;
export const RUBY_ERROR_FILE = `${RUNTIME_REQUEST_ROOT}/ruby.error.json`;
export const RUBY_ASSET_TIMEOUT_MS = 150_000;

export interface RubyAssetRequest {
  protocolVersion: 1;
  requestId: string;
  requestedAt: number;
}

export interface RubyAssetReady {
  protocolVersion: 1;
  requestId: string;
  loadedAt: number;
}

export interface RubyAssetError {
  protocolVersion: 1;
  requestId: string;
  failedAt: number;
  error: string;
}

export function createRubyRequestId(now = Date.now, random = Math.random): string {
  return `ruby-${now().toString(36)}-${Math.floor(random() * 0x1_0000_0000).toString(36)}`;
}
