import fs from 'node:fs';
import path from 'node:path';
import { DefaultRubyVM } from '@ruby/wasm-wasi/dist/node';

const RUNTIME_ROOT = path.dirname(new URL(import.meta.url).pathname);
const WASM_PATH = path.join(RUNTIME_ROOT, 'ruby.wasm');

interface RubyInvocation {
  mode: 'version' | 'eval' | 'script';
  code?: string;
  file?: string;
  argv: string[];
}

function usage(message?: string): never {
  if (message) process.stderr.write(`ruby: ${message}\n`);
  process.stderr.write('Usage: ruby --version | ruby -e CODE [args...] | ruby SCRIPT [args...]\n');
  process.exit(2);
}

function parse(argv: string[]): RubyInvocation {
  const first = argv[0];
  if (first === '--version' || first === '-v') return { mode: 'version', argv: [] };
  if (first === '-e') {
    if (argv[1] === undefined) usage('missing argument for -e');
    return { mode: 'eval', code: argv[1], argv: argv.slice(2) };
  }
  if (!first) usage('interactive REPL is unavailable; use -e or a script');
  if (first.startsWith('-')) usage(`unsupported option: ${first}`);
  return { mode: 'script', file: first, argv: argv.slice(1) };
}

async function main(): Promise<void> {
  const invocation = parse(process.argv.slice(2));
  const module = await WebAssembly.compile(fs.readFileSync(WASM_PATH));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const { vm } = await DefaultRubyVM(module, { env });

  if (invocation.mode === 'version') {
    vm.printVersion();
    return;
  }

  let code = invocation.code ?? '';
  let filename = '-e';
  if (invocation.mode === 'script') {
    filename = path.resolve(invocation.file!);
    code = fs.readFileSync(filename, 'utf8');
  }
  const setup = `ARGV.replace(${JSON.stringify(invocation.argv)}); $0 = ${JSON.stringify(filename)}`;
  vm.eval(setup);
  const wrapped = `eval(${JSON.stringify(code)}, TOPLEVEL_BINDING, ${JSON.stringify(filename)}, 1)`;
  vm.eval(wrapped);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
