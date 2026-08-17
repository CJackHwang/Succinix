#!/usr/bin/env node

import { readFileSync } from 'node:fs';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function compareNames(a, b) {
  return a.localeCompare(b, 'en');
}

function directDependencies(pkg) {
  return [
    ...Object.entries(pkg.dependencies ?? {}).map(([name, spec]) => ({ scope: 'runtime', name, spec })),
    ...Object.entries(pkg.devDependencies ?? {}).map(([name, spec]) => ({ scope: 'development', name, spec })),
  ].sort((a, b) => compareNames(a.name, b.name));
}

function collectLicenses(lock) {
  const counts = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || !path.startsWith('node_modules/')) continue;
    const license = typeof entry.license === 'string' && entry.license.trim() ? entry.license.trim() : 'UNSPECIFIED';
    counts.set(license, (counts.get(license) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || compareNames(a[0], b[0]));
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const direct = directDependencies(pkg);
const runtimeCount = direct.filter((item) => item.scope === 'runtime').length;
const devCount = direct.filter((item) => item.scope === 'development').length;
const transitiveCount = Math.max(0, Object.keys(lock.packages ?? {}).filter((path) => path.startsWith('node_modules/')).length - direct.length);

console.log('Dependency report');
console.log(`package: ${pkg.name}@${pkg.version}`);
console.log(`direct: ${direct.length} (${runtimeCount} runtime, ${devCount} development)`);
console.log(`transitive: ${transitiveCount}`);
console.log('');
console.log('Direct dependencies:');
for (const item of direct) {
  console.log(`  ${item.scope.padEnd(11)} ${item.name}@${item.spec}`);
}
console.log('');
console.log('License summary:');
for (const [license, count] of collectLicenses(lock).slice(0, 20)) {
  console.log(`  ${String(count).padStart(4)} ${license}`);
}
console.log('[  OK  ] dependency report generated from package-lock.json');
