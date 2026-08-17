#!/usr/bin/env node

import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST_DIR = resolve('dist');
const HTML_PATH = resolve(DIST_DIR, 'index.html');
const RAW_LIMIT = readLimit('SUCCINIX_MAIN_BUNDLE_MAX_BYTES', 400 * 1024);
const GZIP_LIMIT = readLimit('SUCCINIX_MAIN_BUNDLE_MAX_GZIP_BYTES', 120 * 1024);

function readLimit(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function formatBytes(bytes) {
  return `${bytes} B (${(bytes / 1024).toFixed(1)} KiB)`;
}

function fail(message) {
  console.error(`[ FAIL ] ${message}`);
  process.exitCode = 1;
}

let html;
try {
  html = readFileSync(HTML_PATH, 'utf8');
} catch {
  console.error('[ FAIL ] dist/index.html is missing; run npm run build first');
  process.exit(1);
}

const entryMatch = html.match(/<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/i);
if (!entryMatch) {
  console.error('[ FAIL ] no JavaScript entry was found in dist/index.html');
  process.exit(1);
}

const entryRelative = entryMatch[1].split('?')[0].replace(/^\//, '');
const entryPath = resolve(DIST_DIR, entryRelative);
if (!entryPath.startsWith(`${DIST_DIR}/`)) {
  console.error(`[ FAIL ] entry path escapes dist/: ${entryMatch[1]}`);
  process.exit(1);
}

let entry;
try {
  entry = readFileSync(entryPath);
} catch {
  console.error(`[ FAIL ] JavaScript entry is missing: ${entryRelative}`);
  process.exit(1);
}

const rawBytes = statSync(entryPath).size;
const gzipBytes = gzipSync(entry, { level: 9 }).byteLength;

if (rawBytes >= RAW_LIMIT) {
  fail(`main bundle is ${formatBytes(rawBytes)}; budget is less than ${formatBytes(RAW_LIMIT)}`);
} else {
  console.log(`[  OK  ] main bundle ${formatBytes(rawBytes)} < ${formatBytes(RAW_LIMIT)}`);
}

if (gzipBytes >= GZIP_LIMIT) {
  fail(`main bundle gzip is ${formatBytes(gzipBytes)}; budget is less than ${formatBytes(GZIP_LIMIT)}`);
} else {
  console.log(`[  OK  ] main bundle gzip ${formatBytes(gzipBytes)} < ${formatBytes(GZIP_LIMIT)}`);
}

const hostPath = resolve(DIST_DIR, 'host.js');
let hostSource = '';
try {
  hostSource = readFileSync(hostPath, 'utf8');
} catch {
  fail('dist/host.js is missing');
}

if (hostSource && !/import\(\s*["']\.\/lifo-core\.js["']\s*\)/.test(hostSource)) {
  fail('host.js must load lifo-core.js through a dynamic import');
} else if (hostSource) {
  console.log('[  OK  ] host.js keeps lifo-core.js behind a dynamic import');
}

for (const asset of ['lifo-core.js', 'pyodide', 'ruby', 'wasi', 'selftest', 'scenario', 'bench']) {
  const directPattern = new RegExp(`(?:src|href)=["'][^"']*${asset}`, 'i');
  if (directPattern.test(html)) fail(`dist/index.html eagerly references ${asset}`);
}

if (!process.exitCode) {
  console.log('[  OK  ] initial HTML does not eagerly reference deferred runtime assets');
}
