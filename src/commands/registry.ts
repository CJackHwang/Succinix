// 浏览器侧命令拦截：以下命令在浏览器处理，不进容器。
//   help / clear / sysinfo / ports / db start|status|stop / snapshot / free / top /
//   reboot / shutdown / cache / workspace / env / settings / service / log / pkg /
//   netstat / ip / version / whoami / uname / motd
// 其余命令返回 false，由调用方原样发 host（TerminalExecutor 路由）。
import { detectSystemInfo } from '../boot.js';
import { RED, RESET } from '../theme.js';
import type { CommandContext } from './types.js';
import { printHelp } from './help.js';
import { printPorts, netstatCmd, ipCmd } from './network.js';
import { VERSION, freeCmd, topCmd, rebootCmd, shutdownCmd, cacheCmd } from './system.js';
import { dbStart, dbStatus, dbStop } from './db.js';
import { snapshotCmd } from './snapshot.js';
import { workspaceCmd } from './workspace.js';
import { envCmd, settingsCmd } from './config-cmds.js';
import { serviceCmd } from './service-cmd.js';
import { logCmd } from './log-cmd.js';
import { pkgCmd } from './pkg-cmd.js';
import { unameCmd, motdCmd, langCmd } from './identity.js';

// 尝试在浏览器侧处理命令；返回 true 表示已处理，false 表示应发 host。
export async function tryHandleLocalCommand(ctx: CommandContext, input: string): Promise<boolean> {
  const { term } = ctx;
  const trimmed = input.trim();
  const [word, ...rest] = trimmed.split(/\s+/);

  switch (word) {
    case 'help':
      printHelp(term);
      return true;
    case 'clear':
      term.clear();
      return true;
    case 'sysinfo':
      for (const line of detectSystemInfo()) term.writeln(line);
      return true;
    case 'ports':
      printPorts(term, ctx.ports, ctx.instanceId);
      return true;
    case 'version':
      term.writeln(VERSION);
      return true;
    case 'whoami':
      term.writeln(ctx.userId ?? 'guest');
      return true;
    case 'pwd': {
      // TASK23：pwd 显示会话 cwd（host 维护，cd 同步后与 node 子进程口径一致）。
      try {
        const r = await ctx.client.terminal('cwd');
        term.writeln(String(r.cwd ?? ''));
      } catch (e) {
        term.writeln(`${RED}${String(e)}${RESET}`);
      }
      return true;
    }
    case 'db': {
      const sub = rest[0] ?? '';
      if (sub === 'start') await dbStart(ctx);
      else if (sub === 'status') await dbStatus(ctx);
      else if (sub === 'stop') await dbStop(ctx);
      else term.writeln('usage: db start | db status | db stop');
      return true;
    }
    case 'snapshot': {
      await snapshotCmd(ctx, rest);
      return true;
    }
    case 'free':
      await freeCmd(ctx);
      return true;
    case 'top':
      await topCmd(ctx);
      return true;
    case 'reboot':
      rebootCmd(ctx);
      return true;
    case 'shutdown':
      shutdownCmd(ctx);
      return true;
    case 'cache': {
      await cacheCmd(ctx, rest);
      return true;
    }
    case 'workspace': {
      await workspaceCmd(ctx, rest);
      return true;
    }
    case 'env': {
      await envCmd(ctx, rest);
      return true;
    }
    case 'settings': {
      await settingsCmd(ctx, rest);
      return true;
    }
    case 'service': {
      await serviceCmd(ctx, rest);
      return true;
    }
    case 'log': {
      await logCmd(ctx, rest);
      return true;
    }
    case 'pkg': {
      await pkgCmd(ctx, rest);
      return true;
    }
    case 'netstat': {
      await netstatCmd(ctx, rest);
      return true;
    }
    case 'ip': {
      await ipCmd(ctx, rest);
      return true;
    }
    case 'uname':
      unameCmd(term, rest);
      return true;
    case 'motd': {
      await motdCmd(ctx, rest);
      return true;
    }
    case 'lang': {
      await langCmd(ctx, rest);
      return true;
    }
    default:
      return false;
  }
}
