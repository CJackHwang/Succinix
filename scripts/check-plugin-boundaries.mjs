#!/usr/bin/env node
// 插件边界门禁（C1）：
//   1. src/engine|terminal|instance|persist|services 不得 import cordis / @deepseek-ai/cordis；
//   2. src/plugin/ 每个文件必须包含 invariant 标记或显式豁免。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE_DIRS = ['src/engine', 'src/terminal', 'src/instance', 'src/persist', 'src/services'];
const PLUGIN_DIR = join(ROOT, 'src', 'plugin');
const CORDIS_IMPORT_RE = /from\s+['"](?:@deepseek-ai\/)?cordis['"]|import\s*\(\s*['"](?:@deepseek-ai\/)?cordis['"]|require\s*\(\s*['"](?:@deepseek-ai\/)?cordis['"]/;

function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) filesUnder(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const failures = [];

for (const dir of CORE_DIRS) {
  const abs = join(ROOT, dir);
  for (const file of filesUnder(abs)) {
    const text = readFileSync(file, 'utf8');
    if (CORDIS_IMPORT_RE.test(text)) {
      failures.push(`${file.replace(ROOT, '.')} must not import cordis or @deepseek-ai/cordis`);
    }
  }
}

for (const file of filesUnder(PLUGIN_DIR)) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('invariant') && !text.includes('// exempt:')) {
    failures.push(`${file.replace(ROOT, '.')} must contain an invariant marker or explicit exemption`);
  }
}

if (failures.length > 0) {
  console.error('[ FAIL ] plugin boundary check failed:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('[  OK  ] plugin boundaries: core dirs have no cordis/@deepseek-ai/cordis imports; plugin files have invariant markers');
