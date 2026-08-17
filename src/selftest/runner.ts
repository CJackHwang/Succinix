// 自动化系统自检（?test=1 时自动运行，boot diagnostics 风格，英文）。
// 断言逻辑与 TASK2 保持一致，只改输出表现形态：专业自检流程而非测试列表。
// O5 拆分：runTests 编排 + 断言输出（verdict/boundary）+ 计数；各域测试见同目录模块。
import type { Terminal } from '@xterm/xterm';
import type { WebContainer } from '@webcontainer/api';
import type { TerminalClient } from '@succinix/engine';
import { AMBER, RED, GRAY, RESET } from '../theme.js';
import { runKernel } from './kernel.js';
import { runFilesystem } from './filesystem.js';
import { runPersistence } from './persistence.js';
import { runConfig } from './config.js';
import { runServices } from './services.js';
import { runPackages } from './packages.js';
import { runProcess } from './process.js';
import { runNetwork } from './network.js';
import { runInfo } from './info.js';
import { runLanguages } from './languages.js';
import { runSmoke } from './smoke.js';

export interface TestContext {
  wc: WebContainer;
  client: TerminalClient;
  ports: Map<number, string>;
  term: Terminal;
}

export interface TestResult {
  pass: number;
  fail: number;
  skip: number;
  /** 失败项列表（TASK16：自检后打印到终端，暗红显示） */
  failures: string[];
}

let pass = 0;
let fail = 0;
let skip = 0;
// TASK16：收集失败项，自检结束后供 main.ts 打印到终端（暗红失败行）。
let failures: string[] = [];

// 断言结果行：[ OK ] 暗橙 / [ FAIL ] 暗红，带关键值（pid/版本/端口）。
export function verdict(term: Terminal, category: string, name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    term.writeln(`${AMBER}[  OK  ]${RESET} ${category}: ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    fail++;
    failures.push(`${category}: ${name}${detail ? ` (${detail})` : ''}`);
    term.writeln(`${RED}[ FAIL ]${RESET} ${category}: ${name}${detail ? ` (${detail})` : ''}`);
  }
}

// 已知边界（CORS/网络/symlink）：不算失败，单独计 skip。
export function boundary(term: Terminal, category: string, name: string, detail = ''): void {
  skip++;
  term.writeln(`${GRAY}[SKIP]${RESET} ${category}: ${name}${detail ? ` (${detail})` : ''}`);
}

export async function runTests(ctx: TestContext): Promise<TestResult> {
  const { client, term } = ctx;
  pass = 0;
  fail = 0;
  skip = 0;
  failures = [];

  term.writeln('Succinix self-test — boot diagnostics');
  term.writeln('');

  // 域顺序 = 原 tests.ts 输出顺序（?test=1 输出不变）。
  await runKernel(ctx);
  await runFilesystem(ctx);
  await runPersistence(ctx);
  await runConfig(ctx);
  await runServices(ctx);
  await runPackages(ctx);
  await runProcess(ctx);
  await runNetwork(ctx);
  await runInfo(ctx);
  await runLanguages(ctx);
  await runSmoke(ctx);

  // ─── 优雅退出 ───
  const pEnd = await client.terminal('exit');
  verdict(term, 'Kernel', 'exit handshake', pEnd.kind === 'bye');

  // ─── 汇总行 ───
  term.writeln('');
  term.writeln(`Self-test result: ${pass} passed, ${fail} failed, ${skip} skipped`);

  return { pass, fail, skip, failures };
}
