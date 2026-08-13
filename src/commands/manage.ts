// Manageability commands: succinix status / succinix plugins (C4).
import type { SuccinixPluginState } from '@succinix/engine';
import { AMBER, GRAY, RED, RESET } from '../theme.js';
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
  term.writeln('usage: succinix status | succinix plugins');
}
