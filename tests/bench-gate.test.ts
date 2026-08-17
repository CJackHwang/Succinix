import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('性能门禁定义', () => {
  it('对交互帧与 10k session append 的 P95 使用 50ms 上限', async () => {
    const source = await readFile(new URL('../scripts/bench-gate.mjs', import.meta.url), 'utf8');
    expect(source).toContain("{ key: 'interactive_key_to_frame_ms.p95', max: 50, varianceKey: 'interactive_key_to_frame_ms.p50' }");
    expect(source).toContain("{ key: 'session_append_ms.p95', max: 50 }");
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
    expect(source).toContain("{ key: 'cmd_node_ms.p95', max: 250, varianceKey: 'cmd_node_ms.mean' }");
    expect(source).toContain("{ key: 'interactive_key_to_frame_ms.p95', max: 50, varianceKey: 'interactive_key_to_frame_ms.p50' }");
    expect(benchSource).toContain('mean: Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100,');
    expect(source).toContain('const worst = Math.max(...numeric);');
  });
});
