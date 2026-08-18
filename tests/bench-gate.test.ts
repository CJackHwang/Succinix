import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isClassifiedTransient } from '../scripts/bench-gate.mjs';
import { hasCompleteOrderedSequence } from '../scripts/soak-gate.mjs';

describe('性能门禁定义', () => {
  it('对交互帧与 10k session append 的 P95 使用 50ms 上限', async () => {
    const source = await readFile(new URL('../scripts/bench-gate.mjs', import.meta.url), 'utf8');
    expect(source).toContain("{ key: 'interactive_key_to_frame_ms.p95', max: 50, varianceKey: 'interactive_key_to_frame_ms.p50' }");
    expect(source).toContain("{ key: 'session_append_ms.p95', max: 50, varianceKey: 'session_append_ms.p50' }");
  });

  it('以完成一帧渲染后的大输出耗时判断 UI 卡顿', async () => {
    const source = await readFile(new URL('../scripts/bench-gate.mjs', import.meta.url), 'utf8');
    expect(source).toContain("{ key: 'xterm_big.renderP95' }");
    expect(source).not.toContain("{ key: 'xterm_big.ms' }");
  });

  it('不把未定义预算的冷启动观测值纳入方差失败条件', async () => {
    const source = await readFile(new URL('../scripts/bench-gate.mjs', import.meta.url), 'utf8');
    expect(source).not.toContain("{ key: 'boot_ms.prompt' }");
  });

  it('逐轮约束交互 P95，并以同一路径的 P50 检查稳定性', async () => {
    const [source, benchSource] = await Promise.all([
      readFile(new URL('../scripts/bench-gate.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/bench.mjs', import.meta.url), 'utf8'),
    ]);
    expect(source).toContain("{ key: 'cmd_lifo_ms.p95', max: 250, varianceKey: 'cmd_lifo_ms.p50' }");
    expect(source).toContain("{ key: 'cmd_node_ms.p95', max: 500, varianceKey: 'cmd_node_ms.mean' }");
    expect(source).toContain("{ key: 'interactive_key_to_frame_ms.p95', max: 50, varianceKey: 'interactive_key_to_frame_ms.p50' }");
    expect(benchSource).toContain('mean: Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100,');
    expect(source).toContain('const worst = Math.max(...numeric);');
  });

  it('仅在构建输入与执行环境相同的时候比较历史基线', async () => {
    const source = await readFile(new URL('../scripts/bench-gate.mjs', import.meta.url), 'utf8');
    expect(source).toContain("'public/sha256.json'");
    expect(source).toContain("'packages/engine/assets/sha256.json'");
    expect(source).toContain("'--record-baseline'");
    expect(source).toContain('function validateBaseline(baseline, inputs, environment, summary)');
    expect(source).toContain('baseline is not a verified artifact');
    expect(source).toContain('historical regression comparison requires matching build inputs and benchmark environment');
  });

  it('仅对明确分类的浏览器或端口暂态错误重试', async () => {
    const source = await readFile(new URL('../scripts/bench-gate.mjs', import.meta.url), 'utf8');
    expect(source).toContain('MAX_TRANSIENT_RETRIES = 1');
    expect(source).toContain('EADDRINUSE|ECONNRESET|ECONNREFUSED');
    expect(source).toContain('classified transient browser bootstrap/port error');
  });

  it('只将未进入应用启动阶段的页面停滞视为可重试暂态错误', () => {
    expect(isClassifiedTransient(new Error('BENCH_BOOTSTRAP_STALL: only initial startup status remained'))).toBe(true);
    expect(isClassifiedTransient(new Error('hook not ready: application startup failed'))).toBe(false);
    expect(isClassifiedTransient(new Error('Chrome stderr: net_error -100'))).toBe(true);
  });

  it('严格拒绝终端 marker 的乱序、重复和缺失', () => {
    expect(hasCompleteOrderedSequence([0, 1, 2], 3)).toBe(true);
    expect(hasCompleteOrderedSequence([1, 0, 2], 3)).toBe(false);
    expect(hasCompleteOrderedSequence([0, 1, 1], 3)).toBe(false);
    expect(hasCompleteOrderedSequence([0, 2], 3)).toBe(false);
  });

  it('soak 对在途 respawn 与真实 terminal frame 分别设置断言', async () => {
    const source = await readFile(new URL('../scripts/soak-gate.mjs', import.meta.url), 'utf8');
    expect(source).toContain('10k RPC batch');
    expect(source).toContain('during host respawn');
    expect(source).toContain('INPUT_OUTPUT_PAIRS = 50_000');
    expect(source).toContain('completeSequence');
    expect(source).toContain('independentPortClosed');
  });

  it('完整浏览器 CI 保存基线与运行时资产哈希', async () => {
    const source = await readFile(new URL('../.github/workflows/e2e-full.yml', import.meta.url), 'utf8');
    expect(source).toContain('name: Upload benchmark evidence');
    expect(source).toContain('if: always()');
    expect(source).toContain('docs/benchmark-baseline-v0.7.0.json');
    expect(source).toContain('public/sha256.json');
    expect(source).toContain('packages/engine/assets/sha256.json');
  });
});
