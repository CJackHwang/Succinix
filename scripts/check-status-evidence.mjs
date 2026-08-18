#!/usr/bin/env node
// 状态仪表盘只接受与当前提交和执行环境绑定的结构化证据，避免历史结论被误当成当前事实。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const fileArg = argumentValue('--file');
const statusPath = resolve(ROOT, fileArg ?? 'STATUS.md');
const REQUIRED_SECTIONS = [
  '一、架构健康度',
  '二、本次变更影响范围',
  '三、已知风险点',
  '四、下次最该做的事',
];
const RESULT_VALUES = new Set(['passed', 'failed', 'blocked', 'skipped']);
export const REQUIRED_GATE_COMMANDS = [
  'npx tsc -p tsconfig.json --noEmit',
  'node scripts/build-host.mjs',
  'npm run build',
  'npm run lint',
  'npm run test',
  'npm run test:coverage',
  'npm run check:docs',
  'npm run check:plugin-boundaries',
  'npm run check:engine-package',
  'npm run test:e2e',
  'npm run test:bench',
  'npm run test:bench:soak',
];
const REQUIRED_GATE_COMMAND_SET = new Set(REQUIRED_GATE_COMMANDS);
const SHA256_RE = /^[a-f0-9]{64}$/;

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function evidenceHeadContext() {
  const currentHead = gitOutput(['rev-parse', 'HEAD']);
  if (!currentHead) throw new Error('unable to resolve current HEAD');
  const parentHead = gitOutput(['rev-parse', 'HEAD^']);
  const parentChangedPaths = parentHead
    ? (gitOutput(['diff', '--name-only', 'HEAD^', 'HEAD', '--']) ?? '').split('\n').filter(Boolean)
    : [];
  return { currentHead, parentHead, parentChangedPaths };
}

export function validateEvidenceHead(evidenceHead, { currentHead, parentHead, parentChangedPaths }) {
  if (evidenceHead === currentHead) return undefined;
  if (evidenceHead === parentHead) {
    if (parentChangedPaths.length === 1 && parentChangedPaths[0] === 'STATUS.md') return undefined;
    return 'head may equal the parent commit only when the current commit changes only STATUS.md';
  }
  return `head must equal current HEAD ${currentHead}, or its parent when the current commit changes only STATUS.md`;
}

function argumentValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function sectionFailures(text) {
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  const names = headings.map((heading) => heading[1]);
  const failures = [];
  if (names.length !== REQUIRED_SECTIONS.length || names.some((name, index) => name !== REQUIRED_SECTIONS[index])) {
    failures.push(`expected exactly these sections in order: ${REQUIRED_SECTIONS.join(', ')}`);
    return failures;
  }
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? text.length;
    if (!text.slice(start, end).trim()) failures.push(`section is empty: ${REQUIRED_SECTIONS[index]}`);
  }
  return failures;
}

function parseEvidence(text) {
  const matches = [...text.matchAll(/<!--\s*STATUS_EVIDENCE\s*\n([\s\S]*?)\n\s*-->/g)];
  if (matches.length !== 1) throw new Error('expected exactly one STATUS_EVIDENCE JSON block');
  try {
    return JSON.parse(matches[0][1]);
  } catch (error) {
    throw new Error(`STATUS_EVIDENCE is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function evidenceFailures(evidence, headContext) {
  const failures = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return ['STATUS_EVIDENCE must be an object'];
  if (evidence.schemaVersion !== 2) failures.push('schemaVersion must be 2');
  const headFailure = validateEvidenceHead(evidence.head, headContext);
  if (headFailure) failures.push(headFailure);
  if (!Number.isFinite(Date.parse(evidence.recordedAt))) failures.push('recordedAt must be an ISO date');
  for (const key of ['node', 'platform', 'arch']) {
    if (typeof evidence.environment?.[key] !== 'string' || !evidence.environment[key].trim()) {
      failures.push(`environment.${key} must be a non-empty string`);
    }
  }
  // Evidence is committed from one machine and checked on another. The
  // recorded environment identifies where the commands ran; it is not a
  // portability constraint on the runner performing this structural check.
  if (!Array.isArray(evidence.commands) || evidence.commands.length === 0) {
    failures.push('commands must contain at least one command result');
  } else {
    const presentCommands = new Set();
    for (const [index, command] of evidence.commands.entries()) {
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        failures.push(`commands[${index}] must be an object`);
        continue;
      }
      if (typeof command.command !== 'string' || !command.command.trim()) {
        failures.push(`commands[${index}].command must be a non-empty string`);
      } else if (!REQUIRED_GATE_COMMAND_SET.has(command.command)) {
        failures.push(`commands[${index}].command is not an approved release gate`);
      } else if (presentCommands.has(command.command)) {
        failures.push(`commands[${index}].command is duplicated`);
      } else {
        presentCommands.add(command.command);
      }
      if (!RESULT_VALUES.has(command.result)) {
        failures.push(`commands[${index}].result must be one of ${[...RESULT_VALUES].join(', ')}`);
      }
      if (!Number.isInteger(command.exitCode) || command.exitCode < 0 || command.exitCode > 255) {
        failures.push(`commands[${index}].exitCode must be an integer from 0 to 255`);
      } else if (command.result === 'passed' && command.exitCode !== 0) {
        failures.push(`commands[${index}].exitCode must be 0 when result is passed`);
      } else if (command.result !== 'passed' && command.exitCode === 0) {
        failures.push(`commands[${index}].exitCode must be non-zero when result is not passed`);
      }
      if (!Number.isFinite(Date.parse(command.completedAt))) failures.push(`commands[${index}].completedAt must be an ISO date`);
      if (typeof command.outputSha256 !== 'string' || !SHA256_RE.test(command.outputSha256)) failures.push(`commands[${index}].outputSha256 must be a SHA-256 digest`);
      if (typeof command.summary !== 'string' || !command.summary.trim()) failures.push(`commands[${index}].summary must be a non-empty string`);
    }
    for (const required of REQUIRED_GATE_COMMANDS) {
      if (!presentCommands.has(required)) failures.push(`commands must include required release gate: ${required}`);
    }
  }
  return failures;
}

function main() {
  if (!existsSync(statusPath)) throw new Error(`status file does not exist: ${statusPath}`);
  const headContext = evidenceHeadContext();
  const text = readFileSync(statusPath, 'utf8');
  const failures = sectionFailures(text);
  let evidence;
  try {
    evidence = parseEvidence(text);
    failures.push(...evidenceFailures(evidence, headContext));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const target = relative(ROOT, statusPath) || 'STATUS.md';
  if (failures.length > 0) {
    console.error(`[ FAIL ] status evidence: ${target}`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[  OK  ] status evidence: ${target} matches ${headContext.currentHead.slice(0, 12)} and records ${evidence.environment.node}/${evidence.environment.platform}/${evidence.environment.arch}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[ FAIL ] status evidence: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
