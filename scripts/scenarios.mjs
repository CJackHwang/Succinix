#!/usr/bin/env node
// Succinix TASK19 高级复杂功能场景测试：headless Chrome + CDP 驱动真实工作流。
// 零新依赖（仿 verify-deploy.mjs / bench.mjs 的 CDP 模式）。每个场景真实执行、真实断言：
//   S1 npm 项目开发闭环       S2 git 操作            S3 数据库全生命周期
//   S4 服务自启               S5 多工作区隔离        S6 队列串行正确性
//   S7 大输出                 S8 持久化压力          S9 错误路径
//   S10 环境边界（reboot）    S11 python 脚本工作流  S12 cd + npm install cwd 同步
//   S13 TS 生态工作流（npm i -D typescript tsx vitest → tsc → node → vitest 1 passed）
//   S14 语言生态防回归套件（&& 链 / 引号保真 / EACCES hint / cwd 装包 / python 管道）
//
// 场景定义按套件拆分（O11）：smoke / services / filesystem / kernel / languages，
// 本文件只保留编排 —— 参数解析、build + preview + CDP 生命周期、句柄恢复（ensureScenario）、
// 崩溃重试与结果汇总；输出顺序与数量与拆分前一致（按 S1-S14 排序）。
//
// 用法：
//   node scripts/scenarios.mjs [--skip-build] [--port 7895]
//   （默认先 npm run build 再用 vite preview 托管 dist/；--skip-build 要求 dist/ 已是最新。）
//   --only S1,S4：只跑指定场景（调试用）。
//
// 页面驱动：?scenario=1 时 main.ts 暴露 window.__succinixScenario = { run, client, wc, ports, saveSnapshot }，
// run(cmd) 走与真实终端 execute() 相同的分发路径（browser 拦截 → host RPC），输出结构化返回。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachPageDiagnostics,
  cleanupChrome,
  launchChrome,
  writeBrowserFailureDiagnostics,
} from './lib/chrome.mjs';
import { connectPageCDP } from './lib/cdp.mjs';
import { run, waitForHttp, makeHarness, note, printChecks, scenarioStats, resetScenarioStats } from './lib/harness.mjs';
import { scenarios as smoke } from './scenarios/smoke.mjs';
import { scenarios as services } from './scenarios/services.mjs';
import { scenarios as filesystem } from './scenarios/filesystem.mjs';
import { scenarios as kernel } from './scenarios/kernel.mjs';
import { scenarios as languages } from './scenarios/languages.mjs';

const ROOT = join(import.meta.dirname, '..');

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const portIdx = args.indexOf('--port');
// 7897 被本机 Clash 代理占用，scenarios 用 7895/7896（与 verify 7892 / bench 7894 错开）。
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 7895;
// --only S1,S4：只跑指定场景（调试用）。
const only = args.includes('--only') ? new Set((args[args.indexOf('--only') + 1] ?? '').split(',')) : null;
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = PORT + 1;

// 场景注册表：套件拼接后按 S1-S14 数值序执行（输出顺序/数量不回归）。
const SCENARIOS = [...smoke, ...services, ...filesystem, ...kernel, ...languages].sort((a, b) =>
  a.id.localeCompare(b.id, 'en', { numeric: true })
);

const scenarioResults = [];

// ─── 主流程 ───
async function main() {
  note('Succinix TASK25 scenario suite (real browser/container, 14 scenarios)');
  resetScenarioStats();

  if (SKIP_BUILD) {
    note('skipping build (--skip-build), using existing dist/');
  } else {
    note('building...');
    await run('npm', ['run', 'build'], { silent: true });
    note('build ok');
  }
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run npm run build first');
  }

  // 启动 vite preview（直接起 vite.js，确保 SIGTERM 杀掉真实服务器而非 npx 包装进程）
  note(`starting vite preview on :${PORT}...`);
  const preview = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  let chrome = null;
  let chromeRun = null;
  let cdp = null;
  let profileDir = null;
  let pageDiagnostics = null;
  let failure = null;
  try {
    await waitForHttp(BASE, 20000);
    note(`preview reachable at ${BASE}`);

    const launched = launchChrome(DEBUG_PORT, 'scenarios');
    chromeRun = launched;
    chrome = launched.chrome;
    profileDir = launched.profileDir;
    cdp = await connectPageCDP(DEBUG_PORT);
    await cdp.send('Log.enable');
    pageDiagnostics = attachPageDiagnostics(cdp);
    await cdp.send('Page.navigate', { url: `${BASE}/?scenario=1` });
    note('waiting for boot + scenario handle...');
    const h = makeHarness(cdp);
    await h.waitForScenario(120000);
    note('scenario handle ready');

    for (const sc of SCENARIOS) {
      if (only && !only.has(sc.id)) continue;
      const started = Date.now();
      let checks = [];
      let crashed = '';
      let attempts = 0;
      while (attempts < 2) {
        attempts++;
        try {
          // 场景前置：句柄必须就绪（页面意外 reload 后自动恢复/主动 reload 自愈）。
          await h.ensureScenario(120000);
          checks = (await sc.run(h)) || [];
          crashed = '';
          break;
        } catch (e) {
          crashed = String(e).slice(0, 300);
          checks = [{ name: `scenario crashed: ${crashed}`, ok: false, detail: '' }];
          if (attempts === 1) {
            console.log(`  [ WARN ] ${sc.id} crashed (${crashed}) — reloading and retrying once`);
            try {
              await h.reloadAndWait(180000);
            } catch (e2) {
              crashed += ` | reload failed: ${String(e2).slice(0, 120)}`;
            }
          }
        }
      }
      const ok = crashed === '' && checks.every((c) => c.ok);
      scenarioResults.push({ id: sc.id, name: sc.name, ok, checks, ms: Date.now() - started });
      console.log(`\n[${sc.id}] ${sc.name} (${Math.round((Date.now() - started) / 1000)}s)`);
      printChecks(checks);
      console.log(`  ${ok ? '\x1b[33m[  OK  ]' : '\x1b[31m[ FAIL ]'}\x1b[0m ${sc.id} ${ok ? 'PASS' : 'FAIL'} (${checks.length} checks)`);
    }

    // 汇总
    const stats = scenarioStats();
    console.log('\n=== SCENARIO SUMMARY ===');
    let passedScenarios = 0;
    for (const r of scenarioResults) {
      const mark = r.ok ? '[  OK  ]' : '[ FAIL ]';
      console.log(`  ${mark} ${r.id} ${r.name} — ${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks`);
      if (r.ok) passedScenarios++;
    }
    console.log(`\nScenarios: ${passedScenarios}/${SCENARIOS.length} passed | checks: ${stats.pass} ok, ${stats.fail} fail`);
    process.exitCode = stats.fail === 0 && passedScenarios === SCENARIOS.length ? 0 : 1;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure) {
      try {
        const diagnostics = await writeBrowserFailureDiagnostics({
          label: 'scenarios',
          error: failure,
          cdp,
          pageDiagnostics,
          chromeRun,
          previewPort: PORT,
          debugPort: DEBUG_PORT,
        });
        note(`failure diagnostics: ${diagnostics.reportPath}`);
      } catch (diagnosticError) {
        note(`failed to collect diagnostics: ${String(diagnosticError)}`);
      }
    }
    pageDiagnostics?.dispose();
    cdp?.close();
    await cleanupChrome(chrome, profileDir);
    preview.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(`[scenarios] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
