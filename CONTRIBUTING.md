# Contributing To Succinix

[简体中文](CONTRIBUTING.zh-CN.md)

## What This Is

This guide is for contributors. Read [AGENTS.md](AGENTS.md) before coding; it defines the architecture, UI, and commit rules that must remain intact.

## How To Start

Node.js 22+ and npm are required:

```bash
npm install
npm run dev
```

Open `http://localhost:7892`. The development server already uses port `7892` and the COOP/COEP headers required by WebContainer; do not change them casually.

## Where Code Lives

| Directory | Responsibility |
| --- | --- |
| `src/plugin/` | Cordis plugin, services, and lifecycle; only this directory may import Cordis |
| `src/engine/` | WebContainer host, RPC, command routing, and runtime adapters |
| `src/terminal/` | Terminal startup and the browser device plane |
| `src/instance/`, `src/persist/`, `src/services/` | Instances, snapshots, and background services |
| `src/commands/`, `src/userland/` | Built-in commands and execution-world extensions |
| `tests/` | Unit and contract behavior tests |
| `scripts/` | Builds, checks, and browser verification |

## Remember While Contributing

- WebContainer is the execution world. Do not create another browser-side filesystem, command set, process table, or editor.
- The `/cmd.json` to independent `/result-<id>.json` RPC cannot become a shared result file.
- `node`, `npm`, and `npx` use real Node; Lifo handles other Unix commands; both must share files.
- UI output is English, without emoji, in the established dark-amber theme and JetBrains Mono.
- Multiple instances organize work; they are not a permissions or security system. Do not add fake logins, `chmod`, or native-binary simulations.

## Verify And Commit

Run checks that match the change. Code changes usually start with:

```bash
npx tsc -p tsconfig.json --noEmit
node scripts/build-host.mjs
npm run build
npm run lint
npm run test
npm run check:docs
```

For public plugins, browser execution, or package artifacts, also run `npm run check:engine-package`, `npm run check:plugin-boundaries`, and `npm run test:e2e`. Review the diff and stage paths explicitly before committing. Commit messages are Simplified Chinese, for example `fix(终端): 修复结果文件清理`. [AGENTS.md](AGENTS.md) is authoritative.
