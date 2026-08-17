// 开发钩子（TASK18/TASK19/TASK16）：bench / scenario / 自检结果 window 句柄（O2 拆分）。
import type { Terminal } from '@xterm/xterm';
import type { RpcTerminalClient, SuccinixHostService, TerminalClient, TerminalExecutor } from '@succinix/engine';
import type { FileSystemAPI, WebContainer } from '@webcontainer/api';
import type { TestResult } from '../selftest/index.js';
import { AMBER, RED, RESET } from '../theme.js';

export interface ScenarioServices {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
}

// 模式（与既有开发钩子形状完全一致，scripts/bench.mjs / scenarios.mjs / verify-deploy.mjs 依赖）。
export const benchMode = new URLSearchParams(location.search).get('bench') === '1';
export const scenarioMode = new URLSearchParams(location.search).get('scenario') === '1';

// TASK18：bench 模式记录首提示符出现时间（基准脚本读 window.__bootTimes.prompt）。
export function benchMarkPrompt(): void {
  if (!benchMode) return;
  const t = (window as unknown as { __bootTimes?: { prompt: number | null } }).__bootTimes;
  if (t && t.prompt === null) t.prompt = performance.now();
}

// ─── 场景测试驱动（TASK19，scripts/scenarios.mjs 用）───
// Scenario commands use the same execution-world batch path as SDK consumers.
// The `handled` field remains for the external scenario harness shape, but no
// browser-local command branch exists anymore.
export async function scenarioRun(
  executor: TerminalExecutor,
  _services: ScenarioServices,
  cmd: string,
  timeoutMs = 60000
): Promise<Record<string, unknown>> {
  try {
    const res = await executor.exec(cmd, { timeoutMs });
    const stdout = String(res.stdout ?? '');
    const stderr = String(res.stderr ?? '');
    return {
      handled: true,
      ok: res.ok,
      output: `${stdout}${stderr}${res.error ? String(res.error) : ''}`,
      lines: `${stdout}${stderr}`.split(/\r?\n/),
      stdout,
      stderr,
      error: res.error,
      thrown: false,
      exitCode: res.exitCode,
      runtime: res.runtime,
      message: res.message,
      pid: res.pid,
      processes: res.processes,
      killed: res.killed,
      kind: res.kind,
    };
  } catch (error) {
    return { handled: true, ok: false, error: String(error), output: String(error), thrown: true };
  }
}

// TASK16：自检结果进终端（complete() 之后、motd 横幅之前）。默认路径与 ?instance= demo 共用。
export function printTestResult(term: Terminal, testResult: TestResult | null, testCrashed: string): void {
  if (testResult) {
    const summary = `Self-test result: ${testResult.pass} passed, ${testResult.fail} failed, ${testResult.skip} skipped`;
    if (testResult.fail > 0) {
      term.writeln(`${RED}${summary}${RESET}`);
      for (const f of testResult.failures) {
        term.writeln(`${RED}  [ FAIL ] ${f}${RESET}`);
      }
    } else {
      term.writeln(`${AMBER}${summary}${RESET}`);
    }
    (window as unknown as { __succinixResult?: { passed: number; failed: number; skipped: number; fails: string[] } }).__succinixResult = {
      passed: testResult.pass,
      failed: testResult.fail,
      skipped: testResult.skip,
      fails: testResult.failures,
    };
  } else if (testCrashed) {
    term.writeln(`${RED}[ FAIL ] self-test crashed: ${testCrashed}${RESET}`);
    // 崩溃也要落到 __succinixResult：verify-deploy 等门禁靠该句柄判定完成，
    // 否则崩溃会被当成 300s 挂起超时，掩盖真实失败（fast-fail 语义）。
    (window as unknown as { __succinixResult?: { passed: number; failed: number; skipped: number; fails: string[] } }).__succinixResult = {
      passed: 0,
      failed: 1,
      skipped: 0,
      fails: [`self-test crashed: ${testCrashed}`],
    };
  }
}

// TASK18/TASK19：bench / scenario 模式暴露内部句柄（形状与 scripts/bench.mjs / scenarios.mjs /
// lang-verify.mjs / instance-demo.mjs 依赖完全一致；saveSnapshot 由调用方按实例键传入）。
export function installDevHooks(opts: {
  benchMode: boolean;
  scenarioMode: boolean;
  host: SuccinixHostService;
  client: TerminalClient;
  wc: WebContainer;
  ports: Map<number, string>;
  term: Terminal;
  interactive: RpcTerminalClient;
  saveSnapshot: ((fs: FileSystemAPI, force?: boolean) => Promise<unknown>) | ((force?: boolean) => Promise<unknown>);
  restoreSnapshot: () => Promise<unknown>;
  run: (cmd: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  respawn: () => Promise<void>;
}): void {
  if (opts.benchMode) {
    (window as unknown as { __succinixBench?: unknown }).__succinixBench = {
      client: opts.client,
      wc: opts.wc,
      host: opts.host,
      term: opts.term,
      interactive: opts.interactive,
      saveSnapshot: opts.saveSnapshot,
      restoreSnapshot: opts.restoreSnapshot,
      respawn: opts.respawn,
    };
  }
  if (opts.scenarioMode) {
    (window as unknown as { __succinixScenario?: unknown }).__succinixScenario = {
      booted: true,
      client: opts.client,
      wc: opts.wc,
      ports: opts.ports,
      term: opts.term,
      saveSnapshot: opts.saveSnapshot,
      restoreSnapshot: opts.restoreSnapshot,
      run: opts.run,
      respawn: opts.respawn,
    };
  }
}
