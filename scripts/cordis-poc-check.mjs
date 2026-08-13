// C0 browser check: run the Cordis WebContainer POC in headless Chrome.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPageCDP, evalValue } from './lib/cdp.mjs';
import { launchChrome, cleanupChrome } from './lib/chrome.mjs';
import { sleep, waitForHttp } from './lib/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const port = 7893;
const debugPort = 9333;

async function main() {
  const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', join(root, 'examples', 'cordis-poc', 'vite.config.ts'), '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let chrome;
  let profileDir;
  let cdp;
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, 30000);
    ({ chrome, profileDir } = launchChrome(debugPort, 'cordis-poc'));
    cdp = await connectPageCDP(debugPort);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    const deadline = Date.now() + 120000;
    let text = '';
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        text = String(await evalValue(cdp, 'document.getElementById("log").innerText'));
      } catch {
        continue;
      }
      if (text.includes('dsh core lifecycle: PASS') && text.includes('WebContainer + Cordis coexistence: PASS')) {
        console.log('[  OK  ] dsh POC browser check passed');
        console.log(text);
        process.exitCode = 0;
        return;
      }
      if (text.includes('FAIL')) {
        console.error('[ FAIL ] cordis POC browser check failed');
        console.error(text);
        process.exitCode = 1;
        return;
      }
    }
    console.error(`[ FAIL ] cordis POC browser check timed out; last log:\n${text}`);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (chrome) cleanupChrome(chrome, profileDir);
    vite.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
