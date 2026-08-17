// invariant: service definitions and autostart helpers for the app host seam.
import type { WebContainer as WebContainerType } from '@webcontainer/api';
import type {
  SuccinixInstance,
  SuccinixServiceAction,
  SuccinixServiceDefinition,
  SuccinixServiceState,
  SuccinixServicesService,
} from './types.js';
import {
  addExecutionService,
  disableExecutionService,
  enableExecutionService,
  ensureExecutionServices,
  executionAutostart,
  executionServiceState,
  listExecutionServiceStates,
  readExecutionServices,
  removeExecutionService,
  restartExecutionService,
  startExecutionService,
  stopExecutionService,
} from '../services/world-client.js';
import type { ServiceContext } from '../services/types.js';

export function makeServicesService(
  instance: Pick<SuccinixInstance, 'client' | 'ports' | 'instanceId' | 'statePrefix'>,
  wc: WebContainerType
): SuccinixServicesService {
  const context: ServiceContext = {
    wc,
    client: instance.client,
    ports: instance.ports,
    instanceId: instance.instanceId,
    statePrefix: instance.statePrefix,
  };
  return {
    list: () => listExecutionServiceStates(context) as Promise<SuccinixServiceState[]>,
    read: () => readExecutionServices(context) as Promise<SuccinixServiceDefinition[]>,
    status: (name) => executionServiceState(context, name) as Promise<SuccinixServiceState>,
    start: (name) => startExecutionService(context, name) as Promise<SuccinixServiceAction>,
    stop: (name) => stopExecutionService(context, name) as Promise<SuccinixServiceAction>,
    restart: (name) => restartExecutionService(context, name) as Promise<SuccinixServiceAction>,
    enable: (name) => enableExecutionService(context, name),
    disable: (name) => disableExecutionService(context, name),
    add: (name, command, port) => addExecutionService(context, name, command, port),
    remove: (name) => removeExecutionService(context, name),
    autostart: () => executionAutostart(context),
    ensureFiles: () => ensureExecutionServices(context),
  };
}
