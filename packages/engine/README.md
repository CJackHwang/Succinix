# @succinix/engine

[简体中文](README.zh-CN.md)

`@succinix/engine` is the Cordis plugin for embedding Succinix in an application. It provides a browser project workspace that manages files, command execution, terminal sessions, and session persistence.

## What It Is For

You do not need to build a filesystem, command router, terminal, and persistence layer yourself. Once connected to WebContainer, Node, Python, and Unix commands use the same workspace.

## How To Use It

Install the package and publish its assets as static files:

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
mkdir -p public/engine
cp -R node_modules/@succinix/engine/assets/. public/engine/
```

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
await host.executor.exec('npm run dev')

await host.shutdown()
await fiber.dispose()
```

Application plugins needing files, confinement, terminals, or session persistence declare:

```ts
export const inject = ['fs', 'sandbox', 'terminals', 'sessionPersistence']
```

Use `ctx.get('succinix', false)` for host lifecycle, instances, ports, and executor management; use the four services for daily plugin work.

## Check Before Integrating

- Peer dependencies are `@deepseek-ai/cordis ^4.0.1` and `@webcontainer/api ^1.6.4`.
- Chromium only; the page needs COOP/COEP.
- Ports are browser previews, not public services.

See [Integration](../../docs/SDK.md) for fields and lifecycle and [Migration](../../docs/MIGRATION.md) for older versions.
