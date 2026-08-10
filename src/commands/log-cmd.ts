// log 命令域：journald 风格日志查看（O1 拆分）。
import { readLog, readBootLog, clearLog } from '../log.js';
import { AMBER, RED, RESET } from '../theme.js';
import type { CommandContext } from './types.js';
// ─── 日志（TASK12）：log 命令族，读取 /var/log/succinix.log（journald 风格）───
//   log              最近 20 行（默认）
//   log -n <count>   最近 N 行
//   log boot         只看 BOOT 级
//   log clear        清空日志文件
//   log -f           不做（交互 stdin 边界，AGENTS.md）：明确提示改用 log / log -n
const LOG_DEFAULT_LINES = 20;

export async function logCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term, wc } = ctx;
  const sub = args[0] ?? '';
  if (sub === '') {
    const lines = await readLog(wc.fs, LOG_DEFAULT_LINES);
    term.writeln(lines ? lines : '(log is empty)');
    return;
  }
  if (sub === '-n') {
    const n = Number(args[1]);
    if (!Number.isInteger(n) || n < 1) {
      term.writeln('usage: log -n <count>');
      return;
    }
    const lines = await readLog(wc.fs, n);
    term.writeln(lines ? lines : '(log is empty)');
    return;
  }
  if (sub === 'boot') {
    const lines = await readBootLog(wc.fs, LOG_DEFAULT_LINES);
    term.writeln(lines ? lines : '(no BOOT entries)');
    return;
  }
  if (sub === 'clear') {
    try {
      await clearLog(wc.fs);
      term.writeln('Log cleared.');
    } catch (e) {
      term.writeln(`${RED}log clear failed: ${String(e)}${RESET}`);
    }
    return;
  }
  if (sub === '-f') {
    term.writeln(`${AMBER}log -f (tail -f) is not supported in this environment; use 'log' or 'log -n <count>'.${RESET}`);
    return;
  }
  term.writeln('usage: log | log -n <count> | log clear | log boot');
}
