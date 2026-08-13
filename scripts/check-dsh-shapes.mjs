#!/usr/bin/env node
// Shape gate for the vendored dsh 0.1.0-rc.6 contracts.
// Base mode verifies that every expected d.ts file is present and extracts the
// public method/error-code surface for a readable diff. --types mode compares
// src/plugin/dsh-types.ts against the vendored surface (added in S0.3).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACT = join(ROOT, 'docs', 'contracts', 'dsh-0.1.0-rc.6');
const SURFACE = {
  'dsh-fs': {
    files: ['index.d.ts', 'types.d.ts', 'invariant.d.ts'],
    methods: ['resolve', 'processPath', 'fileUrl', 'contains', 'stat', 'lstat', 'readText', 'streamText', 'readBytes', 'listDir', 'writeText', 'editText'],
    properties: ['sandboxMode'],
    codes: [
      'FS_NOT_FOUND',
      'FS_NOT_DIRECTORY',
      'FS_NOT_TEXT',
      'FS_NOT_REGULAR_FILE',
      'FS_TOO_LARGE',
      'FS_PERMISSION_DENIED',
      'FS_SANDBOX_DENIED',
      'FS_IO_ERROR',
      'FS_STALE_VERSION',
      'FS_NOT_OBSERVED',
      'FS_AMBIGUOUS_EDIT',
      'FS_EDIT_NOT_FOUND',
      'FS_ABORTED',
    ],
    errorClasses: ['FsError'],
  },
  'dsh-sandbox': {
    files: ['index.d.ts', 'escalation.d.ts', 'roots.d.ts', 'invariant.d.ts'],
    methods: ['confine'],
    properties: [],
    codes: ['SANDBOX_UNAVAILABLE'],
    errorClasses: ['SandboxUnavailableError'],
  },
  'dsh-terminal': {
    files: ['index.d.ts', 'types.d.ts', 'invariant.d.ts'],
    methods: ['registerBackend', 'listBackends', 'spawn', 'hasOwnerActivity', 'startSend', 'read', 'signal', 'kill', 'list'],
    properties: [],
    codes: [
      'DUPLICATE_BACKEND',
      'DUPLICATE_NAME',
      'FOREIGN_SESSION',
      'NO_BACKEND',
      'NO_SESSION',
      'OWNER_NOT_LIVE',
      'SEND_ACTIVE',
      'SERVICE_DISPOSING',
    ],
    errorClasses: ['TerminalError', 'TerminalBackendCleanupError'],
  },
  'dsh-session-persistence': {
    files: ['index.d.ts', 'coordinator.d.ts', 'revision.d.ts', 'write-behind.d.ts', 'preparations.d.ts', 'invariant.d.ts'],
    methods: ['locate', 'readRaw', 'create', 'append', 'prepare', 'load', 'inspect', 'readFrom', 'list', 'listSnapshots'],
    properties: ['supportsRawArtifacts'],
    codes: [],
    errorClasses: ['SessionPersistenceCorruptionError', 'SessionFormatUnsupportedError'],
  },
};

const failures = [];
const report = [];
for (const [pkg, spec] of Object.entries(SURFACE)) {
  const dir = join(CONTRACT, pkg);
  for (const file of spec.files) {
    if (!existsSync(join(dir, file))) failures.push(`${pkg}/${file} missing`);
  }
  if (!existsSync(join(dir, 'LICENSE')) || !existsSync(join(dir, 'VERSION.md'))) {
    failures.push(`${pkg} attribution files missing`);
  }
  const surfaceTexts = [];
  for (const file of spec.files) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    surfaceTexts.push(readFileSync(path, 'utf8'));
  }
  const text = surfaceTexts.join('\n');
  const missingSurface = [
    ...spec.methods.filter((method) => !text.includes(method)),
    ...spec.properties.filter((property) => !text.includes(property)),
    ...spec.codes.filter((code) => !text.includes(code)),
    ...spec.errorClasses.filter((name) => !text.includes(name)),
  ];
  if (missingSurface.length > 0) {
    failures.push(`${pkg} vendored snapshot missing expected surface: ${missingSurface.join(', ')}`);
  }
  report.push({ pkg, methods: spec.methods.length, properties: spec.properties.length, codes: spec.codes.length });
}

if (failures.length > 0) {
  console.error('[ FAIL ] dsh contract snapshot incomplete:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log('[  OK  ] dsh contract snapshot present');
for (const entry of report) {
  console.log(`  ${entry.pkg}: methods=${entry.methods} properties=${entry.properties} codes=${entry.codes}`);
}

if (process.argv.includes('--types')) {
  const local = join(ROOT, 'src', 'plugin', 'dsh-types.ts');
  if (!existsSync(local)) {
    console.error('[ FAIL ] --types requires src/plugin/dsh-types.ts');
    process.exit(1);
  }
  const localText = readFileSync(local, 'utf8');
  for (const [pkg, spec] of Object.entries(SURFACE)) {
    const missing = [...spec.methods, ...spec.properties, ...spec.codes, ...spec.errorClasses].filter((member) => !localText.includes(member));
    if (missing.length > 0) {
      console.error(`[ FAIL ] local dsh types missing surface from ${pkg}: ${missing.join(', ')}`);
      process.exit(1);
    }
  }
  console.log('[  OK  ] local dsh types contain the vendored method/code surface');
}
