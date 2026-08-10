// 自检域：基础协议（Kernel）—— ping / 统一 cwd（O5 拆分）。
import { verdict } from './runner.js';
import type { TestContext } from './runner.js';

export async function runKernel(ctx: TestContext): Promise<{ hostCwd: string }> {
  const { client, term } = ctx;
  // ─── 基础协议（Kernel）───
  const p1 = await client.exec('ping');
  verdict(term, 'Kernel', 'host alive (ping/pong)', p1.kind === 'pong');

  const p2 = await client.exec('cwd');
  const hostCwd = String(p2.cwd ?? '');
  verdict(term, 'Kernel', 'unified cwd (process.cwd())', p2.ok && hostCwd.startsWith('/'), hostCwd);
  return { hostCwd };
}
