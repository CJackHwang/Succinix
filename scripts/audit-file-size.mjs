#!/usr/bin/env node
// 文件规模审计（O12）：输出 src/、scripts/ 前 20 大文件与行数阈值。
//
// 阈值（MASTER-PLAN-NEXT 基线）：src/**/*.ts <= 450 行，scripts/**/*.mjs <= 700 行。
// 阶段策略：O7-O11 拆分完成后，check/CI 以 --fail 调用（超限即 fail）；不带参数时为
// 手动 inspection 模式（只提示不 fail）。O9 条件延后例外见 EXEMPTIONS。
//
// 用法：
//   node scripts/audit-file-size.mjs [--fail]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const FAIL = process.argv.includes('--fail');

// O9 条件延后豁免：终端功能未扩展前不拆分 src/terminal/session.ts（486 行 > 450）。
// 豁免原因见 docs/MASTER-PLAN-NEXT.md TASK-O9；执行 O9 时移除本条目并重新收口。
const EXEMPTIONS = {
  'terminal/session.ts': 'O9 deferred until terminal features are extended',
};

// ─── 收集树内目标文件（.ts / .mjs，跳过 .sh 等辅助文件）───
function collectFiles(dir, ext, out = [], prefix = '') {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, ext, out, rel);
    } else if (name.endsWith(ext)) {
      out.push({ rel, lines: readFileSync(full, 'utf8').split('\n').length - 1 });
    }
  }
  return out;
}

const SRC_FILES = collectFiles(join(ROOT, 'src'), '.ts');
const SCRIPTS_FILES = collectFiles(join(ROOT, 'scripts'), '.mjs');
const LIMITS = [
  { label: 'src/**/*.ts', files: SRC_FILES, max: 450 },
  { label: 'scripts/**/*.mjs', files: SCRIPTS_FILES, max: 700 },
];

let over = [];
let total = 0;
for (const { label, files, max } of LIMITS) {
  const sorted = [...files].sort((a, b) => b.lines - a.lines);
  console.log(`\n=== ${label} (${files.length} files, limit ${max} lines) ===`);
  for (const f of sorted.slice(0, 20)) {
    const exempt = EXEMPTIONS[f.rel];
    const flag = f.lines > max ? (exempt ? '[EXEMPT]' : FAIL ? '[ FAIL ]' : '[ WARN ]') : '        ';
    console.log(`  ${flag} ${f.lines.toString().padStart(5)} ${f.rel}`);
  }
  for (const f of files) {
    total += f.lines;
    if (f.lines > max && !EXEMPTIONS[f.rel]) over.push({ ...f, max, label });
  }
}

console.log(`\nTotal lines: ${total}`);
for (const [rel, reason] of Object.entries(EXEMPTIONS)) {
  console.log(`  [EXEMPT] ${rel} (${reason})`);
}
if (over.length === 0) {
  console.log(`${FAIL ? '[  OK  ]' : '[  OK  ]'} no files over limit`);
  process.exit(0);
}
console.log(`${FAIL ? '[ FAIL ]' : '[ WARN ]'} ${over.length} file(s) over limit:`);
for (const f of over) {
  console.log(`  ${f.rel} (${f.lines} > ${f.max}) [${f.label}]`);
}
process.exit(FAIL ? 1 : 0);
