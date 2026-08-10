// 开发钩子（TASK18/TASK19/TASK16）：bench / scenario / 自检结果 window 句柄（O2 拆分）。
import type { Terminal } from '@xterm/xterm';
import type { TerminalClient } from '../engine/index.js';
import type { FileSystemAPI, WebContainer } from '@webcontainer/api';
import type { SuccinixTerminalSession } from '../terminal/index.js';
import type { SuccinixServices } from '../boot.js';
import type { TestResult } from '../tests.js';
import { AMBER, RED, RESET } from '../theme.js';

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
// 与 execute() 相同分发路径（本地命令经 session.dispatchLocal 捕获，host 命令走 rpcExec），
// 输出改为结构化捕获（capture shim）。timeoutMs 仅约束 host 命令的 RPC 等待。
export async function scenarioRun(
  session: SuccinixTerminalSession,
  services: SuccinixServices,
  cmd: string,
  timeoutMs = 60000
): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const [word, ...args] = cmd.trim().split(/\s+/);
  let handled: boolean;
  try {
    handled = await session.dispatchLocal(word ?? '', args, {
      write: (d: string) => void lines.push(d),
      clear: () => {},
    });
  } catch (e) {
    return { handled: true, ok: false, error: String(e), output: lines.join('\n'), lines };
  }
  if (handled) {
    return { handled: true, ok: true, output: lines.join('\n'), lines };
  }
  const rpc = await session.rpcExec(cmd, timeoutMs);
  if ('error' in rpc) {
    return { handled: false, ok: false, error: rpc.error, thrown: true };
  }
  const res = rpc.res;
  return {
    handled: false,
    ok: res.ok,
    exitCode: res.exitCode,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
    runtime: res.runtime,
    error: res.error,
    message: res.message,
    pid: res.pid,
    processes: res.processes,
    killed: res.killed,
    kind: res.kind,
  };
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
  client: TerminalClient;
  wc: WebContainer;
  ports: Map<number, string>;
  term: Terminal;
  saveSnapshot: ((fs: FileSystemAPI, force?: boolean) => Promise<unknown>) | ((force?: boolean) => Promise<unknown>);
  run: (cmd: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
}): void {
  if (opts.benchMode) {
    (window as unknown as { __succinixBench?: unknown }).__succinixBench = { client: opts.client, wc: opts.wc, term: opts.term, saveSnapshot: opts.saveSnapshot };
  }
  if (opts.scenarioMode) {
    (window as unknown as { __succinixScenario?: unknown }).__succinixScenario = {
      booted: true,
      client: opts.client,
      wc: opts.wc,
      ports: opts.ports,
      term: opts.term,
      saveSnapshot: opts.saveSnapshot,
      run: opts.run,
    };
  }
}
