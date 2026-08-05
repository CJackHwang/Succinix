#!/usr/bin/env node
// Succinix dev server wrapper (TASK23): Vite must serve on the fixed port 7892
// (COOP/COEP headers + WebContainer require a stable origin; port drift breaks the
// environment check). Before starting Vite, check whether 7892 is already in use and
// kill the owning process so a stale dev server cannot shadow the new one.
import { spawn, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 7892;
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPortInUse(port) {
  // 探测 IPv4 与 IPv6 双栈（macOS 上 node 常监听 [::1]，仅试 127.0.0.1 会漏判）。
  return new Promise((resolve) => {
    let pending = 2;
    let used = false;
    const done = () => {
      pending -= 1;
      if (pending === 0) resolve(used);
    };
    for (const host of ['127.0.0.1', '::1']) {
      const sock = createConnection({ port, host });
      sock.once('connect', () => {
        used = true;
        sock.destroy();
        done();
      });
      sock.once('error', () => done());
    }
  });
}

// Find the PID of the process listening on `port` via lsof (macOS/Linux). Returns null when
// lsof is missing or nothing matches.
function findPid(port) {
  try {
    const line = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).trim().split('\n')[0];
    return line ? Number(line) : null;
  } catch {
    return null;
  }
}

async function freePort(port) {
  if (!(await isPortInUse(port))) return;
  console.log(`[start-dev] port ${port} is already in use — killing the process that owns it...`);
  const pid = findPid(port);
  if (!pid) {
    console.error(`[start-dev] port ${port} is in use by an unknown process; cannot free it automatically.`);
    process.exit(1);
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[start-dev] killed PID ${pid} (SIGTERM)`);
  } catch (e) {
    console.error(`[start-dev] failed to kill PID ${pid}: ${String(e)}`);
    process.exit(1);
  }
  // Wait for the port to actually free (graceful shutdown may take a moment).
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!(await isPortInUse(port))) return;
  }
  console.error(`[start-dev] port ${port} is still in use after killing PID ${pid}.`);
  process.exit(1);
}

async function main() {
  await freePort(PORT);
  console.log(`[start-dev] starting Vite on http://localhost:${PORT}/ ...`);
  const vite = spawn(process.execPath, [VITE_BIN], { cwd: ROOT, stdio: 'inherit' });
  vite.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

main().catch((e) => {
  console.error(`[start-dev] failed: ${String(e)}`);
  process.exit(1);
});
