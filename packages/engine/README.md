# @succinix/engine

Succinix engine as a **Cordis plugin**: a Unix-like sandbox that runs inside a
WebContainer and shares the container's filesystem with your app. It provides
a real Node runtime (`node`, `npm`, `npx`), a built-in Pyodide Python
(`python`, `pip`), and a Lifo Unix userland for everything else.

This is the 0.5.0 plugin form. The old 0.4.0 standalone SDK exports are
removed; see the repository migration guide:
[docs/MIGRATION.md](../../docs/MIGRATION.md).

## Install

```bash
npm install @succinix/engine
npm install cordis @webcontainer/api   # peer dependencies
```

## Quick start

```ts
import { Context } from 'cordis';
import engine from '@succinix/engine';
import { WebContainer } from '@webcontainer/api';

const ctx = new Context();
const fiber = ctx.plugin(engine, {
  container: { mode: 'external' },
  defaultInstance: {
    instanceId: 'default',
    persistence: { dbName: 'my-app', storeKey: 'default' },
  },
});
await fiber;

const wc = await WebContainer.boot();
await ctx.succinix.attach(wc);
await ctx.succinix.ensureInstance('default', { executor: {} });

const node = await ctx.succinix.executor.exec('node -e "console.log(1+1)"');
const lifo = await ctx.succinix.executor.exec('grep -i foo file.txt');

await ctx.succinix.shutdown();
await fiber.dispose();
```

## Service surface

The plugin registers the `succinix` service. Consumers declare
`inject: ['succinix']` or use `ctx.get('succinix', false)`.

| Member | Purpose |
| --- | --- |
| `state` | Plugin state, host, instances, capabilities, `configRevision` |
| `container` | Current container handle (`internal` / `external`, `wc`, host) |
| `executor` | Default-instance executor: `exec`, `spawn`, `listProcesses`, `kill`, `ping`, `respawn` |
| `terminal` | `terminal.create(output)` for a UI-free terminal session |
| `snapshot` / `persist` / `workspace` | Snapshot save/restore, persistence, workspace facade |
| `ports` | Page-level port view and `server-ready` / `server-closed` subscriptions |
| `services` | Declarative background services |
| `capabilities` | `terminal.*`, `fs.*`, `workspace.*` capability registry |
| `instance` | Default `SuccinixInstance` or `null` |
| `boot` / `attach` | Internal boot or external container adoption |
| `ensureInstance` | Create/reuse a per-instance stack on the shared host |
| `dispose` / `shutdown` | Soft fiber teardown / hard host shutdown |
| `reconfigure` | Apply a new validated configuration |

## Container modes

- **Internal**: `const wc = await ctx.succinix.boot();`
- **External**: `await ctx.succinix.attach(wc);` when your app owns the
  WebContainer. The plugin still injects and spawns the host daemon.

`attach()` and `boot()` are mutually exclusive; switching modes throws
`ERR_MODE_MISMATCH`.

## Lifecycle

The page-level HostManager survives fiber reloads. `dispose()` is soft by
default; `shutdown()` flushes instances, kills the host, and clears page
registries. Set `lifecycle.disposeMode: 'hard'` if fiber dispose must also
shut the host down.

## Assets

The package ships `assets/host.js`, `assets/lifo-core.js`, `assets/pyodide/*`,
and `assets/sha256.json`. Copy them to your static directory or import them
with Vite:

```ts
import hostJsUrl from '@succinix/engine/host.js?url';
import lifoCoreUrl from '@succinix/engine/lifo-core.js?url';
```

Asset SHA-256 verification is on by default.

## Requirements

- Chromium only; WebContainers does not support Firefox, Safari, or mobile.
- Cross-origin isolation is required (`COOP: same-origin` and
  `COEP: credentialless`).
- Ports are virtual previews; there is no real inbound network.

## Documentation

- [SDK.md](../../docs/SDK.md) — full integration reference
- [PLUGIN.md](../../docs/PLUGIN.md) — third-party plugin authoring
- [cordis-contract.md](../../docs/cordis-contract.md) — contract snapshot
- [MIGRATION.md](../../docs/MIGRATION.md) — migration from 0.4.0
- [PROTOCOL.md](../../docs/PROTOCOL.md) — file-RPC wire protocol
