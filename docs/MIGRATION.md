# Migrating To Succinix 0.7.0

[简体中文](MIGRATION.zh-CN.md)

## What This Is

This is the upgrade checklist for applications already using an older `@succinix/engine` integration. Version 0.7.0 is a Cordis plugin: consumer code uses four services, while the same-context host seam manages the execution world.

## Important Changes

| Old approach | 0.7.0 approach |
| --- | --- |
| `createTerminalExecutor()` or the `./terminal` / `./instance` exports | Install the plugin and call `host.ensureInstance()` |
| Use the old `ctx.succinix.*` namespace for everyday runtime work | Use `ctx.fs`, `ctx.sandbox`, `ctx.terminals`, and `ctx.sessionPersistence` |
| Put `onServerReady` or `onServerClosed` in config | Subscribe with `host.onServerReady()`, `host.onServerClosed()`, or `succinix/*` events |
| Do not publish host assets | Copy package assets to the application's static directory and set their URLs |
| Old batch RPC client | Use the plugin executor; follow RPC v2 only for a custom transport |

`ctx.get('succinix', false)` remains available for host lifecycle, instances, ports, and the default executor. It is not a replacement for the four normal services.

## How To Upgrade

### 1. Replace dependencies and assets

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
mkdir -p public/engine
cp -R node_modules/@succinix/engine/assets/. public/engine/
```

### 2. Replace old constructors with the plugin

```ts
import { Context } from '@deepseek-ai/cordis'
import engine from '@succinix/engine'
import { WebContainer } from '@webcontainer/api'

const ctx = new Context()
const fiber = ctx.plugin(engine, {
  hostJsUrl: '/engine/host.js',
  lifoCoreUrl: '/engine/lifo-core.js',
  pythonAssetsUrl: '/engine/pyodide/',
  container: { mode: 'external' },
})
await fiber

const host = ctx.get('succinix', false)!
await host.attach(await WebContainer.boot())
await host.ensureInstance('default', { executor: {} })
```

### 3. Change service dependencies

```ts
export const inject = ['fs', 'sandbox', 'terminals', 'sessionPersistence']
```

Use `ctx.fs` for files, `ctx.sandbox` for command confinement, `ctx.terminals` for sessions, and `ctx.sessionPersistence` for plugin session events. Use the host seam only for executor, instances, ports, and services.

### 4. Check lifecycle

- When the application creates WebContainer, use `external` with `host.attach(wc)`.
- When the plugin creates WebContainer, use `internal` with `host.boot()`.
- `dispose()` normally leaves the page-level host alive; use `shutdown()` for a full stop.
- Configuration holds serializable data. Subscribe to host methods or `succinix/*` for ports and command events.

## Incompatible Areas

- RPC v2 is not compatible with the old batch client.
- `./terminal`, `./instance`, and standalone SDK exports are removed.
- `ctx.sandbox` cannot provide per-call security isolation for real Node subprocesses.
- A normal fiber reload does not restart the page-level host; a configuration change that requires restart closes the old host first.

Run the [Cordis app example](../examples/cordis-app/README.md) or `node scripts/cordis-app-e2e.mjs` after upgrading. [Integration](SDK.md) defines current behavior.
