#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SOURCE_ROOT = resolve('src');
const PERSIST_ROOT = resolve(SOURCE_ROOT, 'persist');
const V2_DATABASE = 'succinix-persist-v2';
const LEGACY_DATABASE = 'succinix-persist';

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry)) files.push(path);
  }
  return files;
}

function quotedLiteral(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(["'\u0060])${escaped}\\1`);
}

const production = sourceFiles(SOURCE_ROOT).map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}));
const persistence = production.filter(({ path }) => path.startsWith(`${PERSIST_ROOT}/`));

const hasV2Default = persistence.some(({ text }) => quotedLiteral(V2_DATABASE).test(text));
const hasLegacyDetection = persistence.some(({ text }) => quotedLiteral(LEGACY_DATABASE).test(text));
const deletesLegacy = production.filter(({ text }) => {
  return /indexedDB\s*\.\s*deleteDatabase\s*\(\s*(["'])succinix-persist\1\s*\)/.test(text);
});

let failed = false;
function assert(ok, message) {
  if (ok) console.log(`[  OK  ] ${message}`);
  else {
    console.error(`[ FAIL ] ${message}`);
    failed = true;
  }
}

assert(hasV2Default, `production persistence declares the v0.7 database ${V2_DATABASE}`);
assert(hasLegacyDetection, `production persistence retains explicit detection for ${LEGACY_DATABASE}`);
assert(
  deletesLegacy.length === 0,
  deletesLegacy.length === 0
    ? `production code never deletes ${LEGACY_DATABASE}`
    : `production code deletes ${LEGACY_DATABASE}: ${deletesLegacy.map(({ path }) => path).join(', ')}`,
);

if (failed) process.exitCode = 1;
