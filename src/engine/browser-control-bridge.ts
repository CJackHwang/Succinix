import type { WebContainer } from '@webcontainer/api';
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_REQUEST_ROOT,
  controlRequestFile,
  controlRequestIdFromFile,
  controlResponseFile,
  isBrowserControlRequest,
  type BrowserControlAction,
  type BrowserControlRequest,
  type BrowserControlResponse,
} from './control-protocol.js';

export interface BrowserControlBridgeHandlers {
  snapshot(request: BrowserControlRequest): Promise<unknown> | unknown;
  reboot(request: BrowserControlRequest): Promise<unknown> | unknown;
  status(request: BrowserControlRequest): Promise<unknown> | unknown;
  plugins(request: BrowserControlRequest): Promise<unknown> | unknown;
  ports(request: BrowserControlRequest): Promise<unknown> | unknown;
  environment(request: BrowserControlRequest): Promise<unknown> | unknown;
}

export interface BrowserControlBridgeOptions {
  handlers: BrowserControlBridgeHandlers;
  pollMs?: number;
  onError?: (action: BrowserControlAction, error: unknown) => void;
}

export interface BrowserControlBridgeController {
  stop(): void;
  running(): boolean;
}

/**
 * Browser device/control plane for a fixed set of browser-only capabilities.
 * It transports typed requests through the WebContainer filesystem but never
 * receives terminal text or owns command, filesystem, or process semantics.
 */
export function startBrowserControlBridge(
  wc: WebContainer,
  options: BrowserControlBridgeOptions,
): BrowserControlBridgeController {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  const pollMs = Math.max(16, options.pollMs ?? 50);

  const schedule = () => {
    if (active) timer = setTimeout(() => { void poll(); }, pollMs);
  };
  const poll = async () => {
    if (!active || polling) return;
    polling = true;
    try {
      const entries = await wc.fs.readdir(CONTROL_REQUEST_ROOT, { withFileTypes: true });
      const names = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => controlRequestIdFromFile(name) !== null)
        .sort();
      for (const name of names) {
        if (!active) return;
        await completeRequest(wc, name, options);
      }
    } catch (error) {
      // ENOENT only occurs during startup/teardown. Other failures remain
      // diagnostics; the host-side timeout stays the command contract.
      if (!(error instanceof Error && /ENOENT|not found/i.test(error.message))) {
        options.onError?.('status', error);
      }
    } finally {
      polling = false;
      schedule();
    }
  };

  void wc.fs.mkdir(CONTROL_REQUEST_ROOT, { recursive: true }).then(poll, schedule);
  return {
    stop() {
      active = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    running: () => active,
  };
}

async function completeRequest(
  wc: WebContainer,
  name: string,
  options: BrowserControlBridgeOptions,
): Promise<void> {
  const requestId = controlRequestIdFromFile(name);
  if (!requestId) return;
  const requestFile = controlRequestFile(requestId);
  let request: BrowserControlRequest;
  try {
    const value = JSON.parse(await wc.fs.readFile(requestFile, 'utf8')) as unknown;
    if (!isBrowserControlRequest(value) || value.requestId !== requestId) {
      throw new Error('invalid browser control request');
    }
    request = value;
  } catch (error) {
    try { await wc.fs.rm(requestFile); } catch { /* malformed requests are disposable */ }
    options.onError?.('status', error);
    return;
  }

  // A delayed browser must never execute a completed host command, especially
  // a reboot. The requester owns cleanup after its timeout; this is a second
  // guard for requests discovered after that cleanup window.
  if (Date.now() > request.expiresAt) {
    try { await wc.fs.rm(requestFile); } catch { /* stale request is already gone */ }
    return;
  }

  let response: BrowserControlResponse;
  try {
    const data = await options.handlers[request.action](request);
    response = {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      requestId,
      ok: true,
      completedAt: Date.now(),
      ...(data === undefined ? {} : { data }),
    };
  } catch (error) {
    options.onError?.(request.action, error);
    response = {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      requestId,
      ok: false,
      completedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    await wc.fs.writeFile(controlResponseFile(requestId), JSON.stringify(response));
  } finally {
    // The matching response remains for the host to consume. Request removal
    // prevents a successful operation from being replayed on later polls.
    try { await wc.fs.rm(requestFile); } catch { /* host timeout may have removed it */ }
  }
}
