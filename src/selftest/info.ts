// 自检域：内存统计 + 系统信息（uname / motd / 分发路径）（O5 拆分）。
// captureTerm / makeDispatchBase 是"捕获型假终端"共享工具：Info 与 Languages 域都用。
import type { Terminal } from '@xterm/xterm';
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from '@succinix/engine';
import { verdict, boundary } from './runner.js';
import type { TestContext } from './runner.js';
import { buildUnameLine, detectUnameArch, unameRuntimeVersion, tryHandleLocalCommand } from '../commands/index.js';
import { readMotd, writeMotd, resetMotd, DEFAULT_MOTD } from '../motd.js';

// R2（TASK17）：经命令分发路径断言 uname flag 解析 —— 不直接调 buildUname*()，
// 而是走 tryHandleLocalCommand → unameCmd 的真实链路（捕获型假终端收集输出）。
// uname -r 应输出运行时版本、uname -m 应输出 UA 架构，验证 flag 解析不再短路。
export function captureTerm(): { term: Terminal; lines: string[] } {
  const lines: string[] = [];
  const termShim = {
    writeln: (l: string) => void lines.push(String(l)),
    write: (d: string) => void lines.push(String(d)),
    clear: () => {},
  } as unknown as Terminal;
  return { term: termShim, lines };
}

// 命令分发基座（缺 term，由调用方补 { ...dispatchBase, term }）。
export function makeDispatchBase(ctx: TestContext): {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
  fit: () => void;
} {
  return { wc: ctx.wc, client: ctx.client, ports: ctx.ports, fit: () => {} };
}

export async function runInfo(ctx: TestContext): Promise<void> {
  const { wc, term } = ctx;
  // ─── 内存（Memory）：浏览器报告设备内存或 JS heap 统计（任一存在即可）───
  const devMem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  const perfMem = (performance as unknown as { memory?: unknown }).memory;
  if (devMem !== undefined || perfMem !== undefined) {
    const detail = devMem !== undefined ? `${devMem} GB` : 'performance.memory present';
    verdict(term, 'Memory', 'device memory reported', true, detail);
  } else {
    boundary(term, 'Memory', 'device memory reported', 'no device memory / heap stats in this browser');
  }

  // ─── 系统信息（Info，TASK15）：uname 输出 + motd 生命周期 ───
  const unameSummary = buildUnameLine();
  const unameOk =
    unameSummary.startsWith('Succinix') &&
    /^Succinix \d+\.\d+\.\d+ js-runtime\+webcontainer \d+\.\d+\.\d+ (x86_64|arm64|unknown)$/.test(unameSummary);
  verdict(term, 'Info', 'uname output', unameOk, `${unameSummary} (arch=${detectUnameArch()})`);

  // motd：设置 → 读回 → reset（恢复默认，零残留）。
  await writeMotd(wc.fs, 'selftest-motd');
  const motdRead = await readMotd(wc.fs);
  const motdSetOk = motdRead === 'selftest-motd';
  await resetMotd(wc.fs);
  const motdAfter = await readMotd(wc.fs);
  verdict(
    term,
    'Info',
    'motd read/write/reset',
    motdSetOk && motdAfter === DEFAULT_MOTD,
    `set=${motdSetOk} reset=${motdAfter === DEFAULT_MOTD}`
  );

  const dispatchBase = makeDispatchBase(ctx);
  const capR = captureTerm();
  const handledR = await tryHandleLocalCommand({ ...dispatchBase, term: capR.term }, 'uname -r');
  verdict(
    term,
    'Info',
    'uname -r via dispatch',
    handledR && capR.lines.join('') === unameRuntimeVersion(),
    `handled=${handledR} out=${capR.lines.join('') || '(empty)'}`
  );

  const capM = captureTerm();
  const handledM = await tryHandleLocalCommand({ ...dispatchBase, term: capM.term }, 'uname -m');
  verdict(
    term,
    'Info',
    'uname -m via dispatch',
    handledM && capM.lines.join('') === detectUnameArch(),
    `handled=${handledM} out=${capM.lines.join('') || '(empty)'}`
  );
}
