# Cordis WebContainer POC Report

Date: 2026-08-13

## Conclusion

Cordis 4.0.0-rc.8 is viable as the single-track plugin runtime for
`@succinix/engine@0.5.0`. The core lifecycle, provide/inject service contract,
synchronous StandardSchema config validation, and WebContainer coexistence all
passed in a real browser run. The Node-only plugins (`loader`, `hmr`) are not
browser-safe and will not be part of the default composition.

## Fork / npm parity

- npm package: `cordis@4.0.0-rc.8`
- fork commit: `CJackHwang/cordis` `f46ae95e`
- fork package version: `4.0.0-rc.8`

Parity check: the fork core source was bundled with `esbuild` using
`keepNames: true` and compared with `node_modules/cordis/lib/index.js`. The only
differences are generated `// src/...` vs `// ../cordis/packages/core/src/...`
path comments. No behavioral difference was found.

## Browser probe

`scripts/cordis-browser-probe.mjs` bundles each official plugin for the browser:

| Plugin | Result | Evidence |
| --- | --- | --- |
| `cordis` core | available | bundles successfully |
| `@cordisjs/plugin-logger-console` | available | browser entry bundles successfully |
| `@cordisjs/plugin-database-memory` | available | bundles successfully |
| `@cordisjs/plugin-loader` | unavailable | `Could not resolve "node:module"` |
| `@cordisjs/plugin-hmr` | unavailable | `node:path`, `node:fs`, `node:url` imports fail |

`chokidar` is bundled into `plugin-hmr` and has no browser build. The loader also
depends on Node internal module loading APIs. Neither will be used in browser
composition; Succinix will use static, programmatic plugin composition and Cordis
fiber reload for development reloads.

## Browser POC

`examples/cordis-poc/` is a minimal Vite page that:

- creates a `Context`;
- installs `logger-console` and `database-memory`;
- installs a provider plugin that calls `ctx.provide('succinix', service)`;
- installs a consumer plugin with `inject: ['succinix']`;
- validates a sync StandardSchema config and observes `ValidationError`;
- boots a real `WebContainer` and runs `node -e` inside it.

`scripts/cordis-poc-check.mjs` runs this page in headless Chrome. Observed
results:

```text
provider state: ACTIVE
consumer state: ACTIVE
consumer injected service: ok
config validated: {"ok":true}
config validation rejected: ValidationError
provider after dispose: DISPOSED
consumer after dispose: PENDING
service lookup after provider dispose: unavailable (ok)
Cordis core lifecycle: PASS
WebContainer node exit: 0
WebContainer node output: poc:node-ok
WebContainer + Cordis coexistence: PASS
```

Node-only lifecycle check also confirmed that re-providing the service after a
provider dispose restores the consumer fiber to `ACTIVE` and the injected
service value is available again.

## Decisions

1. Use npm `cordis@4.0.0-rc.8` as the development dependency; the fork remains
   the reviewed source of truth and matches npm byte-for-byte after build path
   comments are ignored.
2. Do not include `@cordisjs/plugin-loader` or `@cordisjs/plugin-hmr` in the
   browser composition.
3. Use static plugin composition plus `fiber.update()` / dispose-reapply for
   reload semantics.
4. Use `ctx.get('capability')` probing instead of optional inject, because
   Cordis rc.8 removed optional inject semantics.
5. `@cordisjs/plugin-database-memory` and `@cordisjs/plugin-logger-console` are
   browser-safe if a later phase needs them; neither is required by Succinix
   core.
6. `feat/reentrant-fiber-lifecycle` and `fix/lazy-entry-config-resolution` are
   not required for this plan; they remain research-only branches.
