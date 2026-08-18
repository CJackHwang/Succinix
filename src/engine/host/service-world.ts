// Execution-world service bridge. Unit files and ServiceManager are owned by
// Lifo; this module only seeds official recipes and keeps systemctl output
// deterministic for the Succinix terminal contract.
import type { Command, CommandContext } from '@lifo-sh/core';
import type { ServiceManager } from '@lifo-sh/core';
import type { VFS } from '@lifo-sh/core';
import type { UserlandServiceTemplate } from '../../userland/index.js';
import { hasShellMetaToken, tryTokenize } from '../tokenize.js';

const UNIT_ROOT = '/etc/systemd/system';
/**
 * `/etc` is mounted to the current instance's persistent host state before
 * this adapter runs. Keep enablement beside the unit files, never under the
 * shared `/workspace` mount.
 */
export const SERVICE_ENABLEMENT_ROOT = '/etc/succinix/service-state';
const SERVICE_RUNNER = 'succinix-service-run';

function unitName(raw: string): string {
  return raw.endsWith('.service') ? raw.slice(0, -'.service'.length) : raw;
}

function unitPath(name: string): string {
  return `${UNIT_ROOT}/${unitName(name)}.service`;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeServiceCommand(encoded: string): string | null {
  try {
    const command = Buffer.from(encoded, 'base64url').toString('utf8');
    return command.trim() && !/[\r\n\0]/.test(command) ? command.trim() : null;
  } catch {
    return null;
  }
}

function needsServiceRunner(command: string): boolean {
  const parsed = tryTokenize(command);
  if (!parsed.ok || hasShellMetaToken(parsed.tokens)) return true;
  const raw = command.trim().split(/\s+/);
  return raw.length !== parsed.tokens.length || raw.some((token, index) => token !== parsed.tokens[index]);
}

export function serviceExecStart(command: string): { value: string; original?: string } {
  if (!needsServiceRunner(command)) return { value: command };
  return { value: `${SERVICE_RUNNER} ${base64url(command)}`, original: command };
}

export function serviceCommandFromUnitText(text: string): string | null {
  const encoded = /^# SuccinixCommand=([A-Za-z0-9_-]+)$/m.exec(text)?.[1];
  if (encoded) return decodeServiceCommand(encoded);
  return /^ExecStart=(.*)$/m.exec(text)?.[1]?.trim() ?? null;
}

function unitText(template: UserlandServiceTemplate, workingDirectory = '/workspace'): string {
  const port = template.ports?.[0];
  const command = template.command.replace(/\$\{PORT\}/g, port === undefined ? '' : String(port));
  const execStart = serviceExecStart(command);
  return [
    '[Unit]',
    `Description=${template.description ?? `Succinix ${template.name} service`}`,
    '',
    '[Service]',
    `ExecStart=${execStart.value}`,
    ...(execStart.original === undefined ? [] : [`# SuccinixCommand=${base64url(execStart.original)}`]),
    'Type=simple',
    'Restart=no',
    `WorkingDirectory=${workingDirectory}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

interface ServicePayload {
  name: string;
  command: string;
  port: number | null;
}

interface ServiceInspection extends ServicePayload {
  description: string;
  enabled: boolean;
  state: 'running' | 'stopped';
  pid?: number;
}

function validServiceName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

function parseServicePort(command: string): number | null {
  const match = /(?:--port(?:\s+|=)|--listen(?:\s+|=)|\.listen\(\s*)(\d{1,5})\b/.exec(command);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function servicePayload(vfs: VFS, name: string): ServicePayload | null {
  const path = unitPath(name);
  if (!vfs.exists(path)) return null;
  const text = vfs.readFileString(path);
  const command = serviceCommandFromUnitText(text);
  if (!command) return null;
  const declaredPort = /^# SuccinixPort=(\d{1,5})$/m.exec(text)?.[1];
  const port = declaredPort === undefined ? parseServicePort(command) : Number(declaredPort);
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { name: unitName(name), command, port: null };
  }
  return { name: unitName(name), command, port };
}

function serviceInspections(
  vfs: VFS,
  serviceManager: ServiceManager,
  projectPid?: (localPid: number, name: string) => number | undefined,
): ServiceInspection[] {
  const names = new Set<string>();
  try {
    for (const entry of vfs.readdir(UNIT_ROOT)) {
      if (entry.type === 'file' && entry.name.endsWith('.service')) names.add(unitName(entry.name));
    }
  } catch {
    // An empty unit directory is a valid fresh execution world.
  }
  for (const info of serviceManager.listUnits()) names.add(info.name);
  return [...names].sort().flatMap((name) => {
    const payload = servicePayload(vfs, name);
    if (!payload) return [];
    const status = serviceManager.status(name);
    return [{
      ...payload,
      description: status.description || '',
      enabled: status.enabled,
      state: status.active === 'active' || status.active === 'activating' ? 'running' : 'stopped',
      ...(status.pid === null
        ? {}
        : { pid: projectPid ? projectPid(status.pid, name) : status.pid }),
    }];
  });
}

function decodeServicePayload(raw: string | undefined): ServicePayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<ServicePayload>;
    const port = parsed.port === null ? null : Number(parsed.port);
    if (
      typeof parsed.name !== 'string' || !validServiceName(parsed.name) ||
      typeof parsed.command !== 'string' || !parsed.command.trim() || /[\r\n\0]/.test(parsed.command) ||
      (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))
    ) return null;
    return { name: parsed.name, command: parsed.command.trim(), port };
  } catch {
    return null;
  }
}

function writeServiceUnit(vfs: VFS, payload: ServicePayload, workingDirectory: string): void {
  vfs.mkdir(UNIT_ROOT, { recursive: true });
  const execStart = serviceExecStart(payload.command);
  vfs.writeFile(unitPath(payload.name), [
    '[Unit]', `Description=Succinix ${payload.name} service`, '', '[Service]', `ExecStart=${execStart.value}`,
    ...(execStart.original === undefined ? [] : [`# SuccinixCommand=${base64url(execStart.original)}`]),
    ...(payload.port === null ? [] : [`# SuccinixPort=${payload.port}`]),
    'Type=simple', 'Restart=no', `WorkingDirectory=${workingDirectory}`, '', '[Install]',
    'WantedBy=multi-user.target', '',
  ].join('\n'));
}

/** Seed missing official units without overwriting user-authored definitions. */
export function installServiceTemplates(
  vfs: VFS,
  templates: readonly UserlandServiceTemplate[],
  workingDirectory = '/workspace',
): void {
  vfs.mkdir(UNIT_ROOT, { recursive: true });
  for (const template of templates) {
    const path = unitPath(template.name);
    if (!vfs.exists(path)) vfs.writeFile(path, unitText(template, workingDirectory));
  }
}

function writeLine(ctx: CommandContext, line: string): void {
  ctx.stdout.write(`${line}\n`);
}

function writeError(ctx: CommandContext, line: string): number {
  ctx.stderr.write(`${line}\n`);
  return 1;
}

export interface SystemctlCommandOptions {
  /** Register execution-world port ownership before a service can emit ready. */
  beforeStart?: (name: string, ctx: CommandContext) => Promise<void> | void;
  /** Release execution-world port ownership after a service stops. */
  afterStop?: (name: string, ctx: CommandContext) => Promise<void> | void;
  /** Wait for the browser's real WebContainer port event after a service starts. */
  waitForReady?: (name: string, ctx: CommandContext) => Promise<boolean>;
  /** Persist enablement in the workspace snapshot, then mirror it to systemd. */
  onEnablementChange?: (name: string, enabled: boolean, ctx: CommandContext) => Promise<void>;
  /** Translate a Lifo-local service PID into the host's public PID namespace. */
  projectPid?: (localPid: number, name: string) => number | undefined;
}

export function serviceEnablementMarker(name: string): string {
  return `${SERVICE_ENABLEMENT_ROOT}/${unitName(name)}.enabled`;
}

/** Recreate native systemd wants entries from the snapshot-backed marker tree. */
export function restoreServiceEnablement(vfs: VFS, serviceManager: ServiceManager | null): void {
  if (!serviceManager || !vfs.exists(SERVICE_ENABLEMENT_ROOT)) return;
  for (const entry of vfs.readdir(SERVICE_ENABLEMENT_ROOT)) {
    if (entry.type !== 'file' || !entry.name.endsWith('.enabled')) continue;
    const name = entry.name.slice(0, -'.enabled'.length);
    if (serviceManager.status(name).loaded) serviceManager.enable(name);
  }
  serviceManager.daemonReload();
}

function statusLines(
  info: ReturnType<ServiceManager['status']>,
  projectPid?: (localPid: number, name: string) => number | undefined,
): string[] {
  const lines = [
    `${info.name}.service - ${info.description || 'No description'}`,
    `  Loaded: ${info.loaded ? 'loaded' : 'not-found'} (${info.enabled ? 'enabled' : 'disabled'})`,
    `  Active: ${info.active} (${info.sub})`,
  ];
  const publicPid = info.pid === null ? undefined : projectPid ? projectPid(info.pid, info.name) : info.pid;
  if (publicPid !== undefined) lines.push(`  Main PID: ${publicPid}`);
  if (info.exitCode !== null && info.exitCode !== 0) lines.push(`  Exit code: ${info.exitCode}`);
  return lines;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settleFailedStart(
  serviceManager: ServiceManager,
  options: SystemctlCommandOptions,
  name: string,
  ctx: CommandContext,
  attempted: boolean,
): Promise<void> {
  try {
    // A beforeStart failure owns only browser-side reservations. It must not
    // stop an already-running unit because no ServiceManager operation began.
    if (attempted) await serviceManager.stop(name);
  } catch {
    // Port ownership must still be released even when the service manager's
    // best-effort stop reports a secondary failure.
  } finally {
    try {
      await options.afterStop?.(name, ctx);
    } catch {
      // A browser control bridge failure cannot retain execution-world state.
    }
  }
}

async function runStartOperation(
  serviceManager: ServiceManager,
  options: SystemctlCommandOptions,
  operation: 'start' | 'restart',
  name: string,
  ctx: CommandContext,
): Promise<number> {
  let attempted = false;
  try {
    await options.beforeStart?.(name, ctx);
    attempted = true;
    const result = operation === 'start'
      ? await serviceManager.start(name)
      : await serviceManager.restart(name);
    if (!result.ok) {
      await settleFailedStart(serviceManager, options, name, ctx, attempted);
      return writeError(ctx, `Failed to ${operation} ${name}: ${result.message}`);
    }
    if (options.waitForReady && !(await options.waitForReady(name, ctx))) {
      await settleFailedStart(serviceManager, options, name, ctx, attempted);
      return writeError(ctx, `Failed to ${operation} ${name}: service did not become ready`);
    }
    writeLine(ctx, result.message || `${operation === 'start' ? 'Started' : 'Restarted'} ${name}.`);
    return 0;
  } catch (error) {
    await settleFailedStart(serviceManager, options, name, ctx, attempted);
    return writeError(ctx, `Failed to ${operation} ${name}: ${errorMessage(error)}`);
  }
}

async function runStopOperation(
  serviceManager: ServiceManager,
  options: SystemctlCommandOptions,
  name: string,
  ctx: CommandContext,
  successMessage?: string,
): Promise<number> {
  let result: Awaited<ReturnType<ServiceManager['stop']>> | undefined;
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    result = await serviceManager.stop(name);
  } catch (error) {
    operationError = error;
  }
  try {
    await options.afterStop?.(name, ctx);
  } catch (error) {
    cleanupError = error;
  }
  if (operationError) return writeError(ctx, `Failed to stop ${name}: ${errorMessage(operationError)}`);
  if (cleanupError) return writeError(ctx, `Failed to stop ${name}: cleanup failed: ${errorMessage(cleanupError)}`);
  if (!result?.ok) return writeError(ctx, `Failed to stop ${name}: ${result?.message ?? 'service manager returned no result'}`);
  if (successMessage) writeLine(ctx, result.message || successMessage);
  return 0;
}

/** ASCII-only systemctl adapter backed by the same Lifo ServiceManager. */
export function createSystemctlCommand(
  serviceManager: ServiceManager | null,
  options: SystemctlCommandOptions = {},
): Command {
  return async (ctx) => {
    if (!serviceManager) return writeError(ctx, 'systemctl: service manager unavailable');
    const [operation, rawName] = ctx.args;
    if (!operation || operation === '--help' || operation === '-h') {
      writeLine(ctx, 'Succinix declarative service manager (no PID 1)');
      writeLine(ctx, 'Usage: systemctl start|stop|restart|status|enable|disable <unit>');
      writeLine(ctx, '       systemctl list-units | daemon-reload');
      return operation ? 0 : 1;
    }
    const name = rawName ? unitName(rawName) : '';
    switch (operation) {
      case 'inspect': {
        const units = serviceInspections(ctx.vfs, serviceManager, options.projectPid);
        const inspected = name ? units.find((unit) => unit.name === name) ?? null : units;
        ctx.stdout.write(`${JSON.stringify(inspected)}\n`);
        return name && !inspected ? 3 : 0;
      }
      case 'add': {
        const payload = decodeServicePayload(rawName);
        if (!payload) return writeError(ctx, 'succinix service add: invalid service payload');
        writeServiceUnit(ctx.vfs, payload, ctx.cwd);
        serviceManager.daemonReload();
        writeLine(ctx, `Created ${payload.name}.service.`);
        return 0;
      }
      case 'remove': {
        if (!name) return writeError(ctx, 'succinix service remove: missing unit name');
        if (!ctx.vfs.exists(unitPath(name))) return writeError(ctx, `Failed to remove ${name}: unit not found`);
        const status = serviceManager.status(name);
        if (status.active === 'active' || status.active === 'activating') {
          const stopped = await runStopOperation(serviceManager, options, name, ctx);
          if (stopped !== 0) return stopped;
        }
        serviceManager.disable(name);
        await options.onEnablementChange?.(name, false, ctx);
        ctx.vfs.unlink(unitPath(name));
        serviceManager.daemonReload();
        writeLine(ctx, `Removed ${name}.service.`);
        return 0;
      }
      case 'start': {
        if (!name) return writeError(ctx, 'systemctl start: missing unit name');
        return runStartOperation(serviceManager, options, 'start', name, ctx);
      }
      case 'stop': {
        if (!name) return writeError(ctx, 'systemctl stop: missing unit name');
        return runStopOperation(serviceManager, options, name, ctx, `Stopped ${name}.`);
      }
      case 'restart': {
        if (!name) return writeError(ctx, 'systemctl restart: missing unit name');
        return runStartOperation(serviceManager, options, 'restart', name, ctx);
      }
      case 'status': {
        if (!name) return writeError(ctx, 'systemctl status: missing unit name');
        for (const line of statusLines(serviceManager.status(name), options.projectPid)) writeLine(ctx, line);
        return 0;
      }
      case 'enable': {
        if (!name) return writeError(ctx, 'systemctl enable: missing unit name');
        const result = serviceManager.enable(name);
        if (!result.ok) return writeError(ctx, `Failed to enable ${name}: ${result.message}`);
        await options.onEnablementChange?.(name, true, ctx);
        if (result.message) writeLine(ctx, result.message);
        return 0;
      }
      case 'disable': {
        if (!name) return writeError(ctx, 'systemctl disable: missing unit name');
        const result = serviceManager.disable(name);
        if (!result.ok) return writeError(ctx, `Failed to disable ${name}: ${result.message}`);
        await options.onEnablementChange?.(name, false, ctx);
        if (result.message) writeLine(ctx, result.message);
        return 0;
      }
      case 'list-units': {
        const units = serviceManager.listUnits();
        if (units.length === 0) {
          writeLine(ctx, 'No units found.');
          return 0;
        }
        writeLine(ctx, 'UNIT                    LOAD      ACTIVE      SUB           DESCRIPTION');
        for (const info of units) {
          writeLine(ctx, `${(info.name + '.service').padEnd(24)}${(info.loaded ? 'loaded' : 'not-found').padEnd(10)}${info.active.padEnd(12)}${info.sub.padEnd(14)}${info.description || ''}`);
        }
        writeLine(ctx, `${units.length} unit(s) listed.`);
        return 0;
      }
      case 'daemon-reload':
        serviceManager.daemonReload();
        return 0;
      default:
        return writeError(ctx, `Unknown command '${operation}'. See 'systemctl --help'.`);
    }
  };
}
