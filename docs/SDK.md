# Succinix Integration

[简体中文](SDK.zh-CN.md)

## What It Is

`@succinix/engine` is a DeepSeek Harness Cordis plugin. It gives an application a browser project runtime where files, commands, terminal sessions, and saved data belong to one WebContainer workspace.

## What It Is For

Your application and its Cordis plugins can use an executable, persistent project terminal without separately maintaining browser files, commands, process state, and terminals.

| Need | Service to use |
| --- | --- |
| Read or write project files | `ctx.fs` |
| Build constrained Lifo command arguments | `ctx.sandbox` |
| Create and manage terminal sessions | `ctx.terminals` |
| Persist a plugin's session events | `ctx.sessionPersistence` |
| Manage WebContainer, instances, ports, or executor | `ctx.get('succinix', false)` |

The first four are the normal consumer services. The last is the host lifecycle seam in the same Cordis context; it does not replace those services.

## How To Integrate

### 1. Install and publish assets

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
mkdir -p public/engine
cp -R node_modules/@succinix/engine/assets/. public/engine/
```

The static server must expose `host.js`, `lifo-core.js`, `sha256.json`, and `pyodide/`. The page must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`.

### 2. Install the plugin and start an instance

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
  defaultInstance: {
    instanceId: 'default',
    persistence: { dbName: 'my-app', storeKey: 'default' },
  },
})
await fiber

const host = ctx.get('succinix', false)!
await host.attach(await WebContainer.boot())
await host.ensureInstance('default', { executor: {} })

const result = await host.executor.exec('node -e "console.log(1 + 1)"')
console.log(result.stdout)
```

`container.mode: 'external'` means the application creates WebContainer. To let the plugin create it, use `'internal'` and call `host.boot()` instead. The modes cannot be mixed.

### 3. Use services from another plugin

```ts
export const inject = ['fs', 'sandbox', 'terminals', 'sessionPersistence']

export function apply(ctx) {
  // ctx.fs, ctx.sandbox, ctx.terminals, and ctx.sessionPersistence are available.
}
```

For optional services, probe with `ctx.get('fs', false)`. Do not rely on implicit globals.

## Important Limits

- `node`, `npm`, and `npx` use real WebContainer Node; Python uses Pyodide; other Unix commands use Lifo. They share files.
- `ctx.sandbox.confine()` creates constrained Lifo arguments and does not execute a command. Real Node subprocesses cannot be isolated per call and fail explicitly.
- Register an `Agent` with `host.registerAgent(agent)` before opening terminal sessions; unregister it when finished. There is no implicit `guest` owner.
- `dispose()` normally unloads the Cordis fiber only. `shutdown()` stops the page-level host.
- Ports are browser previews, and instance separation is not a security boundary.

Installed package `.d.ts` files are the complete API. The [Cordis contract](cordis-contract.md) is browser-verified against a packed third-party installation. Update its example and tests before changing public behavior.

See [Migration](MIGRATION.md) for older integrations, [Third-party plugins](PLUGIN.md) for consumer plugins, and [Protocol](PROTOCOL.md) only when implementing a transport layer.
