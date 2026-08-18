# Succinix Cordis Contract

[简体中文](cordis-contract.zh-CN.md)

## What It Is

This is the public compatibility contract for `@succinix/engine@0.7.0`. It is not product introduction: a real browser runs it with only the packed engine, `@deepseek-ai/cordis`, and `@webcontainer/api`, without repository source.

## What It Checks

| Area | Promise |
| --- | --- |
| Plugin and injection | Entry is `{ name: 'succinix', apply, Config }`; four dsh services can be injected or explicitly probed |
| Service surface | File access, command confinement, terminal sessions, and session persistence match public types |
| Execution and instances | Node, Lifo, and Pyodide Python run in one workspace; instances share the page-level host |
| Persistence and services | Snapshots, workspace persistence, port subscriptions, and declarative services work |
| Lifecycle | Reload, restart-needed configuration, mode conflicts, stop, and reapply obey lifecycle rules |
| Published assets | `host.js`, `lifo-core.js`, and `sha256.json` can be verified |

## How To Verify

```bash
npm run build:engine-package
node scripts/cordis-app-e2e.mjs
```

The executable case is [examples/cordis-app/src/contract.ts](../examples/cordis-app/src/contract.ts). Change it before changing public types, services, lifecycle, assets, or events.

## Why The `contracts` Directory Exists

[`contracts/dsh-0.1.0-rc.6/`](contracts/dsh-0.1.0-rc.6/SOURCES.md) is a pinned DeepSeek Harness service-shape snapshot. `check-dsh-shapes` validates it. It is precise type evidence, not a tutorial; start with [Integration](SDK.md). `ctx.get('succinix', false)` remains the host seam, but it does not replace the four dsh services.
