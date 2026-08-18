// Probe the DeepSeek Harness Cordis runtime for browser bundling safety.
import { build } from 'esbuild';

const probes = [
  ['dsh-cordis', '@deepseek-ai/cordis'],
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
