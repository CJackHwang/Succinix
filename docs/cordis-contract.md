# Succinix / dsh Cordis Contract Snapshot

This document records the authoritative integration contract for
`@succinix/engine@0.6.0`. The executable snapshot is
[`examples/cordis-app/src/contract.ts`](../examples/cordis-app/src/contract.ts),
run in a real browser by
[`scripts/cordis-app-e2e.mjs`](../scripts/cordis-app-e2e.mjs). The demo depends
only on the packed engine, `@deepseek-ai/cordis`, and `@webcontainer/api`; it
never imports Succinix repository source.

## Contract areas

The contract suite covers the required dsh-native areas:

| # | Area | Checks |
| --- | --- | --- |
| 1 | Plugin shape and loading | root export is `{ name: 'succinix', apply, Config }`; fiber reaches `ACTIVE` |
| 2 | dsh service consumption | `inject: ['fs', 'sandbox', 'terminals', 'sessionPersistence']` resolves; uninjected `ctx.get(key, false)` is explicit fallback |
| 3 | Service surface | `ctx.fs` (12 primitives + `sandboxMode`), `ctx.sandbox.confine`, `ctx.terminals` registry, `ctx.sessionPersistence`; lifecycle and observability live behind `succinix-host` |
| 4 | Runtime execution | real Node, Lifo, and packaged Pyodide Python commands in the container |
| 5 | Multi-instance single host | `ensureInstance` reuses the page host; `startedAt` and `wc` stay stable |
| 6 | Snapshot / workspace | save, restore, flush, list, and explicit `persist.force` work on the shared container filesystem |
| 7 | Ports and services | `succinix/server-ready` subscription, `host.ports.ready`, declarative service start/status/stop |
| 8 | Reload semantics | `reconfigure` and `fiber.update` both increment `configRevision`; hot `fiber.update` preserves the host, restart-required `fiber.update` shuts it down before reapply, and services can be restored after reload |
| 9 | Mode mismatch and teardown | `attach`/`boot` mismatch throws `ERR_MODE_MISMATCH`; shutdown, fiber dispose, and reapply behave correctly |
| 10 | Asset integrity | `sha256.json` matches the served `host.js`; `lifo-core.js` manifest entry is present |

The migration surface from [MIGRATION.md](MIGRATION.md) is also executed as a
contract check via `examples/cordis-app/src/migration.ts`.

## Type-level contract

The published package must include:

- dsh `Context` augmentation for `fs`, `sandbox`, `terminals`, and
  `sessionPersistence`;
- typed `succinix/*` events for state, server-ready/closed, command, instance,
  workspace, and process events;
- typed `succinix-host` seam for container lifecycle, instance management,
  ports, services, capabilities, and observability;
- exported types for `SuccinixConfig`, `SuccinixHostService`, dsh service
  interfaces, events, ports, services, capabilities, and terminal
  output/session contracts.

The old single-key `succinix` service augmentation is removed. The contract
demo typechecks against the packed package, so a missing or stale
augmentation fails the build.

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
- [MIGRATION.md](MIGRATION.md) — 0.4.0/0.5.0 to 0.6.0 migration
- [PROTOCOL.md](PROTOCOL.md) — file-RPC wire protocol
