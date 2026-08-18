#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const runs = readIntegerArg('--runs', 3);
const basePort = readIntegerArg('--port', 0, { allowZero: true });
const skipBuild = args.includes('--skip-build');
const soak = readStringArg('--soak', '');
const recordBaseline = args.includes('--record-baseline');
const baselinePath = resolve(readStringArg('--baseline', 'docs/benchmark-baseline-v0.7.0.json'));
const ROOT = resolve('.');
const MAX_TRANSIENT_RETRIES = 1;

if (runs < 3) throw new Error('--runs must be at least 3');

function readIntegerArg(name, fallback, { allowZero = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
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

class CommandFailure extends Error {
  constructor(command, code, signal, stdout, stderr) {
    super(`${command} exited with ${code ?? signal ?? 'unknown status'}`);
    this.name = 'CommandFailure';
    this.command = command;
    this.code = code;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    }
    child.once('error', (error) => reject(error));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new CommandFailure(command, code, signal, stdout, stderr));
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function metric(result, path) {
  let value = result;
  for (const key of path.split('.')) value = value?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Gate semantics: every environment must satisfy absolute budgets and stable
// median behavior. Historical regression comparison is valid only when both
// the build inputs and the execution environment match the recorded baseline.
const DEFAULT_VARIANCE_PCT = readNumberEnv('SUCCINIX_BENCH_MAX_VARIANCE_PCT', 20);
export const PERFORMANCE_METRICS = [
  { key: 'cmd_lifo_ms.p95', max: 250, varianceKey: 'cmd_lifo_ms.p50' },
  { key: 'cmd_node_ms.p95', max: 500, varianceKey: 'cmd_node_ms.mean' },
  { key: 'snapshot1000.snapshotMs', max: 1000 },
  { key: 'xterm_big.renderP95' },
  { key: 'interactive_key_to_frame_ms.p95', max: 50, varianceKey: 'interactive_key_to_frame_ms.p50', variance: 30 },
  { key: 'session_append_ms.p95', max: 50, varianceKey: 'session_append_ms.p50' },
];

export function isClassifiedTransient(error) {
  const text = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n');
  return /EADDRINUSE|ECONNRESET|ECONNREFUSED|CDP websocket failed to open|Chrome DevTools endpoint did not come up|Target closed|net::ERR_CONNECTION_RESET|net_error\s*-100|BENCH_BOOTSTRAP_STALL/i.test(text);
}

async function runBenchOnce(index, attempt) {
  const preferredPort = basePort === 0 ? 0 : basePort + index * 8 + attempt * 2;
  const commandArgs = ['scripts/bench.mjs', '--skip-build'];
  if (preferredPort > 0) commandArgs.push('--port', String(preferredPort));
  return run(process.execPath, commandArgs, { capture: true });
}

async function runBenchWithRetry(index) {
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    try {
      const stdout = await runBenchOnce(index, attempt);
      try {
        return JSON.parse(stdout);
      } catch (error) {
        throw new Error(`benchmark JSON output is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    } catch (error) {
      if (attempt < MAX_TRANSIENT_RETRIES && isClassifiedTransient(error)) {
        console.error(`[bench-gate] retrying run ${index + 1}; classified transient browser bootstrap/port error`);
        continue;
      }
      throw error;
    }
  }
  throw new Error('benchmark retry loop exhausted');
}

function hashFile(path) {
  if (!existsSync(path)) throw new Error(`required baseline input is missing: ${path}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`required JSON input is missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runtimeAssetHashes() {
  return {
    public: readJson(join(ROOT, 'public/sha256.json')),
    engine: readJson(join(ROOT, 'packages/engine/assets/sha256.json')),
  };
}

function bundleHashes() {
  const dist = join(ROOT, 'dist');
  const htmlPath = join(dist, 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const entry = html.match(/<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["']/i)?.[1]?.split('?')[0].replace(/^\//, '');
  if (!entry) throw new Error('dist/index.html does not reference a JavaScript entry');
  return {
    indexHtml: hashFile(htmlPath),
    main: hashFile(join(dist, entry)),
    host: hashFile(join(dist, 'host.js')),
    lifoCore: hashFile(join(dist, 'lifo-core.js')),
  };
}

function baselineInputs() {
  const pkg = readJson(join(ROOT, 'package.json'));
  const lock = readJson(join(ROOT, 'package-lock.json'));
  const direct = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].sort();
  const dependencies = Object.fromEntries(direct.map((name) => [name, lock.packages?.[`node_modules/${name}`]?.version ?? null]));
  return {
    package: `${pkg.name}@${pkg.version}`,
    packageJsonSha256: hashFile(join(ROOT, 'package.json')),
    packageLockSha256: hashFile(join(ROOT, 'package-lock.json')),
    dependencies,
    runtimeAssets: runtimeAssetHashes(),
    bundles: bundleHashes(),
  };
}

function validateBaseline(baseline, inputs, environment, summary) {
  const failures = [];
  if (baseline?.schemaVersion !== 1 || baseline?.status !== 'verified') failures.push('baseline is not a verified artifact; run --record-baseline after three successful runs');
  if (!baseline?.recordedAt || !baseline?.inputs || !baseline?.metrics || !baseline?.environment) failures.push('baseline is missing recordedAt, inputs, metrics, or environment');
  const matchingInputs = baseline?.inputs && JSON.stringify(baseline.inputs) === JSON.stringify(inputs);
  const matchingEnvironment = baseline?.environment && JSON.stringify(baseline.environment) === JSON.stringify(environment);
  if (!matchingInputs || !matchingEnvironment) {
    console.log('[SKIP] historical regression comparison requires matching build inputs and benchmark environment');
    return failures;
  }
  if (baseline?.metrics) {
    for (const definition of PERFORMANCE_METRICS) {
      const current = summary[definition.key]?.median;
      const previous = baseline.metrics[definition.key]?.median;
      if (typeof current !== 'number' || typeof previous !== 'number') continue;
      if (previous > 0 && ((current - previous) / previous) * 100 > readNumberEnv('SUCCINIX_BENCH_MAX_BASELINE_REGRESSION_PCT', 20)) {
        failures.push(`${definition.key} regressed from ${previous}ms to ${current}ms against baseline`);
      }
    }
  }
  return failures;
}

async function runBenchmarkGate() {
  if (!skipBuild) {
    console.error('[bench-gate] building once before benchmark runs');
    await run('npm', ['run', 'build']);
  }
  const results = [];
  for (let index = 0; index < runs; index += 1) {
    console.error(`[bench-gate] run ${index + 1}/${runs} with an isolated preview/debug port pair`);
    results.push(await runBenchWithRetry(index));
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
    const varianceValues = varianceKey === definition.key ? numeric : results.map((result) => metric(result, varianceKey));
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

  const inputs = baselineInputs();
  const current = results.at(-1);
  const baseline = readJson(baselinePath);
  if (recordBaseline) {
    if (failed) {
      console.error('[ FAIL ] refusing to record a baseline because performance gates failed');
    } else {
      const artifact = {
        schemaVersion: 1,
        status: 'verified',
        recordedAt: new Date().toISOString(),
        method: 'Three independent headless Chrome runs; medians and per-run p95 values are retained in this artifact.',
        inputs,
        environment: current.environment,
        metrics: summary,
      };
      writeFileSync(baselinePath, `${JSON.stringify(artifact, null, 2)}\n`);
      console.error(`[bench-gate] recorded verified baseline: ${baselinePath}`);
    }
  } else {
    const baselineFailures = validateBaseline(baseline, inputs, current.environment, summary);
    for (const message of baselineFailures) {
      console.error(`[ FAIL ] ${message}`);
      failed = true;
    }
  }

  console.log(JSON.stringify({ runs, maxVariancePct: DEFAULT_VARIANCE_PCT, baseline: baselinePath, summary }, null, 2));
  if (failed) process.exitCode = 1;
}

async function main() {
  if (soak) {
    const { runSoakGate } = await import('./soak-gate.mjs');
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
      try {
        await runSoakGate({ profile: soak, skipBuild, port: basePort === 0 ? 0 : basePort + attempt * 4 });
        return;
      } catch (error) {
        if (attempt < MAX_TRANSIENT_RETRIES && isClassifiedTransient(error)) {
          console.error('[bench-gate] retrying soak; classified transient browser bootstrap/port error');
          continue;
        }
        throw error;
      }
    }
  } else {
    await runBenchmarkGate();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[ FAIL ] ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
