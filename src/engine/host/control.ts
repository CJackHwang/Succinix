// Host half of the browser control-plane handshake. Browser-only capabilities
// such as persistence and preview URLs stay outside WebContainer; the host
// requests one typed action and waits for its matched result.
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTROL_DEFAULT_TIMEOUT_MS,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_REQUEST_ROOT,
  controlRequestFile,
  controlResponseFile,
  createControlRequestId,
  type BrowserControlAction,
  type BrowserControlRequest,
  type BrowserControlResponse,
} from '../control-protocol.js';

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
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { requestId?: unknown };
    if (parsed.requestId === requestId) fs.unlinkSync(file);
  } catch {
    /* absent, partial, or unrelated files are not ours to remove */
  }
}

export interface BrowserControlOptions {
  timeoutMs?: number;
  args?: Record<string, unknown>;
}

/** Request one browser-only management action without creating browser shell state. */
export async function requestBrowserControl(
  action: BrowserControlAction,
  instanceId: string,
  options: BrowserControlOptions = {},
): Promise<unknown> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? CONTROL_DEFAULT_TIMEOUT_MS);
  const requestId = createControlRequestId();
  const requestFile = hostPath(controlRequestFile(requestId));
  const responseFile = hostPath(controlResponseFile(requestId));
  const requestedAt = Date.now();
  const request: BrowserControlRequest = {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    requestId,
    action,
    instanceId,
    ...(options.args === undefined ? {} : { args: options.args }),
    requestedAt,
    expiresAt: requestedAt + timeoutMs,
  };
  fs.mkdirSync(hostPath(CONTROL_REQUEST_ROOT), { recursive: true });
  try {
    atomicJson(requestFile, request);
    const deadline = request.expiresAt;
    while (Date.now() <= deadline) {
      try {
        const response = JSON.parse(fs.readFileSync(responseFile, 'utf8')) as BrowserControlResponse;
        if (response.protocolVersion === CONTROL_PROTOCOL_VERSION && response.requestId === requestId) {
          if (!response.ok) throw new Error(`browser control ${action} failed: ${response.error ?? 'unknown error'}`);
          return response.data;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(`browser control ${action} failed:`)) throw error;
      }
      await pause(25);
    }
    throw new Error(`browser control ${action} timed out after ${timeoutMs}ms`);
  } finally {
    removeIfRequestMatches(requestFile, requestId);
    removeIfRequestMatches(responseFile, requestId);
  }
}
