#!/usr/bin/env node
// 文档/引用完整性检查（O14）：扫描 .md 中引用的本地文件路径与文档名，缺失即失败；
// 同时捕获旧文档删除后的断链（如指向已删除 MASTER-PLAN.md / ENGINEERING-REVIEW.md 的引用）。
//
// 检查对象：
//   1. Markdown 链接 [t](path) 与引用式 [t]: path（去掉 #fragment 后校验）
//   2. 反引号代码片段中形似本地路径的 token（含 / 或已知扩展名，且不含空格/通配/URL 特征）
// 解析顺序：先按仓库根，再按 .md 所在目录；任一命中即通过。
//
// 用法：
//   node scripts/check-docs.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.codex', '.agents', 'contracts']);
const EXT_RE = /\.(md|ts|mjs|js|cjs|json|yml|yaml|sh|html|css|tsx|svg|png|ico|txt|wasm|lock)$/;
// 有意提及已删除文档的引用（MASTER-PLAN-NEXT 开篇说明旧计划文件已删除）。
const ALLOW_MISSING = new Set(['MASTER-PLAN.md', 'ENGINEERING-REVIEW.md']);
// 非仓库文件的容器资产 / SDK 导出子路径（描述运行时布局，不存在于仓库根）。
// succinix/* 是真实内部事件名（反引号写法会被路径候选逻辑命中），不是失效文档链接。
const ALLOW_NON_REPO = new Set([
  'host.js',
  './host.js',
  'lifo-core.js',
  './lifo-core.js',
  // File-RPC channel artifacts inside the container, documented but not repo files.
  'cmd.json',
  'public/host.js',
  'public/lifo-core.js',
  'packages/engine/assets/sha256.json',
  'assets/sha256.json',
  'dist/',
  './terminal',
  './instance',
  'sha256.json',
  'succinix/state',
  'succinix/server-ready',
  'succinix/server-closed',
  'succinix/command',
  'succinix/command-start',
  'succinix/command-finish',
  'succinix/runtime-ready',
  'succinix/degradation',
  'succinix/persistence',
  'succinix/terminal-open',
  'succinix/terminal-close',
  'succinix/terminal-backpressure',
  'succinix/instance',
  'succinix/workspace',
  'succinix/process',
  // Runtime identifiers and file-type mentions, not local references.
  'succinix-linux-userland/0.7',
  'requirements.txt',
]);

function collectMds(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    // CHANGELOG 是历史记录：其中路径指向当时文件，不做完整性校验。
    if (statSync(full).isDirectory()) collectMds(full, out);
    // 计划文档允许引用未来路径与外部仓库，不做当前仓库完整性校验。
    else if (name.startsWith('PLAN-') && name.endsWith('.md')) continue;
    else if (name.startsWith('CHANGELOG')) continue;
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

// 反引号 token → 路径候选：形似本地路径才检查（排除命令、URL、容器绝对路径、占位符等）。
function isPathCandidate(token) {
  if (!token || token.length > 200) return false;
  if (/[\s()<>*?$"'`{}]/.test(token)) return false;
  // 中文/全角标点 + 斜杠多为行文（如"进程/服务"），不是路径。
  if (/[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]/.test(token)) return false;
  if (/^(https?:|mailto:|www\.|#|\/|@|~|\{)/.test(token)) return false;
  if (token.startsWith('[') || token.endsWith(']')) return false;
  if (/^\.[a-z0-9]+$/i.test(token)) return false; // 纯扩展名（.md / .ts）
  return token.includes('/') || EXT_RE.test(token);
}

function candidatesFromSource(text) {
  const out = new Set();
  // [t](path) 与 [t]: path
  const linkRe = /\[[^\]]*\]\(([^)]+)\)|^\s*\[[^\]]+\]:\s*(\S+)/gm;
  for (const m of text.matchAll(linkRe)) {
    const raw = (m[1] ?? m[2] ?? '').trim().replace(/^<|>$/g, '').split('#')[0];
    if (raw && isPathCandidate(raw)) out.add(raw);
  }
  // 反引号 token
  const tickRe = /`([^`]+)`/g;
  for (const m of text.matchAll(tickRe)) {
    const token = m[1].trim();
    if (isPathCandidate(token)) out.add(token);
  }
  return out;
}

function check(mdFile) {
  const text = readFileSync(mdFile, 'utf8');
  const missing = [];
  for (const candidate of candidatesFromSource(text)) {
    if (ALLOW_MISSING.has(candidate)) continue;
    if (ALLOW_NON_REPO.has(candidate)) continue;
    const rel = mdFile.replace(ROOT, '.').replace(/^\.[/\\]/, '');
    const candidates = [resolve(ROOT, candidate), resolve(dirname(mdFile), candidate)];
    if (!candidates.some((p) => existsSync(p))) missing.push(`${rel}: ${candidate}`);
  }
  return missing;
}

const mdFiles = collectMds(ROOT);
const allMissing = [];
for (const f of mdFiles) allMissing.push(...check(f));

if (allMissing.length > 0) {
  console.error(`[ FAIL ] docs integrity: ${allMissing.length} broken reference(s)`);
  for (const m of allMissing) console.error(`  ${m}`);
  process.exit(1);
}
console.log(`[  OK  ] docs integrity: ${mdFiles.length} markdown files, no broken local references`);
