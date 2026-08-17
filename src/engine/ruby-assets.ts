import type { FileSystemAPI } from '@webcontainer/api';

export const RUBY_RUNTIME_DIR = '/usr/lib/succinix/ruby';
export const RUBY_RUNTIME_VERSION = 'head-wasm-wasi 2.10.1';

const RUBY_ASSETS = ['ruby-runtime.js', 'ruby.wasm', 'RUBY_VERSION'] as const;
let injecting: Promise<void> | null = null;

/** Lazily install the deferred Ruby adapter and reactor module into the
 * WebContainer system-asset directory.  Concurrent calls share one transfer. */
export async function ensureRubyRuntime(wc: { fs: FileSystemAPI }, assetsBase = '/ruby/'): Promise<void> {
  try {
    await wc.fs.readFile(`${RUBY_RUNTIME_DIR}/ruby-runtime.js`, 'utf8');
    await wc.fs.readFile(`${RUBY_RUNTIME_DIR}/ruby.wasm`);
    await wc.fs.readFile(`${RUBY_RUNTIME_DIR}/RUBY_VERSION`, 'utf8');
    return;
  } catch {
    /* first use or an interrupted prior injection */
  }
  if (!injecting) {
    injecting = inject(wc.fs, assetsBase).finally(() => { injecting = null; });
  }
  return injecting;
}

async function inject(fs: FileSystemAPI, assetsBase: string): Promise<void> {
  const base = `${assetsBase.replace(/\/+$/, '')}/`;
  await fs.mkdir(RUBY_RUNTIME_DIR, { recursive: true });
  for (const name of RUBY_ASSETS) {
    const response = await fetch(`${base}${name}`);
    if (!response.ok) throw new Error(`ruby asset fetch failed: ${base}${name} (HTTP ${response.status})`);
    await fs.writeFile(`${RUBY_RUNTIME_DIR}/${name}`, new Uint8Array(await response.arrayBuffer()));
  }
}
