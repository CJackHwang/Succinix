import { describe, expect, it } from 'vitest';
import {
  addExecutionService,
  disableExecutionService,
  enableExecutionService,
  executionAutostart,
  executionServiceState,
  listExecutionServiceStates,
  removeExecutionService,
  startExecutionService,
  stopExecutionService,
} from '../src/services/world-client.js';
import { instancePorts } from '../src/instance/ports.js';
import * as engineApi from '@succinix/engine';
import type { ServiceContext } from '../src/services/types.js';

describe('execution-world services client', () => {
  it('does not expose the retired browser-side service lifecycle', () => {
    for (const name of [
      'addServiceDef',
      'clearActivePorts',
      'disableAutostart',
      'enableAutostart',
      'ensureServicesFiles',
      'getServiceState',
      'listServiceStates',
      'readAutostart',
      'readServices',
      'removeServiceDef',
      'restartService',
      'startService',
      'stopService',
    ]) {
      expect(engineApi).not.toHaveProperty(name);
    }
  });

  it('uses only succinix service commands for definitions, state, and enablement', async () => {
    const calls: string[] = [];
    let enabled = false;
    let running = false;
    let exists = true;
    const unit = () => ({
      name: 'api', command: 'node server.js', port: 4321, description: 'API', enabled,
      state: running ? 'running' : 'stopped', ...(running ? { pid: 42 } : {}),
    });
    const client = {
      terminal: async (command: string) => {
        calls.push(command);
        if (command.includes("'inspect'")) {
          const named = command.includes("'api'");
          return { ok: true, stdout: JSON.stringify(named ? (exists ? unit() : null) : (exists ? [unit()] : [])) };
        }
        if (command.includes("'start'")) running = true;
        if (command.includes("'enable'")) enabled = true;
        if (command.includes("'disable'")) enabled = false;
        if (command.includes("'remove'")) exists = false;
        return { ok: true, stdout: 'ok\n' };
      },
    };
    const context = { wc: {} as ServiceContext['wc'], client, ports: new Map([[4321, 'https://api.preview']]) } as unknown as ServiceContext;

    expect((await listExecutionServiceStates(context))[0]).toMatchObject({ state: 'stopped', effectivePort: 4321 });
    expect(await startExecutionService(context, 'api')).toMatchObject({ ok: true, pid: 42, port: 4321 });
    expect(await executionServiceState(context, 'api')).toMatchObject({ state: 'running', url: 'https://api.preview' });
    expect(await enableExecutionService(context, 'api')).toBe(true);
    expect(await executionAutostart(context)).toEqual(['api']);
    await addExecutionService(context, 'worker', 'node worker.js', null);
    expect(await disableExecutionService(context, 'api')).toBe(true);
    expect(await removeExecutionService(context, 'api')).toBe(true);
    expect(calls).toHaveLength(calls.filter((command) => command.startsWith('succinix service ')).length);
    expect(calls.some((command) => command.includes("'add'"))).toBe(true);
  });

  it('claims an instance port before start and releases it after stop', async () => {
    instancePorts.clear();
    let running = false;
    const client = {
      terminal: async (command: string) => {
        if (command.includes("'inspect'")) {
          return {
            ok: true,
            stdout: JSON.stringify({
              name: 'api', command: 'node server.js', port: 4321, description: 'API', enabled: false,
              state: running ? 'running' : 'stopped',
            }),
          };
        }
        if (command.includes("'start'")) {
          expect(instancePorts.expects('demo', 4321)).toBe(true);
          running = true;
        }
        if (command.includes("'stop'")) running = false;
        return { ok: true, stdout: 'ok\n' };
      },
    };
    const context = {
      wc: {} as ServiceContext['wc'],
      client,
      ports: new Map([[4321, 'https://api.preview']]),
      instanceId: 'demo',
    } as unknown as ServiceContext;

    await startExecutionService(context, 'api');
    expect(instancePorts.expectedFor('demo')).toEqual([4321]);
    await stopExecutionService(context, 'api');
    expect(instancePorts.expectedFor('demo')).toEqual([]);
    expect(context.ports.has(4321)).toBe(false);
  });
});
