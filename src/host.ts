// WebUnix POC host v3 — persistent daemon inside WebContainer.
// Channel: FILE-BASED RPC (stdin was found unreliable in this WC environment).
//   browser → /cmd.json   { id, cmd, opts? }
//   host    → /result.json { id, ok, exitCode?, stdout?, stderr? }
// The command file lives on the SHARED filesystem (proven bidirectional),
// so this channel is as reliable as the FS itself.
import { Sandbox } from '@lifo-sh/core';
import fs from 'node:fs';

const CMD_FILE = 'cmd.json';
const RESULT_FILE = 'result.json';

const sandbox = await Sandbox.create({
  mounts: [
    {
      virtualPath: '/workspace',
      hostPath: process.cwd(),
      fsModule: fs as never,
    },
  ],
});
console.log('HOST_READY');

let processedId = -1;
let busy = false;

setInterval(async () => {
  if (busy) return;
  try {
    if (!fs.existsSync(CMD_FILE)) return;
    const raw = fs.readFileSync(CMD_FILE, 'utf8');
    const req = JSON.parse(raw);
    if (typeof req.id !== 'number' || req.id === processedId) return;
    processedId = req.id;
    busy = true;
    let out: Record<string, unknown>;
    if (req.cmd === '__ping__') {
      out = { ok: true, kind: 'pong' };
    } else if (req.cmd === '__cwd__') {
      out = { ok: true, kind: 'cwd', cwd: sandbox.cwd };
    } else if (req.cmd === '__exit__') {
      out = { ok: true, kind: 'bye' };
    } else if (req.cmd === '__spawn_test__') {
      // TerminalExecutor 前提验证：host 进程能否拉起真 Node/npm 子进程
      const { spawn, spawnSync } = await import('node:child_process');
      const runChild = (cmd: string, args: string[]) =>
        new Promise((resolve) => {
          const child = spawn(cmd, args);
          let out = '';
          let err = '';
          child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
          child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
          child.on('close', (code: number | null) => resolve({ code, out: out.trim(), err: err.trim() }));
          child.on('error', (e: Error) => resolve({ error: String(e) }));
        });
      const r1 = await runChild('node', ['-e', 'console.log("child-42"); console.error("child-err"); process.exit(3)']);
      const r2 = await runChild('npm', ['--version']);
      const r3 = spawnSync('node', ['-e', 'console.log("sync-ok")'], { encoding: 'utf8' });
      out = {
        ok: true,
        r1,
        r2,
        r3: { code: r3.status, out: String(r3.stdout ?? '').trim(), err: String(r3.stderr ?? '').trim() },
      };
    } else {
      const r = await sandbox.commands.run(req.cmd, { timeout: 25000, ...(req.opts ?? {}) });
      out = { ok: r.exitCode === 0, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    }
    fs.writeFileSync(RESULT_FILE, JSON.stringify({ id: req.id, ...out }));
    busy = false;
  } catch (e) {
    busy = false;
    try {
      fs.writeFileSync(RESULT_FILE, JSON.stringify({ id: -1, error: String(e).slice(0, 200) }));
    } catch {
      /* FS unavailable */
    }
  }
}, 120);
