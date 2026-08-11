#!/usr/bin/env node
// 静态自检（AGENTS.md Quality Gates）：src/ 与 index.html 禁止 emoji 与 GREEN 常量。
// 等价于：grep -n '✅\|❌\|🎉\|GREEN' src/ index.html（跨平台 Node 实现）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PATTERN = /✅|❌|🎉|GREEN/;
const TARGETS = [join(ROOT, 'src'), join(ROOT, 'index.html')];

const hits = [];
function scanFile(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) hits.push(`${file.replace(ROOT, '.')}:${i + 1}: ${lines[i].trim()}`);
  }
}
function scanDir(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) scanDir(full);
    else scanFile(full);
  }
}

for (const target of TARGETS) {
  if (statSync(target).isDirectory()) scanDir(target);
  else scanFile(target);
}

if (hits.length > 0) {
  console.error('[ FAIL ] static self-check found forbidden content:');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log('[  OK  ] static self-check: no emoji / GREEN in src/ and index.html');
