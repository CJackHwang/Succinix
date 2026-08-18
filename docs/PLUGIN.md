# Writing A Succinix Plugin

[简体中文](PLUGIN.zh-CN.md)

## What It Is

This guide is for Cordis plugin authors. Your plugin can use Succinix file, terminal, and session-persistence services without building another browser terminal.

## How To Start

Declare only the services you actually need:

```ts
export const inject = ['fs', 'sandbox', 'terminals', 'sessionPersistence']
```

For an optional service, use `ctx.get('fs', false)`. If Succinix is absent, disable that feature or handle the absence explicitly.

## Choose The Right Service

| Need | Do this | Do not do this |
| --- | --- | --- |
| Work with project files | Use `ctx.fs` targets, versions, and read/write methods | Assume the browser has a second filesystem |
| Constrain a Lifo command | Use `ctx.sandbox.confine(argv, policy)` | Treat it as Node subprocess isolation |
| Build an interactive tool | Use `ctx.terminals` with a registered `Agent` | Maintain browser-only shell, editor, or TUI state |
| Keep plugin session data | Append events with `ctx.sessionPersistence` | Store recoverable state only in temporary browser memory |
| Start services or inspect ports | Let the host use `ctx.get('succinix', false)` | Treat a port as a public inbound service |

WebContainer is Succinix's execution world. Extend commands, files, processes, services, and interactive applications there; browser code only renders, forwards input, and exposes unavoidable Web APIs.

## Minimal Example

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-succinix-plugin'
export const inject = ['fs']

export async function apply(ctx: Context) {
  const file = await ctx.fs.resolve('/workspace/hello.txt')
  await ctx.fs.writeText(file, 'hello')
}
```

The exported `@succinix/engine` types define parameters, errors, and terminal ownership. File writes must use versions and sandbox policies as required; terminal operations require a registered `Agent`.

## Verify It

The [Cordis app example](../examples/cordis-app/README.md) consumes only the packed engine, not repository source. After changing a public service, lifecycle, asset, or type, run:

```bash
npm run build:engine-package
node scripts/cordis-app-e2e.mjs
```

For embedding steps see [Integration](SDK.md); for old code see [Migration](MIGRATION.md); for transport detail see [Protocol](PROTOCOL.md).
