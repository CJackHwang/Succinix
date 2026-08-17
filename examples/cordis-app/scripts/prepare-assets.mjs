// Copy runtime assets out of the installed @succinix/engine package into this
// demo's static directory. The demo consumes the package only; it never reads
// Succinix repo source or build outputs.
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const demoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const engineDir = join(demoRoot, 'node_modules', '@succinix', 'engine');
const enginePkg = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8'));

if (typeof enginePkg.version !== 'string' || !enginePkg.version.startsWith('0.7.')) {
  throw new Error(`unexpected @succinix/engine version: ${enginePkg.version}`);
}

const required = ['host.js', 'lifo-core.js', 'sha256.json'];
for (const name of required) {
  if (!existsSync(join(engineDir, 'assets', name))) {
    throw new Error(`@succinix/engine package is missing assets/${name}; run npm run build:engine-package first`);
  }
}

const enginePublic = join(demoRoot, 'public', 'engine');
mkdirSync(enginePublic, { recursive: true });
for (const name of required) {
  cpSync(join(engineDir, 'assets', name), join(enginePublic, name));
}

const pyodideSource = join(engineDir, 'assets', 'pyodide');
if (existsSync(pyodideSource)) {
  const pyodidePublic = join(demoRoot, 'public', 'pyodide');
  mkdirSync(pyodidePublic, { recursive: true });
  cpSync(pyodideSource, pyodidePublic, { recursive: true });
}

console.log(`cordis-app: copied @succinix/engine assets (${enginePkg.version}) to public/`);
