import { describe, expect, it, vi } from 'vitest';
import { FakeFS } from './helpers/fakes.js';
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_REQUEST_ROOT,
  controlRequestFile,
  controlResponseFile,
  isBrowserControlRequest,
} from '../src/engine/control-protocol.js';
import { startBrowserControlBridge } from '../src/engine/browser-control-bridge.js';

function request(action: 'snapshot' | 'reboot' | 'status' | 'plugins' | 'ports' | 'environment', expiresAt = Date.now() + 1_000) {
  return {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    requestId: 'control-test',
    action,
    instanceId: 'default',
    requestedAt: Date.now(),
    expiresAt,
  };
}

describe('browser control bridge', () => {
  it('accepts only the typed management action protocol', () => {
    expect(isBrowserControlRequest(request('snapshot'))).toBe(true);
    expect(isBrowserControlRequest({ ...request('snapshot'), action: 'run-shell' })).toBe(false);
    expect(isBrowserControlRequest({ ...request('snapshot'), args: 'echo unsafe' })).toBe(false);
  });

  it('executes a fixed action once, writes a matched response, and removes the request', async () => {
    const fs = new FakeFS();
    await fs.mkdir(CONTROL_REQUEST_ROOT, { recursive: true });
    await fs.writeFile(controlRequestFile('control-test'), JSON.stringify(request('snapshot')));
    const snapshot = vi.fn(async () => ({ saved: true }));
    const bridge = startBrowserControlBridge({ fs } as never, {
      handlers: {
        snapshot,
        reboot: () => ({ scheduled: true }),
        status: () => ({}),
        plugins: () => ({}),
        ports: () => ({}),
        environment: () => ({ written: true }),
      },
      pollMs: 16,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    bridge.stop();

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(fs.has(controlRequestFile('control-test'))).toBe(false);
    const response = JSON.parse(String(fs.raw(controlResponseFile('control-test'))));
    expect(response).toMatchObject({ protocolVersion: 1, requestId: 'control-test', ok: true, data: { saved: true } });
  });

  it('drops expired requests without invoking their action', async () => {
    const fs = new FakeFS();
    await fs.mkdir(CONTROL_REQUEST_ROOT, { recursive: true });
    await fs.writeFile(controlRequestFile('control-test'), JSON.stringify(request('reboot', Date.now() - 1)));
    const reboot = vi.fn(() => ({ scheduled: true }));
    const bridge = startBrowserControlBridge({ fs } as never, {
      handlers: { snapshot: () => ({}), reboot, status: () => ({}), plugins: () => ({}), ports: () => ({}), environment: () => ({ written: true }) },
      pollMs: 16,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    bridge.stop();

    expect(reboot).not.toHaveBeenCalled();
    expect(fs.has(controlRequestFile('control-test'))).toBe(false);
    expect(fs.has(controlResponseFile('control-test'))).toBe(false);
  });
});
