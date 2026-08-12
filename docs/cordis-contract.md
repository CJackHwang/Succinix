# Succinix / Cordis Contract Snapshot

This document records the authoritative integration contract for
`@succinix/engine@0.5.0`. The executable snapshot is
[`examples/cordis-app/src/contract.ts`](../examples/cordis-app/src/contract.ts),
run in a real browser by
[`scripts/cordis-app-e2e.mjs`](../scripts/cordis-app-e2e.mjs). The demo depends
only on the packed engine, `cordis`, and `@webcontainer/api`; it never imports
Succinix repository source.

## Contract areas

The contract suite covers the ten required areas from the C5/C6 plan:

| # | Area | Checks |
| --- | --- | --- |
| 1 | Plugin shape and loading | root export is `{ name: 'succinix', apply, Config }`; fiber reaches `ACTIVE` |
| 2 | Service consumption | `inject: ['succinix']` resolves; uninjected `ctx.get('succinix', false)` is explicit fallback |
| 3 | Service surface | `state`, `container`, `executor`, `terminal`, `snapshot`, `persist`, `workspace`, `ports`, `services`, `capabilities`, `instance`, lifecycle methods |
| 4 | Runtime execution | real Node, Lifo, and packaged Pyodide Python commands in the container |
| 5 | Multi-instance single host | `ensureInstance` reuses the page host; `startedAt` and `wc` stay stable |
| 6 | Snapshot / workspace | save, restore, flush, and list work on the shared container filesystem |
| 7 | Ports and services | `server-ready` subscription, `ports.ready`, declarative service start/status/stop |
| 8 | Reload semantics | `reconfigure` increments `configRevision`; `fiber.update` preserves the host and restores services |
| 9 | Mode mismatch and teardown | `attach`/`boot` mismatch throws `ERR_MODE_MISMATCH`; shutdown, fiber dispose, and reapply behave correctly |
| 10 | Asset integrity | `sha256.json` matches the served `host.js`; `lifo-core.js` manifest entry is present |

The migration surface from [MIGRATION.md](MIGRATION.md) is also executed as a
contract check via `examples/cordis-app/src/migration.ts`.

## Type-level contract

The published package must include:

- `Context['succinix']: SuccinixService` augmentation;
- typed `Events['succinix/*']` for state, server-ready/closed, command,
  instance, workspace, and process events;
- exported types for `SuccinixConfig`, `SuccinixService`, events, ports,
  services, capabilities, and terminal output/session contracts.

`examples/cordis-app/tsconfig.json` typechecks the demo against the packed
package, so a missing augmentation fails the build.

## Running the contract

```bash
npm run build:engine-package   # rebuild packages/engine
node scripts/cordis-app-e2e.mjs
```

The driver builds the package, installs the demo's local dependencies if
needed, builds the demo, starts Vite preview on port 7895, and runs the
contract in headless Chrome. The gate is **all checks passed, zero failed**.

## Keeping the snapshot authoritative

When the service surface, events, capabilities, lifecycle semantics, or asset
layout change:

1. update `examples/cordis-app/src/contract.ts` first;
2. update this document's area table if a category changes;
3. run `node scripts/cordis-app-e2e.mjs`;
4. keep the demo and the packed package in sync.

## Related documents

- [SDK.md](SDK.md) — integration reference
- [PLUGIN.md](PLUGIN.md) — third-party plugin authoring
- [MIGRATION.md](MIGRATION.md) — 0.4.0 to 0.5.0 migration
- [PROTOCOL.md](PROTOCOL.md) — file-RPC wire protocol
