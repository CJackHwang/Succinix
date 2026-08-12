// invariant: local capability registry, default allow, optional host integration.
import type { Context } from 'cordis';
import {
  CAPABILITY_PATTERNS,
  type SuccinixCapabilityPattern,
} from './config.js';

export interface CapabilityConfig {
  defaultAllow: boolean;
  rules: Array<{ pattern: string; allow: boolean }>;
}

interface HostCapabilityService {
  check?(name: string): boolean;
  list?(): string[];
  define?(name: string, checker?: () => boolean): () => void;
}

export class SuccinixCapabilityRegistry {
  private readonly defaultAllow: boolean;
  private readonly rules = new Map<string, boolean>();
  private readonly checkers = new Map<SuccinixCapabilityPattern, () => boolean>();

  constructor(config: CapabilityConfig) {
    this.defaultAllow = config.defaultAllow;
    for (const rule of config.rules) {
      this.rules.set(rule.pattern, rule.allow);
    }
  }

  check(pattern: SuccinixCapabilityPattern): boolean {
    const checker = this.checkers.get(pattern);
    if (checker) return checker();
    const rule = this.rules.get(pattern);
    return rule ?? this.defaultAllow;
  }

  list(): SuccinixCapabilityPattern[] {
    return [...CAPABILITY_PATTERNS];
  }

  define(pattern: SuccinixCapabilityPattern, checker?: () => boolean): () => void {
    const current = checker ?? (() => true);
    this.checkers.set(pattern, current);
    return () => {
      if (this.checkers.get(pattern) === current) this.checkers.delete(pattern);
    };
  }
}

export function registerHostCapabilities(ctx: Context, registry: SuccinixCapabilityRegistry): (() => void)[] {
  const host = ctx.get('capability', false) as HostCapabilityService | undefined;
  if (!host || typeof host.define !== 'function') return [];
  return registry.list().map((pattern) => {
    const dispose = host.define!(pattern, () => registry.check(pattern));
    return () => dispose();
  });
}
