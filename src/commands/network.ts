// 网络视图命令域：ports / netstat / ip（O1 拆分）。
import type { Terminal } from '@xterm/xterm';
import { DEFAULT_INSTANCE_ID, instancePorts, type TerminalClient } from '@succinix/engine';
import { GRAY, RESET } from '../theme.js';
import type { CommandContext } from './types.js';
export function printPorts(term: Terminal, ports: Map<number, string>, instanceId?: string): void {
  // M4：按实例视图收窄（期望端口 ∩ 页面级就绪；缺省实例 = 页面级全部，现状不变）。
  const view = instancePorts.portsFor(instanceId ?? DEFAULT_INSTANCE_ID, ports);
  if (view.size === 0) {
    term.writeln('(no service ports ready yet)');
    return;
  }
  term.writeln('PORT  URL');
  for (const [port, url] of view) {
    term.writeln(`${port}  ${url}`);
  }
}


// ─── 网络视图（TASK14）：netstat / ip —— 仅虚拟端口视图，诚实标注 virtual，不编造数据 ───
// 数据源：端口注册表（server-ready 事件，boot.ts 登记）+ 进程表（spawn 的 node 系进程）。
// 关联规则：端口 ↔ 进程——进程表里找命令含端口号（String 匹配）且 running 的进程；匹配不到显示 -。
// 浏览器沙箱无真网卡/真连接（AGENTS.md 边界）：Proto 固定 tcp（虚拟）、State 固定 LISTEN、
// Local Address 用 127.0.0.1:<port>。进程标签是真实命令的诚实摘要，不编造。

// 从进程命令提取简短可读标签：npx <pkg> ... → <pkg>；node 且含 http.createServer → node http server；
// node <script>.js → node <script>.js；其余取命令首词。标签只做摘要，不改写事实。
// TASK16：npx/node 跳过前置 flag（--yes / --watch 等），取第一个非 flag 参数作为包/脚本名。
export function processLabel(cmd: string): string {
  const words = cmd.trim().split(/\s+/);
  const first = words[0] ?? '';
  if (first === 'npx' || first === 'node') {
    const target = words.slice(1).find((w) => !w.startsWith('-'));
    if (first === 'npx') return target || 'npx';
    if (cmd.includes('http.createServer')) return 'node http server';
    if (target && target.endsWith('.js')) return `node ${target}`;
    return target || 'node';
  }
  return first || cmd;
}

// 端口↔进程结构化匹配（TASK16）：拒绝子串误关联（3001↔300/30010）。
// 命中任一即认为该进程与端口相关：
//   --port 3001 / --port=3001 / --port:3001 （后面跟空白或行尾）
//   listen(3001)
//   裸 token 3001（词边界，两侧非 [A-Za-z0-9_]）
export function commandMentionsPort(cmd: string, port: number): boolean {
  const p = String(port);
  const flag = new RegExp(`--port\\s*[=:]?\\s*${p}(?:\\s|$)`);
  const listen = new RegExp(`listen\\(${p}\\)`);
  const token = new RegExp(`(?:^|[^A-Za-z0-9_])${p}(?:[^A-Za-z0-9_]|$)`);
  return flag.test(cmd) || listen.test(cmd) || token.test(cmd);
}

// netstat 表行（导出供自检断言格式：proto / localAddress / state / process）。
export interface NetstatRow {
  proto: string;
  localAddress: string;
  state: string;
  /** 无 -p 时为空串；有 -p 且无匹配进程时为 '-' */
  process: string;
}

// 组装 netstat 行：端口注册表升序；-p 时查询进程表做端口↔进程关联（命令含端口号）。
export async function buildNetstatRows(
  ports: Map<number, string>,
  client: TerminalClient,
  withProcess: boolean
): Promise<NetstatRow[]> {
  let procs: Array<Record<string, unknown>> = [];
  if (withProcess) {
    try {
      const ps = await client.terminal('ps');
      procs = Array.isArray(ps.processes) ? ps.processes : [];
    } catch {
      procs = []; // 进程表不可达：全部按无匹配显示 -
    }
  }
  return [...ports.keys()]
    .sort((a, b) => a - b)
    .map((port) => {
      const found = withProcess
        ? procs.find((p) => p.status === 'running' && commandMentionsPort(String(p.cmd ?? ''), port))
        : undefined;
      return {
        proto: 'tcp',
        localAddress: `127.0.0.1:${port}`,
        state: 'LISTEN',
        process: withProcess
          ? found
            ? `${processLabel(String(found.cmd ?? ''))} (pid ${found.pid})`
            : '-'
          : '',
      };
    });
}

// netstat：列出全部服务端口（虚拟端口视图）。任意参数含 p（-p / -tlnp / -ap）时带进程列。
export async function netstatCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const withProcess = args.some((a) => a.includes('p'));
  if (ctx.ports.size === 0) {
    term.writeln('No listening ports');
    return;
  }
  const rows = await buildNetstatRows(ctx.ports, ctx.client, withProcess);
  const protoW = Math.max('Proto'.length, ...rows.map((r) => r.proto.length)) + 2;
  const addrW = Math.max('Local Address'.length, ...rows.map((r) => r.localAddress.length)) + 2;
  const stateW = Math.max('State'.length, ...rows.map((r) => r.state.length)) + 2;
  const line = (proto: string, addr: string, state: string, process = '') =>
    proto.padEnd(protoW) + addr.padEnd(addrW) + state.padEnd(stateW) + process;
  term.writeln(withProcess ? line('Proto', 'Local Address', 'State') + 'Process' : line('Proto', 'Local Address', 'State'));
  for (const r of rows) {
    term.writeln(withProcess ? line(r.proto, r.localAddress, r.state) + r.process : line(r.proto, r.localAddress, r.state));
  }
}

// ip addr：网络身份（浏览器视角）。浏览器沙箱无真网卡（AGENTS.md），lo/eth0 都是虚拟设备——
// 诚实标 virtual，不编造 IP/连接。预览域取首个就绪预览 URL 的 hostname；无就绪端口时
// 回落页面 origin（location.hostname），仍是真实的浏览器来源。
function ipAddrCmd(ctx: CommandContext): void {
  const { term } = ctx;
  const first = ctx.ports.values().next();
  let domain: string;
  try {
    domain = first.done ? location.hostname : new URL(first.value).hostname;
  } catch {
    domain = location.hostname;
  }
  term.writeln('lo: virtual loopback');
  term.writeln(`eth0: ${domain} (virtual)`);
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? (navigator as { platform?: string }).platform;
  if (platform) {
    term.writeln(`${GRAY}(virtual network identity — browser platform: ${platform}, no real interfaces)${RESET}`);
  }
}

export async function ipCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const sub = args[0] ?? '';
  if (sub === '' || sub === 'addr') {
    ipAddrCmd(ctx);
    return;
  }
  term.writeln(`ip: only the virtual 'addr' view is available (no real network interfaces)`);
}
