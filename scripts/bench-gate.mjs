#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runSoakGate } from './soak-gate.mjs';

const args = process.argv.slice(2);
const runs = readIntegerArg('--runs', 3);
const basePort = readIntegerArg('--port', 7894);
const skipBuild = args.includes('--skip-build');
const soak = readStringArg('--soak', '');

if (runs < 3) throw new Error('--runs must be at least 3');

function readIntegerArg(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function readStringArg(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    if (options.capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { process.stderr.write(chunk); });
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function metric(result, path) {
  let value = result;
  for (const key of path.split('.')) value = value?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// 门禁判定：绝对预算（max）逐轮抓结构性退化；20% 方差上限抓轮间不稳定。
// 任何基准语义失败都会让 bench.mjs 非零退出，不能再以零值或负值混入样本。
const DEFAULT_VARIANCE_PCT = readNumberEnv('SUCCINIX_BENCH_MAX_VARIANCE_PCT', 20);
export const PERFORMANCE_METRICS = [
  { key: 'cmd_lifo_ms.p95', max: 250, varianceKey: 'cmd_lifo_ms.p50' },
  { key: 'cmd_node_ms.p95', max: 250, varianceKey: 'cmd_node_ms.mean' },
  { key: 'snapshot1000.snapshotMs', max: 1000 },
  { key: 'xterm_big.renderP95' },
  // Mailbox polling quantizes p95 near a poll boundary. Keep the p95 limit
  // strict for every run, and use the same end-to-end path's p50 for stability.
  { key: 'interactive_key_to_frame_ms.p95', max: 50, varianceKey: 'interactive_key_to_frame_ms.p50' },
  { key: 'session_append_ms.p95', max: 50 },
];

async function runBenchmarkGate() {
  if (!skipBuild) {
    console.error('[bench-gate] building once before benchmark runs');
    await run('npm', ['run', 'build']);
  }

  const results = [];
  for (let index = 0; index < runs; index += 1) {
    const port = basePort + index * 4;
    console.error(`[bench-gate] run ${index + 1}/${runs} on port ${port}`);
    const stdout = await run(
      process.execPath,
      ['scripts/bench.mjs', '--skip-build', '--port', String(port)],
      { capture: true },
    );
    results.push(JSON.parse(stdout));
  }

  let failed = false;
  const summary = {};
  for (const definition of PERFORMANCE_METRICS) {
    const values = results.map((result) => metric(result, definition.key));
    if (values.some((value) => value === null)) {
      console.error(`[ FAIL ] benchmark metric is missing: ${definition.key}`);
      failed = true;
      continue;
    }
    const numeric = /** @type {number[]} */ (values);
    const varianceKey = definition.varianceKey ?? definition.key;
    const varianceValues = varianceKey === definition.key
      ? numeric
      : results.map((result) => metric(result, varianceKey));
    if (varianceValues.some((value) => value === null)) {
      console.error(`[ FAIL ] benchmark stability metric is missing: ${varianceKey}`);
      failed = true;
      continue;
    }
    const stableNumeric = /** @type {number[]} */ (varianceValues);
    const center = median(numeric);
    const stabilityCenter = median(stableNumeric);
    const maxDeviation = stabilityCenter === 0
      ? (stableNumeric.every((value) => value === 0) ? 0 : Number.POSITIVE_INFINITY)
      : Math.max(...stableNumeric.map((value) => Math.abs(value - stabilityCenter) / stabilityCenter * 100));
    const varianceLimitPct = definition.variance ?? DEFAULT_VARIANCE_PCT;
    summary[definition.key] = {
      samples: numeric,
      median: Math.round(center * 100) / 100,
      stabilityKey: varianceKey,
      stabilitySamples: stableNumeric,
      maxDeviationPct: Math.round(maxDeviation * 100) / 100,
    };

    if (maxDeviation > varianceLimitPct) {
      console.error(`[ FAIL ] ${varianceKey} varies ${maxDeviation.toFixed(1)}%; limit is ${varianceLimitPct}%`);
      failed = true;
    } else {
      console.log(`[  OK  ] ${definition.key} median=${center.toFixed(2)}ms ${varianceKey} variance=${maxDeviation.toFixed(1)}%`);
    }

    const worst = Math.max(...numeric);
    if (definition.max !== undefined && worst > definition.max) {
      console.error(`[ FAIL ] ${definition.key} worst=${worst.toFixed(2)}ms; budget is ${definition.max}ms`);
      failed = true;
    }
  }

  console.log(JSON.stringify({ runs, maxVariancePct: DEFAULT_VARIANCE_PCT, summary }, null, 2));
  if (failed) process.exitCode = 1;
}

async function main() {
  if (soak) await runSoakGate({ profile: soak, skipBuild, port: basePort });
  else await runBenchmarkGate();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[ FAIL ] ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
