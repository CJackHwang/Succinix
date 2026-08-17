# dsh Cordis WebContainer POC Report

Date: 2026-08-14

## Conclusion

`@deepseek-ai/cordis@4.0.1` is the single-track plugin runtime for
`@succinix/engine@0.6.0`. The core lifecycle, provide/inject contract for the
dsh service keys, synchronous StandardSchema config validation, and
WebContainer coexistence all passed in a real browser run. The upstream
`cordis@4.0.0-rc.8` line is not part of the 0.6.0 baseline; O-7 fixed the
alignment on the dsh fork.

## Baseline

- Cordis runtime: `@deepseek-ai/cordis@4.0.1`
- dsh contract snapshot: `docs/contracts/dsh-0.1.0-rc.6`
- engine peer dependencies: `@deepseek-ai/cordis ^4.0.1`,
  `@webcontainer/api ^1.6.4`
- Public service keys: `ctx.fs`, `ctx.sandbox`, `ctx.terminals`,
  `ctx.sessionPersistence`
- Lifecycle seam: `succinix` via `ctx.get('succinix', false)`

The vendored dsh d.ts files are the shape authority. Succinix implements the
service shapes locally and does not install the four dsh service packages at
runtime, which keeps the peer graph small and reproducible.

## Browser POC

`examples/cordis-poc/` is a minimal Vite page that:

- creates a `Context` from `@deepseek-ai/cordis`;
- installs a provider plugin that provides `fs`, `sandbox`, `terminals`, and
  `sessionPersistence`;
- installs a consumer plugin with
  `inject: ['fs', 'sandbox', 'terminals', 'sessionPersistence']`;
- validates a sync StandardSchema config and observes `ValidationError`;
- boots a real `WebContainer` and runs `node -e` inside it.

`scripts/cordis-poc-check.mjs` runs this page in headless Chrome. Observed
results:

```text
provider state: ACTIVE
consumer state: ACTIVE
consumer injected dsh services: ok
config validated: {"ok":true}
config validation rejected: ValidationError
provider after dispose: DISPOSED
consumer after dispose: DISPOSED
service lookup after provider dispose: unavailable (ok)
dsh core lifecycle: PASS
WebContainer node exit: 0
WebContainer node output: poc:node-ok
WebContainer + Cordis coexistence: PASS
```

## Historical upstream plugin probe

`scripts/cordis-browser-probe.mjs` is retained for historical context. It
bundles the official upstream plugins so the browser-safety conclusions remain
reproducible, but those plugins are not part of Succinix's default composition:

| Plugin | Result | Evidence |
| --- | --- | --- |
| `@deepseek-ai/cordis` core | available | bundles successfully |
| `@cordisjs/plugin-logger-console` | available | browser entry bundles successfully |
| `@cordisjs/plugin-database-memory` | available | bundles successfully |
| `@cordisjs/plugin-loader` | unavailable | `Could not resolve "node:module"` |
| `@cordisjs/plugin-hmr` | unavailable | `node:path`, `node:fs`, `node:url` imports fail |

Neither the loader nor HMR is browser-safe, so Succinix uses static,
programmatic plugin composition and Cordis fiber reload for development
reloads.

## Decisions

1. Use `@deepseek-ai/cordis@4.0.1` as the single dependency baseline; do not
   maintain an upstream `cordis` parallel line for the engine.
2. Do not include `@cordisjs/plugin-loader` or `@cordisjs/plugin-hmr` in the
   browser composition.
3. Use static plugin composition plus `fiber.update()` / dispose-reapply for
   reload semantics.
4. Expose the four dsh service keys and keep container lifecycle behind the
   internal `succinix` seam.
5. Vendor `docs/contracts/dsh-0.1.0-rc.6/` as the immutable service-shape
   snapshot and gate against it with `scripts/check-dsh-shapes.mjs`.
6. Fail closed for `node|npm|npx` under `ctx.sandbox.confine`; the browser
   execution world cannot provide per-call process sandboxing for real Node
   subprocesses.
