# Succinix Runtimes

[简体中文](LANGUAGES.zh-CN.md)

## What It Is

Succinix provides browser runtimes that share one project workspace. Files written from the terminal, Node, and Python are visible to each other.

## What It Is For

| Runtime | Good for | Important limit |
| --- | --- | --- |
| Node.js / npm / npx | Frontends, Node services, TypeScript tools | Real WebContainer Node; install dependencies in the project, not globally |
| Python / pip | Scripts, data work, supported Python packages | Pyodide; run `python -c` or script files; no general REPL or `subprocess` |
| Unix commands | File work, text filtering, pipes, and project operations | Provided by Lifo and shares files with Node/Python |
| Ruby | Supported Ruby WASM scripts in the standalone app | Slow first load, no gem installation; external hosts must provide Ruby assets |
| WASI | Precompiled WASI modules | The environment cannot compile C, Rust, or Go |

## How To Use It

```text
node --version
npm install
npx tsc
python script.py
python -m pip install <package>
grep -R "TODO" .
```

Run `lang` to view built-in runtimes. After starting a project service, run `ports` for the preview URL.

## Unsupported Cases

- C, Rust, and Go compilers are unavailable.
- Python cannot run an interactive REPL or create system processes through `subprocess`.
- Websites without CORS permission may be unreachable.
- Global npm installs, native executables, and real inbound networking are unavailable.

For version-level behavior, error codes, or reproduction work, consult tests and [Protocol](PROTOCOL.md); this page is not a low-level runtime reference.
