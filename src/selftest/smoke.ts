// 自检域：内置命令冒烟 + 已知边界（O5 拆分）。
import { verdict, boundary } from './runner.js';
import type { TestContext } from './runner.js';
import { tryHandleLocalCommand } from '../commands/index.js';

export async function runSmoke(ctx: TestContext): Promise<void> {
  const { wc, client, ports, term } = ctx;
  // ─── 内置命令冒烟（Smoke，TASK16）：help 全部条目里浏览器侧命令的取安全形态逐个跑 ───
  // 只跑非破坏性命令：reboot 会 reload、db start 会装 tinbase、snapshot now/clear 有副作用，均排除；
  // 其余全部经 tryHandleLocalCommand 分发，断言"被浏览器处理且不抛异常"。
  const smokeCtx = { wc, client, ports, term, fit: () => {} };
  const smokeCommands: string[] = [
    'help', 'clear', 'sysinfo', 'version', 'whoami', 'ports', 'pwd', 'lang',
    'db status', 'db stop', // db start 排除（重型：安装+spawn）
    'snapshot', // 状态查看；snapshot now / clear 排除（副作用）
    'free', 'top', // top 3 次快照，约 4s，可接受
    'cache', // du 统计，几秒内返回
    'workspace', 'env', 'settings', 'service', 'log', 'pkg',
    'netstat', 'ip addr', 'uname -a', 'motd', 'shutdown',
  ];
  const smokeFails: string[] = [];
  for (const cmd of smokeCommands) {
    try {
      const handled = await tryHandleLocalCommand(smokeCtx, cmd);
      if (!handled) smokeFails.push(`${cmd}: not handled locally`);
    } catch (e) {
      smokeFails.push(`${cmd}: ${String(e).slice(0, 100)}`);
    }
  }
  if (smokeFails.length === 0) {
    verdict(term, 'Smoke', `built-in commands dispatch (${smokeCommands.length})`, true, smokeCommands.join(' '));
  } else {
    verdict(term, 'Smoke', 'built-in commands dispatch', false, smokeFails.join('; '));
  }

  // ─── 已知边界（网络/生态，仅供参考，计入 skipped）───
  try {
    const b1 = await client.terminal('curl -s -m 12 https://example.com', undefined, 20000);
    boundary(term, 'Network', 'curl example.com', `known boundary: external net exit=${b1.exitCode} ${String(b1.stdout || b1.stderr || '').slice(0, 40)}`);
  } catch (e) {
    boundary(term, 'Network', 'curl example.com', `known boundary: external net ${String(e).slice(0, 60)}`);
  }
  try {
    const b2 = await client.terminal('curl -s -m 20 https://r.jina.ai/https://example.com', undefined, 25000);
    boundary(term, 'Network', 'curl via r.jina.ai', `known boundary: external net ok=${b2.ok} ${String(b2.stdout || b2.stderr || '').slice(0, 40)}`);
  } catch (e) {
    boundary(term, 'Network', 'curl via r.jina.ai', `known boundary: external net ${String(e).slice(0, 60)}`);
  }
  try {
    const b3 = await client.terminal('lifo search git', undefined, 20000);
    boundary(term, 'Kernel', 'lifo search git', `known boundary: ecosystem ok=${b3.ok} ${String(b3.stdout || b3.stderr || '').slice(0, 40)}`);
  } catch (e) {
    boundary(term, 'Kernel', 'lifo search git', `known boundary: ecosystem ${String(e).slice(0, 60)}`);
  }
  try {
    const b4 = await client.terminal('ln -s /workspace/browser-wrote.txt /workspace/mylink.txt && ls -la /workspace');
    boundary(term, 'Filesystem', 'symlink fallback', `known boundary: degraded ok=${b4.ok} ${String(b4.stdout || b4.stderr || '').slice(0, 60)}`);
  } catch (e) {
    boundary(term, 'Filesystem', 'symlink fallback', `known boundary: degraded ${String(e).slice(0, 60)}`);
  }
}
