import {
  USERLAND_DENYLIST,
  USERLAND_PROFILE,
  defaultUserlandCapabilities,
  type UserlandCapabilitySnapshot,
  type UserlandCommandCapability,
} from './profile.js';

export type UserlandCommandSource =
  | { kind: 'shell'; command: string; appendArgs?: boolean }
  | { kind: 'builtin'; id: 'raw-stdin-probe' };

export interface UserlandCommandDefinition extends UserlandCommandCapability {
  /** Structured execution-world source. Browser functions are never accepted. */
  source?: UserlandCommandSource;
}

export interface UserlandPackageSource {
  name: string;
  source: 'lifo' | 'npm';
  version?: string;
  integrity?: string;
  manifest?: unknown;
}

export interface UserlandServiceTemplate {
  name: string;
  runtime: UserlandCommandCapability['runtime'];
  command: string;
  description?: string;
  ports?: number[];
  [key: string]: unknown;
}

export const USERLAND_REGISTRY_FORMAT_VERSION = 1 as const;

/** 可跨浏览器控制面与 WebContainer 传递的注册表状态。 */
export interface UserlandRegistrySnapshot {
  formatVersion: typeof USERLAND_REGISTRY_FORMAT_VERSION;
  commands: UserlandCommandDefinition[];
  packages: UserlandPackageSource[];
  serviceTemplates: UserlandServiceTemplate[];
}

export interface UserlandRegistry {
  listCommands(): UserlandCommandCapability[];
  listCommandDefinitions(): UserlandCommandDefinition[];
  registerCommand(command: UserlandCommandDefinition): () => void;
  registerPackage(source: UserlandPackageSource): () => void;
  registerServiceTemplate(template: UserlandServiceTemplate): () => void;
  capabilities(): UserlandCapabilitySnapshot;
  listPackages(): UserlandPackageSource[];
  listServiceTemplates(): UserlandServiceTemplate[];
  snapshot(): UserlandRegistrySnapshot;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertName(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_./:+@=-]+$/.test(value) || value.length > 128) throw new TypeError(`${field} must be a path-safe non-empty name`);
}

function assertCommandSource(source: unknown): asserts source is UserlandCommandSource {
  if (!source || typeof source !== 'object') throw new TypeError('command.source is required');
  const value = source as Record<string, unknown>;
  if (value.kind === 'shell') {
    if (typeof value.command !== 'string' || value.command.trim() === '') throw new TypeError('command.source.command must be a non-empty string');
    if (value.appendArgs !== undefined && typeof value.appendArgs !== 'boolean') throw new TypeError('command.source.appendArgs must be boolean');
    return;
  }
  if (value.kind === 'builtin') {
    if (value.id === 'raw-stdin-probe') return;
    throw new TypeError(`unsupported command source builtin: ${String(value.id)}`);
  }
  throw new TypeError(`unsupported command source: ${String(value.kind)}`);
}

function assertPackageSource(source: UserlandPackageSource): void {
  if (!['lifo', 'npm'].includes(source.source)) {
    throw new TypeError(`unsupported package source: ${String(source.source)}`);
  }
  if (source.version !== undefined && (typeof source.version !== 'string' || source.version.length > 256)) {
    throw new TypeError('package.version must be a short string');
  }
  if (source.integrity !== undefined && (typeof source.integrity !== 'string' || source.integrity.length > 512)) {
    throw new TypeError('package.integrity must be a short string');
  }
}

function assertServiceTemplate(template: UserlandServiceTemplate): void {
  if (!['lifo', 'node', 'python', 'ruby', 'wasi'].includes(template.runtime)) {
    throw new TypeError(`unsupported service runtime: ${String(template.runtime)}`);
  }
  if (template.description !== undefined && (typeof template.description !== 'string' || template.description.length > 512)) {
    throw new TypeError('service template description must be a short string');
  }
  if (template.ports !== undefined && (!Array.isArray(template.ports) || template.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535))) {
    throw new TypeError('service template ports must be valid TCP ports');
  }
}

function capabilityOf(command: UserlandCommandDefinition): UserlandCommandCapability {
  const { name, status, runtime, execution, supportedFlags, exitCodeContract, limitations } = command;
  return {
    name,
    status,
    runtime,
    execution,
    ...(supportedFlags ? { supportedFlags: [...supportedFlags] } : {}),
    ...(exitCodeContract ? { exitCodeContract } : {}),
    ...(limitations ? { limitations: [...limitations] } : {}),
  };
}

export function createUserlandRegistry(initial: readonly UserlandCommandDefinition[] = []): UserlandRegistry {
  const commands = new Map<string, UserlandCommandDefinition>();
  for (const capability of defaultUserlandCapabilities()) commands.set(capability.name, { ...capability });
  const packages = new Map<string, UserlandPackageSource>();
  const services = new Map<string, UserlandServiceTemplate>();

  const registry: UserlandRegistry = {
    listCommands: () => [...commands.values()].map((entry) => capabilityOf(entry)).sort((a, b) => a.name.localeCompare(b.name)),
    listCommandDefinitions: () => [...commands.values()].map((entry) => clone(entry)).sort((a, b) => a.name.localeCompare(b.name)),
    registerCommand(command) {
      assertName(command.name, 'command.name');
      assertCommandSource(command.source);
      if (command.name.trim() !== command.name) throw new TypeError('command.name must not contain surrounding whitespace');
      if (USERLAND_DENYLIST.includes(command.name)) throw new Error(`command "${command.name}" is denylisted`);
      if (commands.has(command.name)) throw new Error(`command "${command.name}" is already registered`);
      commands.set(command.name, clone(command));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        commands.delete(command.name);
      };
    },
    registerPackage(source) {
      assertName(source.name, 'package.name');
      assertPackageSource(source);
      if (packages.has(source.name)) throw new Error(`package "${source.name}" is already registered`);
      packages.set(source.name, clone(source));
      return () => { packages.delete(source.name); };
    },
    registerServiceTemplate(template) {
      assertName(template.name, 'template.name');
      if (!template.command) throw new TypeError('template.command is required');
      assertServiceTemplate(template);
      if (services.has(template.name)) throw new Error(`service template "${template.name}" is already registered`);
      services.set(template.name, clone(template));
      return () => { services.delete(template.name); };
    },
    capabilities: () => ({ profile: USERLAND_PROFILE, commands: registry.listCommands(), denylist: [...USERLAND_DENYLIST] }),
    listPackages: () => [...packages.values()].map((entry) => clone(entry)).sort((a, b) => a.name.localeCompare(b.name)),
    listServiceTemplates: () => [...services.values()].map((entry) => clone(entry)).sort((a, b) => a.name.localeCompare(b.name)),
    snapshot: () => ({
      formatVersion: USERLAND_REGISTRY_FORMAT_VERSION,
      commands: registry.listCommandDefinitions(),
      packages: registry.listPackages(),
      serviceTemplates: registry.listServiceTemplates(),
    }),
  };
  for (const command of initial) {
    assertCommandSource(command.source);
    if (commands.has(command.name)) commands.delete(command.name);
    // initial values are trusted host registrations, but still get cloned.
    commands.set(command.name, clone(command));
  }
  return registry;
}
