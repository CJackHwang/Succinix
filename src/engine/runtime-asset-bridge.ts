import type { WebContainer } from '@webcontainer/api';
import { ensureRubyRuntime } from './ruby-assets.js';
import {
  RUBY_ERROR_FILE,
  RUBY_READY_FILE,
  RUBY_REQUEST_FILE,
  RUNTIME_REQUEST_ROOT,
  type RubyAssetRequest,
} from './ruby-protocol.js';

export { RUNTIME_REQUEST_ROOT } from './ruby-protocol.js';

export interface RuntimeAssetBridgeOptions {
  rubyAssetsUrl?: string;
  pollMs?: number;
  onError?: (runtime: string, error: unknown) => void;
}

export interface RuntimeAssetBridgeController {
  stop(): void;
  running(): boolean;
}

/**
 * Thin browser capability bridge for deferred assets.  Host-side userland
 * commands post a file request; this controller only fetches bytes using the
 * browser and writes them into WebContainer.  It never parses terminal input
 * or implements runtime/command semantics outside the execution world.
 */
export function startRuntimeAssetBridge(
  wc: WebContainer,
  options: RuntimeAssetBridgeOptions = {},
): RuntimeAssetBridgeController {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rubyLoading: Promise<void> | null = null;
  const pollMs = Math.max(16, options.pollMs ?? 100);

  const schedule = () => {
    if (active) timer = setTimeout(() => { void poll(); }, pollMs);
  };
  const poll = async () => {
    if (!active) return;
    try {
      const request = JSON.parse(await wc.fs.readFile(RUBY_REQUEST_FILE, 'utf8')) as Partial<RubyAssetRequest>;
      if (request.protocolVersion !== 1 || typeof request.requestId !== 'string' || !request.requestId) {
        throw new Error('invalid Ruby runtime request');
      }
      if (!rubyLoading) {
        rubyLoading = completeRubyRequest(request as RubyAssetRequest)
          .finally(() => { rubyLoading = null; });
      }
    } catch (error) {
      // ENOENT means the normal idle state.  Other errors are diagnostics for
      // the browser capability bridge, never a replacement command handler.
      if (!(error instanceof Error && /ENOENT|not found/i.test(error.message))) {
        options.onError?.('ruby', error);
      }
    }
    schedule();
  };

  const completeRubyRequest = async (request: RubyAssetRequest): Promise<void> => {
    try {
      await wc.fs.rm(RUBY_READY_FILE).catch(() => {});
      await wc.fs.rm(RUBY_ERROR_FILE).catch(() => {});
      await ensureRubyRuntime(wc, options.rubyAssetsUrl);
      await wc.fs.writeFile(RUBY_READY_FILE, JSON.stringify({
        protocolVersion: 1,
        requestId: request.requestId,
        loadedAt: Date.now(),
      }));
    } catch (error) {
      options.onError?.('ruby', error);
      try {
        await wc.fs.writeFile(RUBY_ERROR_FILE, JSON.stringify({
          protocolVersion: 1,
          requestId: request.requestId,
          failedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }));
      } catch {
        /* host timeout remains authoritative */
      }
    } finally {
      // The completion marker is durable long enough for the host to consume;
      // deleting the request prevents a completed handshake from retriggering.
      try { await wc.fs.rm(RUBY_REQUEST_FILE); } catch { /* best effort */ }
    }
  };
  void wc.fs.mkdir(RUNTIME_REQUEST_ROOT, { recursive: true }).then(poll, schedule);
  return {
    stop() {
      active = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    running: () => active,
  };
}
