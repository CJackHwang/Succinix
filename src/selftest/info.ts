// 自检域：内存统计 + 系统信息（uname / motd / 执行世界路径）（O5 拆分）。
import { verdict, boundary } from './runner.js';
import type { TestContext } from './runner.js';
import { buildUnameLine, detectUnameArch } from '../commands/index.js';
import { readMotd, writeMotd, resetMotd, DEFAULT_MOTD } from '../motd.js';

export async function runInfo(ctx: TestContext): Promise<void> {
  const { wc, client, term } = ctx;
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

  // R2（TASK17）：通过 TerminalClient 进入真实 WebContainer/Lifo 命令路径，
  // 不在浏览器侧解析或实现 uname。
  const unameR = await client.terminal('uname -r');
  const unameROut = String(unameR.stdout ?? '').trim();
  verdict(
    term,
    'Info',
    'uname -r via execution world',
    unameR.ok && unameR.runtime === 'lifo' && /^\d+\.\d+\.\d+$/.test(unameROut),
    `runtime=${unameR.runtime} out=${unameROut || '(empty)'}`
  );

  const unameM = await client.terminal('uname -m');
  const unameMOut = String(unameM.stdout ?? '').trim();
  verdict(
    term,
    'Info',
    'uname -m via execution world',
    unameM.ok && unameM.runtime === 'lifo' && unameMOut === 'wasm',
    `runtime=${unameM.runtime} out=${unameMOut || '(empty)'}`
  );
}
