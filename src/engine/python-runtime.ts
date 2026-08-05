// WebUnix python runtime — CLI entry for the built-in language runtime (TASK23).
// System asset: bundled by scripts/build-host.mjs into public/python/python-runtime.js,
// then lazily injected into the container next to its runtime assets (python.wasm,
// python-stdlib.zip, kernel.wasm) on first use. Runs python-wasm (Python 3.11) inside a
// node child process spawned by the host on `python` / `python3`.
//
// Usage:
//   node python-runtime.js -c "<code>"        execute a code string
//   node python-runtime.js <script.py>        execute a script file (path resolved via host session cwd)
//   node python-runtime.js --version          print Python version
//
// Interactive REPL is intentionally not supported (AGENTS.md interactive-stdin boundary);
// README documents `python -c` usage instead.
//
// NOTE: built as CommonJS so the require-time `__dirname` resolves to the bundle's own
// directory — python-wasm's node.js entry derives python.wasm / python-stdlib.zip from
// `__dirname`, and @cowasm/kernel derives kernel.wasm from it too.
import fs from 'node:fs';
import { syncPython } from 'python-wasm';

const STDERR = process.stderr;

function fail(msg: string): void {
  STDERR.write(msg.endsWith('\n') ? msg : msg + '\n');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    fail('python: interactive REPL is not supported here; use: python -c "<code>" or python <script.py>');
    return 1;
  }

  // Create the interpreter (stdlib filesystem: json/csv/re/math/os/sqlite3 etc., see README
  // support matrix). On failure emit an explicit error and exit non-zero — the host returns
  // stderr verbatim to the user, and the system keeps running (装不坏).
  let python: Awaited<ReturnType<typeof syncPython>>;
  try {
    python = await syncPython({ fs: 'stdlib', env: { PYTHONHOME: '/usr' } });
  } catch (e) {
    fail(`python runtime failed to load: ${String(e)}`);
    return 1;
  }

  if (args[0] === '--version') {
    python.exec('import sys; print(sys.version)');
    return 0;
  }

  if (args[0] === '-c') {
    const code = args[1];
    if (code === undefined) {
      fail('python: -c requires an argument: python -c "<code>"');
      return 2;
    }
    try {
      python.exec(code);
      return 0;
    } catch {
      // The interpreter already wrote its error to stderr; we only set the exit code.
      return 1;
    }
  }

  // Script mode: read the script and execute it. The host spawns us with cwd = session cwd,
  // so a relative path resolves against the session cwd and os.getcwd() follows it.
  const script = args[0];
  let code: string;
  try {
    code = fs.readFileSync(script, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      fail(`python: can't open file '${script}': [Errno 2] No such file or directory`);
      return 2;
    }
    fail(`python: failed to read '${script}': ${String(e)}`);
    return 1;
  }
  try {
    python.exec(code);
    return 0;
  } catch {
    return 1;
  }
}

// CLI entry. The WASM interpreter runs synchronously on the main thread, so when main()
// resolves the work is done and the process can exit with a deterministic code.
main().then(
  (code) => process.exit(code),
  (e) => {
    fail(`python runtime failed: ${String(e)}`);
    process.exit(1);
  }
);
