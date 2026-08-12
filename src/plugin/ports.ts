// invariant: canonical ctx.succinix.ports service over page-level registries.
import { pagePorts } from '../engine/ports.js';
import { instancePorts } from '../instance/ports.js';
import type { SuccinixPortsService } from './types.js';

export function createPortsService(instanceId: string): SuccinixPortsService {
  const subscriptionKey = `succinix:ports:${instanceId}`;
  return {
    list: () => instancePorts.portsFor(instanceId, pagePorts.readyPorts()),
    ready: (port) => pagePorts.readyPorts().get(port),
    onServerReady: (handler) =>
      pagePorts.subscribe(subscriptionKey, {
        onServerReady: (port, url) => handler({ port, url, instanceId }),
      }),
    onServerClosed: (handler) =>
      pagePorts.subscribe(subscriptionKey, {
        onServerClosed: (port) => handler({ port, instanceId }),
      }),
  };
}

export type { SuccinixPortsService };
