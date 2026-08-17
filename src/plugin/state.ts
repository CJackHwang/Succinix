// invariant: plugin state model.

export interface SuccinixPluginState {
  version: string;
  containerMode: 'internal' | 'external';
  containerState: 'unattached' | 'booting' | 'ready' | 'disposed';
  host: { pid: number | null; startedAt: number | null };
  instances: Array<{ instanceId: string; state: 'active' | 'disposed' }>;
  capabilities: string[];
  configRevision: number;
  lastError: string | null;
}

export type SuccinixStateReason = 'boot' | 'ready' | 'instance' | 'config' | 'error' | 'shutdown';

export function createInitialState(): SuccinixPluginState {
  return {
    version: '0.7.0',
    containerMode: 'internal',
    containerState: 'unattached',
    host: { pid: null, startedAt: null },
    instances: [],
    capabilities: [],
    configRevision: 0,
    lastError: null,
  };
}

export function cloneState(state: SuccinixPluginState): SuccinixPluginState {
  return {
    ...state,
    host: { ...state.host },
    instances: state.instances.map((instance) => ({ ...instance })),
  };
}
