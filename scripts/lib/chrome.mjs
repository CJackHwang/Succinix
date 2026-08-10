// Chrome 发现 / 启动 / 清理（O6 拆分）：verify-deploy / verify-bootgate / bench /
// scenarios / lang-verify / instance-demo 六个 CDP 脚本共用，各脚本只保留业务场景。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

// 启动 headless Chrome（remote debugging + 独立临时 profile）。label 用作临时目录前缀
// （succinix-<label>-*），方便排查残留。返回 { chrome, profileDir }。
export function launchChrome(debugPort, label = 'succinix') {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('headless Chrome not found');
  const profileDir = mkdtempSync(join(tmpdir(), `succinix-${label}-`));
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });
  return { chrome, profileDir };
}

// 终止 Chrome 并清理临时 profile（SIGKILL：headless 下保证退出，不阻塞脚本收尾）。
export function cleanupChrome(chrome, profileDir) {
  try {
    chrome?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  if (profileDir) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
}
