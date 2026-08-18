#!/usr/bin/env node
// Precise legacy-key gate for the dsh-native migration. Scans for the exact
// old service tokens (ctx.succinix, ctx.succinixState, ctx.succinixPlugins)
// and fails on any occurrence outside the documented historical allowlist.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_SCOPES = ['src', 'tests', 'examples', 'docs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.codex', '.agents']);
const TOKEN_RE = /ctx\.succinix(?:State|Plugins)?\b/g;
// Changelog and migration records may describe the removed surface.
const ALLOWED_PATHS = new Set([
  'CHANGELOG.md',
  'CHANGELOG.zh-CN.md',
  'docs/MIGRATION.md',
]);

function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) filesUnder(full, out);
    else out.push(full);
  }
  return out;
}

function scan(root, scope, allowList) {
  const absRoot = join(root, scope);
  const found = [];
  for (const file of filesUnder(absRoot)) {
    const rel = relative(root, file);
    if (allowList.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(TOKEN_RE)) {
      found.push({ file: rel, line: text.slice(0, match.index).split('\n').length, token: match[0] });
    }
  }
  return found;
}

const scopes = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const targets = scopes.length > 0 ? scopes : DEFAULT_SCOPES;
const countOnly = process.argv.includes('--count');
const found = targets.flatMap((scope) => scan(ROOT, scope, ALLOWED_PATHS));

if (countOnly) {
  console.log(`legacy keys: ${found.length} (${found.map((entry) => entry.token).filter((token, index, all) => all.indexOf(token) === index).join(', ') || 'none'})`);
  for (const entry of found) console.log(`${entry.file}:${entry.line} ${entry.token}`);
  process.exit(0);
}

if (found.length > 0) {
  console.error(`[ FAIL ] legacy dsh keys found (${found.length}):`);
  for (const entry of found) console.error(`  ${entry.file}:${entry.line} ${entry.token}`);
  process.exit(1);
}
console.log(`[  OK  ] legacy keys: no ctx.succinix/ctx.succinixState/ctx.succinixPlugins in ${targets.join(', ')}`);
