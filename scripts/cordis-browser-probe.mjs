// C0: probe official Cordis plugins for browser bundling safety.
import { build } from 'esbuild';

const probes = [
  ['core', '@deepseek-ai/cordis'],
  ['logger-console', '@cordisjs/plugin-logger-console'],
  ['database-memory', '@cordisjs/plugin-database-memory'],
  ['loader', '@cordisjs/plugin-loader'],
  ['hmr', '@cordisjs/plugin-hmr'],
];

const results = [];
for (const [name, specifier] of probes) {
  try {
    await build({
      stdin: { contents: `import '${specifier}';`, resolveDir: process.cwd() },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
      external: ['@webcontainer/api'],
    });
    results.push({ name, ok: true });
  } catch (error) {
    const lines = String(error.message ?? error).split('\n');
    results.push({ name, ok: false, reason: lines.slice(0, 4).join(' | ') });
  }
}

console.log(JSON.stringify(results, null, 2));
