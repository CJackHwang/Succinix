# Cordis App Contract Demo

Standalone external consumer for `@succinix/engine@0.6.0`. It depends only on
the packed engine package (via `file:../../packages/engine`),
`@deepseek-ai/cordis`, and `@webcontainer/api`. It does not import Succinix
repo source.

The demo verifies the published artifact contract in a real browser:

- Cordis plugin loading with `inject: ['fs', 'sandbox', 'terminals',
  'sessionPersistence']`
- the internal `succinix-host` seam for boot/attach/ensureInstance and
  observability facades
- node, lifo, and python execution
- `ctx.fs` write/read/edit and structured error codes
- `ctx.sandbox` lifo confinement and fail-closed real Node subprocesses
- `ctx.terminals` owner-scoped spawn/read/signal/kill registry
- `ctx.sessionPersistence` append/list/readRaw event log
- multi-instance reuse of the page host
- snapshot save/restore and workspace flush/list
- explicit `persist.force` execution
- port subscription and declarative services
- fiber reload without host restart for hot fields, restart-required shutdown,
  and `configRevision` increments
- shutdown, dispose, and reapply recovery
- asset SHA-256 integrity

```sh
npm run build:engine-package   # from the repo root
cd examples/cordis-app
npm install
npm run build
npm run preview
```

Open `http://localhost:7895/` and wait for the summary line. The e2e driver is
[`scripts/cordis-app-e2e.mjs`](../../scripts/cordis-app-e2e.mjs).
