// Browser control-plane handshake shared by the WebContainer host and page.
// The payload intentionally contains only fixed management actions; it is not
// a terminal-command protocol and cannot be used to evaluate shell text.

export const CONTROL_PROTOCOL_VERSION = 1 as const;
export const CONTROL_REQUEST_ROOT = '/.succinix-control';
export const CONTROL_DEFAULT_TIMEOUT_MS = 30_000;

export type BrowserControlAction = 'snapshot' | 'reboot' | 'status' | 'plugins' | 'ports' | 'environment';

export interface BrowserControlRequest {
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  requestId: string;
  action: BrowserControlAction;
  instanceId: string;
  args?: Record<string, unknown>;
  requestedAt: number;
  expiresAt: number;
}

export interface BrowserControlResponse {
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  completedAt: number;
  data?: unknown;
  error?: string;
}

const CONTROL_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function controlRequestFile(requestId: string): string {
  assertControlRequestId(requestId);
  return `${CONTROL_REQUEST_ROOT}/request-${requestId}.json`;
}

export function controlResponseFile(requestId: string): string {
  assertControlRequestId(requestId);
  return `${CONTROL_REQUEST_ROOT}/response-${requestId}.json`;
}

export function controlRequestIdFromFile(name: string): string | null {
  const match = /^request-([A-Za-z0-9._-]{1,128})\.json$/.exec(name);
  return match?.[1] ?? null;
}

export function createControlRequestId(now = Date.now, random = Math.random): string {
  return `control-${now().toString(36)}-${Math.floor(random() * 0x1_0000_0000).toString(36)}`;
}

export function isBrowserControlAction(value: unknown): value is BrowserControlAction {
  return value === 'snapshot' || value === 'reboot' || value === 'status' || value === 'plugins' || value === 'ports' || value === 'environment';
}

export function isBrowserControlRequest(value: unknown): value is BrowserControlRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<BrowserControlRequest>;
  return request.protocolVersion === CONTROL_PROTOCOL_VERSION &&
    typeof request.requestId === 'string' && CONTROL_ID_RE.test(request.requestId) &&
    isBrowserControlAction(request.action) &&
    typeof request.instanceId === 'string' && request.instanceId.length > 0 && request.instanceId.length <= 128 &&
    (request.args === undefined || (typeof request.args === 'object' && request.args !== null && !Array.isArray(request.args))) &&
    typeof request.requestedAt === 'number' && Number.isFinite(request.requestedAt) &&
    typeof request.expiresAt === 'number' && Number.isFinite(request.expiresAt) && request.expiresAt >= request.requestedAt;
}

export function isBrowserControlResponse(value: unknown): value is BrowserControlResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<BrowserControlResponse>;
  return response.protocolVersion === CONTROL_PROTOCOL_VERSION &&
    typeof response.requestId === 'string' && CONTROL_ID_RE.test(response.requestId) &&
    typeof response.ok === 'boolean' &&
    typeof response.completedAt === 'number' && Number.isFinite(response.completedAt) &&
    (response.error === undefined || typeof response.error === 'string');
}

function assertControlRequestId(requestId: string): void {
  if (!CONTROL_ID_RE.test(requestId)) throw new Error('invalid browser control request id');
}
