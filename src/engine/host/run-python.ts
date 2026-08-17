import fs from 'node:fs';
import { tryTokenize } from '../tokenize.js';
import { pythonDaemon, PYTHON_DAEMON_JS } from '../python-daemon-client.js';
import { PIP_PREFIX_RE, pythonRuntimeArgs, capOutput, withEaccesHint } from '../host-route.js';
import { mergedEnvFor, resolveRequestCwd } from './config.js';
import { writeResult } from './rpc.js';
import type { RpcRequestId } from '../rpc-v2.js';
import { PYTHON_TIMEOUT_MS } from './real-binaries.js';

/** Dispatch a direct Python or pip command through the shared Pyodide daemon. */
export async function runPython(
  command: string,
  opts: Record<string, unknown> | undefined,
  reqId: RpcRequestId,
  instanceId: string,
): Promise<void> {
  if (!fs.existsSync(PYTHON_DAEMON_JS)) {
    writeResult(reqId, {
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: 'python runtime failed to load: assets not injected yet - run any other command first, or refresh the page (the runtime is injected on first use)',
      runtime: 'node',
    }, instanceId);
    return;
  }
  const tokenized = tryTokenize(command);
  if (!tokenized.ok) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: tokenized.error, runtime: 'node' }, instanceId);
    return;
  }
  const [, ...rawArgs] = tokenized.tokens;
  const args = PIP_PREFIX_RE.test(command) ? ['-m', 'pip', ...rawArgs] : pythonRuntimeArgs(rawArgs, process.cwd());
  const timeoutMs = typeof opts?.timeout === 'number' ? opts.timeout : PYTHON_TIMEOUT_MS;
  const cwd = resolveRequestCwd(instanceId, opts?.cwd);
  if ('error' in cwd) {
    writeResult(reqId, { ok: false, exitCode: 1, stdout: '', stderr: cwd.error, runtime: 'python' }, instanceId);
    return;
  }
  const result = await pythonDaemon.exec(args, cwd.cwd, timeoutMs, mergedEnvFor(instanceId, opts?.env));
  writeResult(reqId, {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: capOutput(result.stdout),
    stderr: withEaccesHint(capOutput(result.stderr)),
    runtime: 'python',
  }, instanceId);
}
