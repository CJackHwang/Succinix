// invariant: synchronous Succinix plugin configuration schema.
import {
  isArrayOf,
  isBoolean,
  isEnum,
  isIntegerRange,
  isString,
  objectSchema,
  optional,
  type Schema,
} from './schema.js';

export interface SuccinixConfig {
  hostJsUrl?: string;
  lifoCoreUrl?: string;
  pythonAssetsUrl?: string;
  rubyAssetsUrl?: string;
  resultTtlMs?: number;
  container?: {
    mode?: 'internal' | 'external';
    bootRetries?: number;
    bootIntervalMs?: number;
    hostReadyDeadlineMs?: number;
  };
  defaultInstance?: {
    instanceId?: string;
    statePrefix?: string;
    home?: string;
    persistence?: { dbName?: string; storeKey?: string; includeGit?: boolean };
  };
  capabilities?: {
    defaultAllow?: boolean;
    rules?: Array<{ pattern: string; allow: boolean }>;
  };
  lifecycle?: {
    disposeMode?: 'soft' | 'hard';
    flushOnPageHide?: boolean;
  };
  assets?: {
    integrity?: boolean;
  };
}

export interface ResolvedSuccinixConfig {
  hostJsUrl: string;
  lifoCoreUrl: string;
  pythonAssetsUrl: string;
  rubyAssetsUrl: string;
  resultTtlMs: number;
  container: {
    mode: 'internal' | 'external';
    bootRetries: number;
    bootIntervalMs: number;
    hostReadyDeadlineMs: number;
  };
  defaultInstance: {
    instanceId: string;
    statePrefix?: string;
    home?: string;
    persistence?: { dbName?: string; storeKey?: string; includeGit?: boolean };
  };
  capabilities: {
    defaultAllow: boolean;
    rules: Array<{ pattern: string; allow: boolean }>;
  };
  lifecycle: {
    disposeMode: 'soft' | 'hard';
    flushOnPageHide: boolean;
  };
  assets: {
    integrity: boolean;
  };
}

export const CAPABILITY_PATTERNS = [
  'terminal.exec',
  'terminal.spawn',
  'terminal.kill',
  'terminal.interrupt',
  'fs.read',
  'fs.write',
  'workspace.restore',
  'workspace.flush',
  'workspace.list',
] as const;

export type SuccinixCapabilityPattern = (typeof CAPABILITY_PATTERNS)[number];

function ruleItem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'capabilities.rules[] must be an object';
  const item = value as { pattern?: unknown; allow?: unknown };
  if (typeof item.pattern !== 'string' || !CAPABILITY_PATTERNS.includes(item.pattern as (typeof CAPABILITY_PATTERNS)[number])) {
    return `capabilities.rules[].pattern must be one of: ${CAPABILITY_PATTERNS.join(', ')}`;
  }
  if (typeof item.allow !== 'boolean') return 'capabilities.rules[].allow must be a boolean';
  return null;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], name: string): string | null {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  return unknown ? `${name} has unknown field: ${unknown}` : null;
}

export const SuccinixConfigSchema: Schema<SuccinixConfig> = objectSchema({
  hostJsUrl: optional((v) => isString(v, 'hostJsUrl')),
  lifoCoreUrl: optional((v) => isString(v, 'lifoCoreUrl')),
  pythonAssetsUrl: optional((v) => isString(v, 'pythonAssetsUrl')),
  rubyAssetsUrl: optional((v) => isString(v, 'rubyAssetsUrl')),
  resultTtlMs: optional((v) => isIntegerRange(v, 'resultTtlMs', 1, 86_400_000)),
  container: optional((v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'container must be an object';
    const c = v as { mode?: unknown; bootRetries?: unknown; bootIntervalMs?: unknown; hostReadyDeadlineMs?: unknown };
    if (c.mode !== undefined) {
      const error = isEnum(['internal', 'external'], 'container.mode')(c.mode);
      if (error) return error;
    }
    if (c.bootRetries !== undefined) {
      const error = isIntegerRange(c.bootRetries, 'container.bootRetries', 1, 10);
      if (error) return error;
    }
    if (c.bootIntervalMs !== undefined) {
      const error = isIntegerRange(c.bootIntervalMs, 'container.bootIntervalMs', 1, 60000);
      if (error) return error;
    }
    if (c.hostReadyDeadlineMs !== undefined) {
      const error = isIntegerRange(c.hostReadyDeadlineMs, 'container.hostReadyDeadlineMs', 1, 300000);
      if (error) return error;
    }
    return rejectUnknownKeys(c as Record<string, unknown>, ['mode', 'bootRetries', 'bootIntervalMs', 'hostReadyDeadlineMs'], 'container');
  }),
  defaultInstance: optional((v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'defaultInstance must be an object';
    const d = v as { instanceId?: unknown; statePrefix?: unknown; home?: unknown; persistence?: unknown };
    if (d.instanceId !== undefined) {
      const error = isString(d.instanceId, 'defaultInstance.instanceId');
      if (error) return error;
    }
    if (d.statePrefix !== undefined) {
      const error = isString(d.statePrefix, 'defaultInstance.statePrefix');
      if (error) return error;
    }
    if (d.home !== undefined) {
      const error = isString(d.home, 'defaultInstance.home');
      if (error) return error;
    }
    if (d.persistence !== undefined) {
      if (d.persistence === null || typeof d.persistence !== 'object' || Array.isArray(d.persistence)) {
        return 'defaultInstance.persistence must be an object';
      }
      const p = d.persistence as { dbName?: unknown; storeKey?: unknown; includeGit?: unknown };
      if (p.dbName !== undefined) {
        const error = isString(p.dbName, 'defaultInstance.persistence.dbName');
        if (error) return error;
      }
      if (p.storeKey !== undefined) {
        const error = isString(p.storeKey, 'defaultInstance.persistence.storeKey');
        if (error) return error;
      }
      if (p.includeGit !== undefined) {
        const error = isBoolean(p.includeGit, 'defaultInstance.persistence.includeGit');
        if (error) return error;
      }
      const error = rejectUnknownKeys(p as Record<string, unknown>, ['dbName', 'storeKey', 'includeGit'], 'defaultInstance.persistence');
      if (error) return error;
    }
    return rejectUnknownKeys(d as Record<string, unknown>, ['instanceId', 'statePrefix', 'home', 'persistence'], 'defaultInstance');
  }),
  capabilities: optional((v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'capabilities must be an object';
    const c = v as { defaultAllow?: unknown; rules?: unknown };
    if (c.defaultAllow !== undefined) {
      const error = isBoolean(c.defaultAllow, 'capabilities.defaultAllow');
      if (error) return error;
    }
    if (c.rules !== undefined) {
      const error = isArrayOf(ruleItem, 'capabilities.rules')(c.rules);
      if (error) return error;
    }
    return rejectUnknownKeys(c as Record<string, unknown>, ['defaultAllow', 'rules'], 'capabilities');
  }),
  lifecycle: optional((v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'lifecycle must be an object';
    const l = v as { disposeMode?: unknown; flushOnPageHide?: unknown };
    if (l.disposeMode !== undefined) {
      const error = isEnum(['soft', 'hard'], 'lifecycle.disposeMode')(l.disposeMode);
      if (error) return error;
    }
    if (l.flushOnPageHide !== undefined) {
      const error = isBoolean(l.flushOnPageHide, 'lifecycle.flushOnPageHide');
      if (error) return error;
    }
    return rejectUnknownKeys(l as Record<string, unknown>, ['disposeMode', 'flushOnPageHide'], 'lifecycle');
  }),
  assets: optional((v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'assets must be an object';
    const a = v as { integrity?: unknown };
    if (a.integrity !== undefined) {
      const error = isBoolean(a.integrity, 'assets.integrity');
      if (error) return error;
    }
    return rejectUnknownKeys(a as Record<string, unknown>, ['integrity'], 'assets');
  }),
});

export function resolveConfig(config: SuccinixConfig): ResolvedSuccinixConfig {
  return {
    hostJsUrl: config.hostJsUrl ?? '/host.js',
    lifoCoreUrl: config.lifoCoreUrl ?? '/lifo-core.js',
    pythonAssetsUrl: config.pythonAssetsUrl ?? '/pyodide/',
    rubyAssetsUrl: config.rubyAssetsUrl ?? '/ruby/',
    resultTtlMs: config.resultTtlMs ?? 120_000,
    container: {
      mode: config.container?.mode ?? 'internal',
      bootRetries: config.container?.bootRetries ?? 3,
      bootIntervalMs: config.container?.bootIntervalMs ?? 1000,
      hostReadyDeadlineMs: config.container?.hostReadyDeadlineMs ?? 120_000,
    },
    defaultInstance: {
      instanceId: config.defaultInstance?.instanceId ?? 'default',
      statePrefix: config.defaultInstance?.statePrefix,
      home: config.defaultInstance?.home,
      persistence: config.defaultInstance?.persistence,
    },
    capabilities: {
      defaultAllow: config.capabilities?.defaultAllow ?? true,
      rules: config.capabilities?.rules ?? [],
    },
    lifecycle: {
      disposeMode: config.lifecycle?.disposeMode ?? 'soft',
      flushOnPageHide: config.lifecycle?.flushOnPageHide ?? true,
    },
    assets: {
      integrity: config.assets?.integrity ?? true,
    },
  };
}

export function requiresRestart(previous: SuccinixConfig, next: SuccinixConfig): boolean {
  return (
    (next.hostJsUrl ?? '/host.js') !== (previous.hostJsUrl ?? '/host.js') ||
    (next.lifoCoreUrl ?? '/lifo-core.js') !== (previous.lifoCoreUrl ?? '/lifo-core.js') ||
    (next.pythonAssetsUrl ?? '/pyodide/') !== (previous.pythonAssetsUrl ?? '/pyodide/') ||
    (next.rubyAssetsUrl ?? '/ruby/') !== (previous.rubyAssetsUrl ?? '/ruby/') ||
    (next.container?.mode ?? 'internal') !== (previous.container?.mode ?? 'internal')
  );
}
