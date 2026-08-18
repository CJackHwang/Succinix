// service 命令域：声明式服务管理（O1 拆分）。
import {
  disableExecutionService,
  enableExecutionService,
  executionServiceState,
  listExecutionServiceStates,
  restartExecutionService,
  startExecutionService,
  stopExecutionService,
} from '../services/world-client.js';
import type { ServiceContext } from '../services/types.js';
import { AMBER, RED, RESET } from '../theme.js';
import type { CommandContext } from './types.js';
// ─── 服务管理（TASK11）：service 命令族，spawn/ps/kill + 端口注册表的声明式封装 ───
// 定义在 /etc/succinix.services（name|command|port），自启清单在 /etc/succinix.autostart，
// 两者都随快照持久。状态由进程表 + 端口注册表联合判定（services.ts）。

// 单个服务详情：state + pid + port/url（未匹配显示 unknown service）。
async function serviceStatusOne(ctx: CommandContext, svc: ServiceContext, name: string): Promise<void> {
  const { term } = ctx;
  let state;
  try {
    state = await executionServiceState(svc, name);
  } catch {
    term.writeln(`${RED}unknown service: ${name}${RESET}`);
    return;
  }
  term.writeln(`Service '${name}'`);
  term.writeln(`  state  ${state.state === 'running' ? `${AMBER}${state.state}${RESET}` : state.state}`);
  if (state.pid !== undefined) term.writeln(`  pid    ${state.pid}`);
  if (state.effectivePort !== null) term.writeln(`  port   ${state.effectivePort}${state.url ? `  -> ${state.url}` : ''}`);
}

export async function serviceCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const svc: ServiceContext = { wc: ctx.wc, client: ctx.client, ports: ctx.ports, instanceId: ctx.instanceId, statePrefix: ctx.statePrefix };
  const sub = args[0] ?? '';

  if (sub === '' || sub === 'list-units') {
    const states = await listExecutionServiceStates(svc);
    if (states.length === 0) {
      term.writeln('Services');
      term.writeln('  (none defined)');
      return;
    }
    // 表格对齐：NAME / STATE 按最长值 + 2 空格间隔，running 用暗橙。
    const nameW = Math.max(4, ...states.map((s) => s.def.name.length)) + 2;
    const stateW = Math.max(5, ...states.map((s) => s.state.length)) + 2;
    term.writeln('Services');
    term.writeln('  ' + 'NAME'.padEnd(nameW) + 'STATE'.padEnd(stateW) + 'PORT');
    for (const s of states) {
      const st = s.state === 'running' ? AMBER + s.state.padEnd(stateW) + RESET : s.state.padEnd(stateW);
      const portStr = s.effectivePort !== null ? String(s.effectivePort) : '-';
      term.writeln('  ' + s.def.name.padEnd(nameW) + st + portStr);
    }
    return;
  }

  if (sub === 'start') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service start <name>');
      return;
    }
    const r = await startExecutionService(svc, name);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }

  if (sub === 'stop') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service stop <name>');
      return;
    }
    const r = await stopExecutionService(svc, name);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }

  if (sub === 'restart') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service restart <name>');
      return;
    }
    const r = await restartExecutionService(svc, name);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }

  if (sub === 'status') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service status <name>');
      return;
    }
    await serviceStatusOne(ctx, svc, name);
    return;
  }

  if (sub === 'enable') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service enable <name>');
      return;
    }
    try {
      const enabled = await enableExecutionService(svc, name);
      term.writeln(enabled ? `service '${name}' enabled (will start on boot)` : `service '${name}' is already enabled`);
    } catch {
      term.writeln(`${RED}unknown service: ${name}${RESET}`);
    }
    return;
  }

  if (sub === 'disable') {
    const name = args[1];
    if (!name) {
      term.writeln('usage: service disable <name>');
      return;
    }
    try {
      const disabled = await disableExecutionService(svc, name);
      term.writeln(disabled ? `service '${name}' disabled` : `service '${name}' is not enabled`);
    } catch {
      term.writeln(`${RED}unknown service: ${name}${RESET}`);
    }
    return;
  }

  term.writeln('Succinix declarative service manager (no PID 1)');
  term.writeln('usage: service | service list-units | service start|stop|restart|status|enable|disable <name>');
}
