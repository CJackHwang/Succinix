// pkg 命令域：包管理（lifo + npm 双通道，O1 拆分）。
import { listPackages, formatPackageList, searchPackages, formatSearchResults, installPackage, removePackage, packageInfo, type PkgContext } from '../pkg/index.js';
import { GRAY, RED, RESET } from '../theme.js';
import type { CommandContext } from './types.js';
// ─── 包管理（TASK13）：pkg 命令族，统一 lifo + npm 两通道 ───
// 实现细节在 src/pkg/index.ts：来源判定（lifo-pkg-<name> 存在 → lifo，否则 npm；同名冲突优先 lifo）、
// 已装列表合并去重、搜索合并。这里只做命令分发与呈现（含真实命令 stdout 尾部回显）。
const PKG_USAGE_LINES = [
  'usage: pkg <command> [args]',
  '  list                   list installed packages (lifo + npm merged, source-annotated)',
  '  search <term>          search packages (lifo search + npm search, merged)',
  '  install <name>         install a package (lifo if lifo-pkg-<name> exists, else npm)',
  '  remove <name>          remove an installed package (via its source channel)',
  '  info <name>            show package info (source / version / description)',
];

export async function pkgCmd(ctx: CommandContext, args: string[]): Promise<void> {
  const { term } = ctx;
  const pctx: PkgContext = { wc: ctx.wc, client: ctx.client };
  const sub = args[0] ?? '';

  if (sub === '' || sub === '--help' || sub === '-h') {
    for (const line of PKG_USAGE_LINES) term.writeln(line);
    return;
  }

  if (sub === 'list') {
    const entries = await listPackages(pctx);
    for (const line of formatPackageList(entries)) term.writeln(line);
    return;
  }

  if (sub === 'search') {
    if (args[1] === '--help' || args[1] === '-h') {
      for (const line of PKG_USAGE_LINES) term.writeln(line);
      return;
    }
    const termName = args.slice(1).join(' ').trim();
    if (!termName) {
      term.writeln('usage: pkg search <term>');
      return;
    }
    const outcome = await searchPackages(pctx, termName);
    for (const line of formatSearchResults(termName, outcome.entries)) term.writeln(line);
    for (const note of outcome.notes) term.writeln(`  ${GRAY}${note}${RESET}`);
    return;
  }

  if (sub === 'install') {
    if (args[1] === '--help' || args[1] === '-h') {
      for (const line of PKG_USAGE_LINES) term.writeln(line);
      return;
    }
    const name = args.slice(1).join(' ').trim();
    if (!name) {
      term.writeln('usage: pkg install <name>');
      return;
    }
    const r = await installPackage(pctx, name);
    if (r.outputTail) term.writeln(`${GRAY}${r.outputTail}${RESET}`);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }

  if (sub === 'remove') {
    if (args[1] === '--help' || args[1] === '-h') {
      for (const line of PKG_USAGE_LINES) term.writeln(line);
      return;
    }
    const name = args.slice(1).join(' ').trim();
    if (!name) {
      term.writeln('usage: pkg remove <name>');
      return;
    }
    const r = await removePackage(pctx, name);
    if (r.outputTail) term.writeln(`${GRAY}${r.outputTail}${RESET}`);
    term.writeln(r.ok ? r.message : `${RED}${r.message}${RESET}`);
    return;
  }

  if (sub === 'info') {
    if (args[1] === '--help' || args[1] === '-h') {
      for (const line of PKG_USAGE_LINES) term.writeln(line);
      return;
    }
    const name = args.slice(1).join(' ').trim();
    if (!name) {
      term.writeln('usage: pkg info <name>');
      return;
    }
    const r = await packageInfo(pctx, name);
    if (!r.ok || !r.entry) {
      term.writeln(`${RED}${r.message}${RESET}`);
      return;
    }
    const e = r.entry;
    term.writeln(`Package: ${e.name}`);
    term.writeln(`  source      ${e.source}`);
    term.writeln(`  version     ${e.version}`);
    term.writeln(`  description ${e.description || '--'}`);
    return;
  }

  term.writeln('usage: pkg list | pkg search <term> | pkg install <name> | pkg remove <name> | pkg info <name>');
}
