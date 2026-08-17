// 自检域：执行世界命令冒烟 + 已知边界（O5 拆分）。
import { verdict, boundary } from './runner.js';
import type { TestContext } from './runner.js';

export async function runSmoke(ctx: TestContext): Promise<void> {
  const { client, term } = ctx;
  // 命令冒烟只走 WebContainer/Lifo。这里覆盖标准命令组合和 succinix 管理命名空间，
  // 浏览器层不再维护第二套命令表。
  const smokeCommands: string[] = [
    'printf smoke',
    'pwd',
    'env | sort',
    'echo smoke | grep smoke',
    'test 1 = 1',
    'ls /workspace',
    'ps | head',
    'systemctl status | head',
    'succinix doctor',
    'succinix capabilities',
    'succinix runtime',
  ];
  const smokeFails: string[] = [];
  for (const cmd of smokeCommands) {
    try {
      const result = await client.terminal(cmd, undefined, 30000);
      if (!result.ok) {
        const detail = String(result.stderr || result.error || `exit ${result.exitCode}`).replace(/\s+/g, ' ').trim();
        smokeFails.push(`${cmd}: ${detail.slice(0, 100)}`);
      }
    } catch (e) {
      smokeFails.push(`${cmd}: ${String(e).slice(0, 100)}`);
    }
  }
  if (smokeFails.length === 0) {
    verdict(term, 'Smoke', `execution-world command dispatch (${smokeCommands.length})`, true, smokeCommands.join(' '));
  } else {
    verdict(term, 'Smoke', 'execution-world command dispatch', false, smokeFails.join('; '));
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
