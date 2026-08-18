import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEvidenceHead } from '../scripts/check-status-evidence.mjs';

const ROOT = resolve(process.cwd());
const SCRIPT = resolve(ROOT, 'scripts/check-status-evidence.mjs');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function statusFile(evidence: unknown, sections = ['一、架构健康度', '二、本次变更影响范围', '三、已知风险点', '四、下次最该做的事']): string {
  const directory = mkdtempSync(join(tmpdir(), 'succinix-status-evidence-'));
  temporaryDirectories.push(directory);
  const body = sections.map((section) => `## ${section}\n\n- current evidence`).join('\n\n');
  const file = join(directory, 'STATUS.md');
  writeFileSync(file, `# STATUS\n\n${body}\n\n<!-- STATUS_EVIDENCE\n${JSON.stringify(evidence, null, 2)}\n-->\n`);
  return file;
}

function validEvidence(): {
  schemaVersion: number;
  head: string;
  recordedAt: string;
  environment: Record<string, string>;
  commands: Array<{ command: string; result: string }>;
} {
  return {
    schemaVersion: 1,
    head: HEAD,
    recordedAt: '2026-08-18T00:00:00.000Z',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    commands: [{ command: 'npm run check', result: 'passed' }],
  };
}

function verify(file: string) {
  return spawnSync(process.execPath, [SCRIPT, '--file', file], { cwd: ROOT, encoding: 'utf8' });
}

describe('status evidence gate', () => {
  const currentHead = 'a'.repeat(40);
  const parentHead = 'b'.repeat(40);

  it('accepts evidence from the current commit', () => {
    expect(validateEvidenceHead(currentHead, {
      currentHead,
      parentHead,
      parentChangedPaths: ['src/engine/client.ts'],
    })).toBeUndefined();
  });

  it('accepts parent evidence when the current commit changes only STATUS.md', () => {
    expect(validateEvidenceHead(parentHead, {
      currentHead,
      parentHead,
      parentChangedPaths: ['STATUS.md'],
    })).toBeUndefined();
  });

  it('rejects parent evidence when the current commit changes other files', () => {
    expect(validateEvidenceHead(parentHead, {
      currentHead,
      parentHead,
      parentChangedPaths: ['STATUS.md', 'scripts/check-status-evidence.mjs'],
    })).toContain('current commit changes only STATUS.md');
  });

  it('rejects evidence from an older commit', () => {
    expect(validateEvidenceHead('c'.repeat(40), {
      currentHead,
      parentHead,
      parentChangedPaths: ['STATUS.md'],
    })).toContain('head must equal current HEAD');
  });

  it('accepts all required sections and current structured evidence', () => {
    const result = verify(statusFile(validEvidence()));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[  OK  ] status evidence');
  });

  it('rejects evidence from a different commit or incomplete environment', () => {
    const evidence = validEvidence();
    evidence.head = '0'.repeat(40);
    evidence.environment.arch = '';
    const result = verify(statusFile(evidence));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('head must equal current HEAD');
    expect(result.stderr).toContain('environment.arch must be a non-empty string');
  });

  it('rejects missing dashboard sections and malformed command results', () => {
    const evidence = validEvidence();
    evidence.commands = [{ command: '', result: 'unknown' }];
    const result = verify(statusFile(evidence, ['一、架构健康度', '二、本次变更影响范围', '三、已知风险点']));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected exactly these sections in order');
    expect(result.stderr).toContain('commands[0].command must be a non-empty string');
    expect(result.stderr).toContain('commands[0].result must be one of');
  });
});
