// invariant: service definitions and autostart helpers for ctx.succinix.services.
import type { WebContainer as WebContainerType } from '@webcontainer/api';
import type {
  SuccinixInstance,
  SuccinixServiceAction,
  SuccinixServiceDefinition,
  SuccinixServiceState,
  SuccinixServicesService,
} from './types.js';
import {
  addServiceDef,
  disableAutostart,
  enableAutostart,
  ensureServicesFiles,
  getServiceState,
  listServiceStates,
  readAutostart,
  readServices,
  removeServiceDef,
  startService,
  stopService,
  type ServiceContext,
} from '../services/index.js';

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
    list: () => listServiceStates(context),
    read: () => readServices(context.wc.fs, context.instanceId, context.statePrefix) as Promise<SuccinixServiceDefinition[]>,
    status: async (name) => {
      const defs = await readServices(context.wc.fs, context.instanceId, context.statePrefix);
      const def = defs.find((item) => item.name === name);
      if (!def) throw new Error(`unknown service: ${name}`);
      return (await getServiceState(context, def)) as SuccinixServiceState;
    },
    start: (name) => startService(context, name) as Promise<SuccinixServiceAction>,
    stop: (name) => stopService(context, name) as Promise<SuccinixServiceAction>,
    enable: (name) => enableAutostart(context.wc.fs, name, context.instanceId, context.statePrefix),
    disable: (name) => disableAutostart(context.wc.fs, name, context.instanceId, context.statePrefix),
    add: (name, command, port) => addServiceDef(context.wc.fs, name, command, port, context.instanceId, context.statePrefix),
    remove: (name) => removeServiceDef(context.wc.fs, name, context.instanceId, context.statePrefix),
    autostart: () => readAutostart(context.wc.fs, context.instanceId, context.statePrefix),
    ensureFiles: () => ensureServicesFiles(context.wc.fs, context.instanceId, context.statePrefix),
  };
}
