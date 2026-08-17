// Host half of the deferred Ruby asset handshake.  Ruby bytes can only be
// fetched by the browser, while command semantics stay in WebContainer.
import fs from 'node:fs';
import path from 'node:path';
import {
  RUBY_ASSET_TIMEOUT_MS,
  RUBY_ERROR_FILE,
  RUBY_READY_FILE,
  RUBY_REQUEST_FILE,
  RUNTIME_REQUEST_ROOT,
  createRubyRequestId,
  type RubyAssetError,
  type RubyAssetReady,
} from '../ruby-protocol.js';

function hostPath(webPath: string): string {
  return path.join(process.cwd(), webPath.replace(/^\/+/, ''));
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

function removeIfRequestMatches(file: string, requestId: string): void {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { requestId?: unknown };
    if (value.requestId === requestId) fs.unlinkSync(file);
  } catch {
    /* absent/partial markers are not ours to remove */
  }
}

/** Wait for browser-side asset injection and clean handshake markers. */
export async function requestRubyRuntime(timeoutMs = RUBY_ASSET_TIMEOUT_MS): Promise<void> {
  const root = hostPath(RUNTIME_REQUEST_ROOT);
  const requestFile = hostPath(RUBY_REQUEST_FILE);
  const readyFile = hostPath(RUBY_READY_FILE);
  const errorFile = hostPath(RUBY_ERROR_FILE);
  const requestId = createRubyRequestId();
  fs.mkdirSync(root, { recursive: true });
  try {
    // Never accept a ready/error marker left by a previous host boot.
    try { fs.unlinkSync(readyFile); } catch { /* no prior marker */ }
    try { fs.unlinkSync(errorFile); } catch { /* no prior marker */ }
    atomicJson(requestFile, { protocolVersion: 1, requestId, requestedAt: Date.now() });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      try {
        const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as Partial<RubyAssetReady>;
        if (ready.protocolVersion === 1 && ready.requestId === requestId && typeof ready.loadedAt === 'number') return;
      } catch {
        /* not ready */
      }
      try {
        const failure = JSON.parse(fs.readFileSync(errorFile, 'utf8')) as Partial<RubyAssetError>;
        if (failure.protocolVersion === 1 && failure.requestId === requestId) {
          throw new Error(`ruby runtime asset injection failed: ${String(failure.error ?? 'unknown browser error')}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('ruby runtime asset injection failed:')) throw error;
      }
      await pause(50);
    }
    throw new Error(`ruby runtime asset request timed out after ${timeoutMs}ms`);
  } finally {
    removeIfRequestMatches(requestFile, requestId);
    removeIfRequestMatches(readyFile, requestId);
    removeIfRequestMatches(errorFile, requestId);
  }
}
