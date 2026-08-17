#!/usr/bin/env node
// Succinix TASK20 e2e 编排：`npm run test:e2e` = build 一次 + 依次跑既有 CDP 脚本。
//   verify-deploy.mjs（部署就绪 + ?test=1 自检）→ bench.mjs（性能）→ scenarios.mjs（场景套件）
//   → lang-verify.mjs（语言生态验证，TASK25）→ instance-demo.mjs（跨容器多实例）
//   → instance-routing.mjs（同页多实例宿主行为，R5）
// 各脚本默认各自 build；这里先 build 一次，再用 --skip-build 依次执行，避免重复构建。
// 零新运行时依赖（复用现有 CDP 脚本 + vite preview）。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const STEPS = [
  { name: 'verify-deploy (deploy gate + self-test)', args: ['scripts/verify-deploy.mjs', '--skip-build'] },
  { name: 'terminal-interactive (xterm to Lifo Shell)', args: ['scripts/terminal-interactive-e2e.mjs', '--skip-build'] },
  { name: 'bench (performance)', args: ['scripts/bench.mjs', '--skip-build'] },
  { name: 'scenarios (14 real-workflow scenarios)', args: ['scripts/scenarios.mjs', '--skip-build'] },
  { name: 'lang-verify (language ecosystem verification)', args: ['scripts/lang-verify.mjs', '--skip-build'] },
  { name: 'instance-demo (multi-instance + multi-user)', args: ['scripts/instance-demo.mjs', '--skip-build'] },
  { name: 'instance-routing (same-page instance routing, R5)', args: ['scripts/instance-routing.mjs', '--skip-build'] },
  { name: 'cordis-app (external dsh-key demo contract)', args: ['scripts/cordis-app-e2e.mjs'] },
];

// flake 策略（R6）：deploy gate 与 scenarios 的 npm install 已知偶发 flake，
// 自动重试一次；其余步骤失败即记，不重试。
const RETRY_ONCE = new Set(['scripts/verify-deploy.mjs', 'scripts/scenarios.mjs']);

let exitCode = 0;

function note(msg) {
  console.log(`[e2e] ${msg}`);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

async function main() {
  note('step 0: production build (single)');
  await run('npm', ['run', 'build']);
  note('build OK');

  for (const s of STEPS) {
    note(`step: ${s.name}`);
    try {
      await run(process.execPath, s.args);
      note(`${s.name}: PASSED`);
    } catch (e) {
      if (RETRY_ONCE.has(s.args[0])) {
        note(`${s.name}: FAILED (${e.message}) — retrying once (known flake gate)`);
        try {
          await run(process.execPath, s.args);
          note(`${s.name}: PASSED after retry`);
          continue;
        } catch (e2) {
          note(`${s.name}: FAILED after retry — ${e2.message}`);
          exitCode = 1;
          continue;
        }
      }
      note(`${s.name}: FAILED — ${e.message}`);
      exitCode = 1;
    }
  }

  note(exitCode === 0 ? 'e2e RESULT: PASSED' : 'e2e RESULT: FAILED');
  process.exitCode = exitCode;
}

main().catch((e) => {
  console.error(`[e2e] FATAL: ${e.stack ?? e}`);
  process.exitCode = 1;
});
