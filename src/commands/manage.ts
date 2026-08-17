// Manageability commands: succinix status / succinix plugins / succinix
// capabilities / succinix doctor (C4 + v0.7 userland profile).
import type { SuccinixPluginState } from '@succinix/engine';
import {
  USERLAND_DENY_EXIT_CODE,
  USERLAND_DENYLIST,
  USERLAND_PROFILE,
  defaultUserlandCapabilities,
} from '@succinix/engine';
import { AMBER, GRAY, RED, RESET } from '../theme.js';
import { projectCmd } from './project.js';
import type { CommandContext, SuccinixPluginSummary } from './types.js';

function stateColor(state: string): string {
  if (state === 'FAILED') return RED + state + RESET;
  if (state === 'ACTIVE' || state === 'READY') return AMBER + state + RESET;
  if (state === 'DISPOSED') return GRAY + state + RESET;
  return state;
}

function fmtHost(value: number | null): string {
  return value === null ? '--' : String(value);
}

function fmtTime(value: number | null): string {
  return value === null ? '--' : new Date(value).toISOString();
}

export function formatSuccinixStatus(state: SuccinixPluginState, fiberState: string): string[] {
  const label = (name: string) => `  ${name.padEnd(16)}`;
  const lines = [
    'Succinix plugin status',
    `${label('version')}${state.version}`,
    `${label('fiber')}${stateColor(fiberState)}`,
    `${label('containerMode')}${state.containerMode}`,
    `${label('containerState')}${stateColor(state.containerState.toUpperCase())}`,
    `${label('host pid')}${fmtHost(state.host.pid)}`,
    `${label('host started')}${fmtTime(state.host.startedAt)}`,
  ];
  if (state.instances.length === 0) {
    lines.push(`${label('instances')}(none)`);
  } else {
    lines.push(`${label('instances')}${state.instances.length}`);
    for (const instance of state.instances) {
      lines.push(`    ${instance.instanceId}: ${stateColor(instance.state.toUpperCase())}`);
    }
  }
  lines.push(`${label('capabilities')}${state.capabilities.join(', ') || '(none)'}`);
  lines.push(`${label('configRevision')}${state.configRevision}`);
  lines.push(`${label('lastError')}${state.lastError ?? '(none)'}`);
  return lines;
}

export function formatSuccinixPlugins(plugins: SuccinixPluginSummary[]): string[] {
  const lines = [`Plugins (${plugins.length})`];
  for (const plugin of plugins) {
    const states = plugin.fibers.length === 0
      ? ['(no fibers)']
      : plugin.fibers.map((fiber) => stateColor(fiber.state));
    lines.push(`  ${plugin.name.padEnd(28)} ${states.join(', ')}`);
  }
  return lines;
}

// v0.7 userland profile: every supported command with its status/runtime/
// execution contract plus the fail-closed denylist visible in one view.
export function formatCapabilities(): string[] {
  const commands = defaultUserlandCapabilities();
  const nameW = Math.max(...commands.map((c) => c.name.length)) + 2;
  const statusW = Math.max(...commands.map((c) => c.status.length)) + 2;
  const lines = [
    `Linux Userland Compatibility Profile: ${USERLAND_PROFILE}`,
    `Commands (${commands.length})`,
    `  ${'NAME'.padEnd(nameW)}${'STATUS'.padEnd(statusW)}RUNTIME  EXECUTION`,
  ];
  for (const command of commands) {
    lines.push(`  ${command.name.padEnd(nameW)}${command.status.padEnd(statusW)}${command.runtime.padEnd(8)}${command.execution}`);
  }
  lines.push(`Denylisted (${USERLAND_DENYLIST.length}) - fail-closed exit code ${USERLAND_DENY_EXIT_CODE}`);
  lines.push(`  ${USERLAND_DENYLIST.join(' ')}`);
  return lines;
}

// v0.7 doctor: honest capability checks with ASCII status markers.
export async function succinixDoctor(ctx: CommandContext): Promise<void> {
  const { term } = ctx;
  term.writeln('Succinix doctor');

  let ping = false;
  try {
    const r = await ctx.client.exec('ping', undefined, 5000);
    ping = r.kind === 'pong';
  } catch {
    ping = false;
  }
  term.writeln(`${ping ? '[  OK  ]' : '[ FAIL ]'} host RPC ping`);

  let persistLine = 'no snapshot yet';
  try {
    const meta = ctx.persist ? await ctx.persist.meta() : null;
    if (meta) persistLine = `format v${meta.version} ${meta.fileCount} files ${meta.totalBytes} bytes (saved ${new Date(meta.savedAt).toISOString()})`;
  } catch (error) {
    persistLine = String(error);
  }
  term.writeln(`${ctx.persist ? '[  OK  ]' : '[SKIP]'} persistence: ${persistLine}`);

  const commands = defaultUserlandCapabilities();
  term.writeln(`[  OK  ] userland profile: ${commands.length} commands, ${USERLAND_DENYLIST.length} denylisted (${USERLAND_PROFILE})`);

  const state = ctx.engineState;
  if (state) {
    term.writeln(`[  OK  ] engine state: ${state.containerState} (${state.instances.length} instance${state.instances.length === 1 ? '' : 's'})`);
  } else {
    term.writeln('[SKIP] engine state: not connected');
  }
}

export async function succinixCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === 'status') {
    if (!ctx.engineState) {
      term.writeln(`${RED}succinix status unavailable (engine service not connected)${RESET}`);
      return;
    }
    const fiber = ctx.pluginSummaries?.find((plugin) => plugin.name === 'succinix')?.fibers[0]?.state ?? 'unknown';
    for (const line of formatSuccinixStatus(ctx.engineState, fiber)) term.writeln(line);
    return;
  }
  if (sub === 'plugins') {
    if (!ctx.pluginSummaries) {
      term.writeln(`${RED}succinix plugins unavailable (registry not connected)${RESET}`);
      return;
    }
    for (const line of formatSuccinixPlugins(ctx.pluginSummaries)) term.writeln(line);
    return;
  }
  if (sub === 'capabilities') {
    for (const line of formatCapabilities()) term.writeln(line);
    return;
  }
  if (sub === 'doctor') {
    await succinixDoctor(ctx);
    return;
  }
  if (sub === 'init' || sub === 'run' || sub === 'serve' || sub === 'open') {
    await projectCmd(ctx, args);
    return;
  }
  term.writeln('usage: succinix status | succinix plugins | succinix capabilities | succinix doctor | succinix init | succinix run | succinix serve | succinix open [port]');
}
