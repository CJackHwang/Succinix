#!/usr/bin/env node
// C5 external demo e2e: build the @succinix/engine package, install the
// standalone demo, build it, and run its Cordis contract suite in headless
// Chrome. This proves the demo consumes only the packed artifact.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, cleanupChrome } from './lib/chrome.mjs';
import { connectPageCDP } from './lib/cdp.mjs';
import { run, waitForHttp, sleep } from './lib/harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const DEMO = join(ROOT, 'examples', 'cordis-app');
const PORT = 7895;
const DEBUG_PORT = 7906;
const BASE = `http://127.0.0.1:${PORT}`;
let contractResult = null;

function note(msg) {
  console.log(`[cordis-app] ${msg}`);
}

function check(name, ok, detail = '') {
  console.log(`  ${ok ? '[  OK  ]' : '[ FAIL ]'} ${name}${detail ? ` (${detail.slice(0, 180)})` : ''}`);
  return ok;
}

async function ensureDemoDeps() {
  const required = [
    join(DEMO, 'node_modules', '@succinix', 'engine', 'package.json'),
    join(DEMO, 'node_modules', 'cordis', 'package.json'),
    join(DEMO, 'node_modules', '@webcontainer', 'api', 'package.json'),
  ];
  if (required.every((file) => existsSync(file))) return true;
  note('installing demo dependencies...');
  await run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: DEMO, silent: true });
  return required.every((file) => existsSync(file));
}

async function runHeadlessContract() {
  const { chrome, profileDir } = launchChrome(DEBUG_PORT, 'cordis-app');
  let cdp = null;
  try {
    cdp = await connectPageCDP(DEBUG_PORT);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: '(() => { window.__cordisResult = null; })();',
    });
    await cdp.send('Page.navigate', { url: BASE });

    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const res = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__cordisResult)',
        returnByValue: true,
      });
      if (res.result?.value && res.result.value !== 'null') {
        try {
          return JSON.parse(res.result.value);
        } catch {
          /* retry parse */
        }
      }
    }
    throw new Error('contract did not finish within 600s');
  } finally {
    cdp?.close();
    cleanupChrome(chrome, profileDir);
  }
}

async function main() {
  note(`standalone Cordis app contract (port ${PORT}, debug ${DEBUG_PORT})`);

  note('step 1: building @succinix/engine package');
  await run('npm', ['run', 'build:engine-package'], { cwd: ROOT, silent: true });
  note('package build OK');

  note('step 2: ensuring demo dependencies');
  const depsOk = await ensureDemoDeps();
  if (!depsOk) throw new Error('demo dependencies could not be installed');
  note('dependencies OK');

  note('step 3: building standalone demo');
  await run('npm', ['run', 'build'], { cwd: DEMO, silent: true });
  note('demo build OK');

  note('step 4: starting vite preview...');
  const preview = spawn(process.execPath, [
    join(DEMO, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    '--port',
    String(PORT),
    '--strictPort',
    '--host',
    '127.0.0.1',
  ], { cwd: DEMO, stdio: 'ignore' });

  try {
    await waitForHttp(BASE, 30000);
    contractResult = await runHeadlessContract();
    if (!Array.isArray(contractResult.checks)) throw new Error('contract result has no checks');
    console.log('\n=== CORDIS APP CONTRACT SUMMARY ===');
    for (const item of contractResult.checks) {
      check(item.name, item.ok === true, item.detail);
    }
    console.log(`  Checks: ${contractResult.passed}/${contractResult.checks.length} passed`);
  } finally {
    preview.kill('SIGTERM');
  }

  const ok = (contractResult?.passed ?? 0) > 0 && contractResult?.failed === 0;
  note(ok ? 'RESULT: PASSED — external demo consumes the published artifact' : 'RESULT: FAILED — see checks above');
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error(`[cordis-app] FATAL: ${error.stack ?? error}`);
  process.exitCode = 1;
});
