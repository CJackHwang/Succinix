# Cordis App Contract Demo

Standalone external consumer for `@succinix/engine@0.5.0`. It depends only on
the packed engine package (via `file:../../packages/engine`), `cordis`, and
`@webcontainer/api`. It does not import Succinix repo source.

The demo verifies the published artifact contract in a real browser:

- Cordis plugin loading with `inject: ['succinix']`
- internal boot and external attach
- node, lifo, and python execution
- multi-instance reuse of the page host
- snapshot save/restore and workspace flush/list
- port subscription and declarative services
- fiber reload without host restart
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
