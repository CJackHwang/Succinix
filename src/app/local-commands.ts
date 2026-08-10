// 本地命令适配层：LOCAL_COMMAND_NAMES + makeLocalHandlers（O2 拆分）。
import { tryHandleLocalCommand, type CommandContext } from '../commands.js';
import type { LocalCommandHandler } from '../terminal/index.js';
import { termShimFor } from './output.js';

// ─── commands.ts 薄适配层 ───
// 闭包捕获 CommandContext 所需字段（wc/client/ports/fit/hostProc）；term 用
// { writeln, write, clear } shim 桥接 TerminalOutput —— commands.ts 本身不改。
const LOCAL_COMMAND_NAMES = [
  'help', 'clear', 'sysinfo', 'ports', 'db', 'snapshot', 'free', 'top', 'reboot', 'shutdown',
  'cache', 'workspace', 'env', 'settings', 'service', 'log', 'pkg', 'netstat', 'ip', 'uname',
  'motd', 'lang', 'pwd', 'version', 'whoami',
];

// 每个命令名一个处理器：把 (ctx, args) 还原成完整命令串交给 tryHandleLocalCommand。
// ctx 是可变引用（boot 完成后赋值），处理器在运行时才取值。
export function makeLocalHandlers(getCtx: () => CommandContext): Record<string, LocalCommandHandler> {
  const handlers: Record<string, LocalCommandHandler> = {};
  for (const name of LOCAL_COMMAND_NAMES) {
    handlers[name] = async (lctx, args) => {
      const c = getCtx();
      const handled = await tryHandleLocalCommand({ ...c, term: termShimFor(lctx.output) }, [name, ...args].join(' '));
      if (!handled) throw new Error(`unknown command: ${name}`);
    };
  }
  return handlers;
}
