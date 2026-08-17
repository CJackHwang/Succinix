# @succinix/engine

Succinix engine as a **dsh-compatible Cordis plugin**: a Unix-like sandbox
that runs inside a WebContainer and shares the container's filesystem with
your app. It provides a real Node runtime (`node`, `npm`, `npx`), a built-in
Pyodide Python (`python`, `pip`), and a Lifo Unix userland for everything
else.

This is the 0.7.0 single-track plugin form. It is built for
`@deepseek-ai/cordis@4.0.1` and exposes the dsh service keys `ctx.fs`,
`ctx.sandbox`, `ctx.terminals`, and `ctx.sessionPersistence`. The old 0.4.0
standalone SDK exports and the 0.5.0 single-key `succinix` service are
removed; see the migration guide:
[docs/MIGRATION.md](../../docs/MIGRATION.md).

## Install

```bash
npm install @succinix/engine
npm install @deepseek-ai/cordis @webcontainer/api   # peer dependencies
```

## Quick start

```ts
import { Context } from '@deepseek-ai/cordis';
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
const host = ctx.get('succinix', false)!;
await host.attach(wc);
await host.ensureInstance('default', { executor: {} });

const node = await host.executor.exec('node -e "console.log(1+1)"');
const lifo = await host.executor.exec('grep -i foo file.txt');

await host.shutdown();
await fiber.dispose();
```

The plugin registers itself as `succinix` and provides four dsh services.
Consumers declare `inject: ['fs', 'sandbox', 'terminals',
'sessionPersistence']` or use `ctx.get('fs', false)`.

## Service surface

### dsh services

| Key | Purpose |
| --- | --- |
| `ctx.fs` | dsh `FileSystem`: 12 primitives, 13 `FS_*` codes, `sandboxMode` |
| `ctx.sandbox` | Synchronous `confine(argv, policy)`; Lifo wrappers, real Node fail-closed |
| `ctx.terminals` | Owner-scoped PTY registry (`spawn`, `startSend`, `read`, `signal`, `kill`, `list`) |
| `ctx.sessionPersistence` | Append-only event log stored as JSONL under the instance state root |

Import the published types from `@succinix/engine`:

```ts
import {
  FsError,
  SandboxUnavailableError,
  TerminalError,
  SessionId,
  type FileSystem,
  type SandboxProvider,
  type TerminalSessionService,
  type SessionPersistence,
} from '@succinix/engine';
```

### Host seam

`succinix` is the lifecycle and app-observability service. It is
not a dsh service key; trusted consumers probe it with
`ctx.get('succinix', false)`.

| Member | Purpose |
| --- | --- |
| `state` | Plugin state, host, instances, capabilities, `configRevision` |
| `container` | Current container handle (`internal` / `external`, `wc`, host) |
| `fs` / `sandbox` / `terminals` / `sessionPersistence` | The four dsh services |
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

- **Internal**: `const wc = await host.boot();`
- **External**: `await host.attach(wc);` when your app owns the WebContainer.
  The plugin still injects and spawns the host daemon.

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
- [MIGRATION.md](../../docs/MIGRATION.md) — migration from 0.4.0/0.5.0
- [PROTOCOL.md](../../docs/PROTOCOL.md) — file-RPC wire protocol
