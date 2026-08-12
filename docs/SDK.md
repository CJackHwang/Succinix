# Succinix Engine — Cordis Plugin Integration

> Status: **0.5.0 plugin form (release-ready)**. `@succinix/engine` is a Cordis
> plugin and the only public integration surface. The old 0.4.0 standalone SDK
> exports (`createTerminalExecutor`, `./terminal`, `./instance`) are removed;
> see [MIGRATION.md](MIGRATION.md).

`@succinix/engine` gives any Cordis application a browser-native Unix sandbox
inside a WebContainer: a real Node runtime (`node|npm|npx`), a built-in
Pyodide Python (`python|python3|pip|pip3`), and a Lifo Unix userland for
everything else. The container filesystem is shared with the host application.

This document is the integration reference. For the wire protocol, see
[PROTOCOL.md](PROTOCOL.md). For the capability matrix, see
[FEATURES.md](FEATURES.md). For third-party plugin authoring, see
[PLUGIN.md](PLUGIN.md).

## Install

```bash
npm install @succinix/engine@0.5.0
npm install cordis @webcontainer/api   # peer dependencies
```

`@succinix/engine` requires `cordis >= 4.0.0-rc.8` and
`@webcontainer/api ^1.6.4`.

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
  terminal: { timeoutMs: 120000, bootGate: false },
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

The plugin registers itself as `succinix`; consumers declare
`inject: ['succinix']` or use `ctx.get('succinix', false)`. The published
`.d.ts` augments `Context['succinix']` and the Cordis `Events` map.

## Package exports

```jsonc
{
  "exports": {
    ".": {
      "types": "./dist/plugin/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./host.js": "./assets/host.js",
    "./lifo-core.js": "./assets/lifo-core.js",
    "./assets/*": "./assets/*",
    "./package.json": "./package.json"
  }
}
```

- `.` is the plugin entry: `{ name: 'succinix', apply, Config }`, plus types.
- `./host.js`, `./lifo-core.js`, and `./assets/*` are static assets for the
  host daemon, Lifo kernel, Pyodide runtime, and `sha256.json`.
- There is no `./terminal` or `./instance` subpath in 0.5.0.

## Container modes

### Internal mode

The plugin boots the WebContainer itself, with retries:

```ts
const wc = await ctx.succinix.boot({
  instanceId: 'default',
  executor: {},
});
```

### External mode

The host application owns the WebContainer and hands it to the plugin. The
plugin still injects `host.js`, spawns the host daemon, and manages host
readiness:

```ts
const wc = await WebContainer.boot();
await ctx.succinix.attach(wc, { executor: {} });
```

`attach()` and `boot()` are mutually exclusive. Switching modes after the
container is ready throws `ERR_MODE_MISMATCH`.

## Configuration

`SuccinixConfig` is serializable and synchronously validated. It has no
function fields; runtime hooks are service arguments or event subscriptions.

```ts
export interface SuccinixConfig {
  hostJsUrl?: string;        // default '/host.js'
  lifoCoreUrl?: string;      // default '/lifo-core.js'
  pythonAssetsUrl?: string;  // default '/pyodide/'
  resultTtlMs?: number;
  container?: {
    mode?: 'internal' | 'external';
    bootRetries?: number;
    bootIntervalMs?: number;
    hostReadyDeadlineMs?: number;
  };
  defaultInstance?: {
    instanceId?: string;
    statePrefix?: string;
    home?: string;
    persistence?: { dbName?: string; storeKey?: string };
  };
  terminal?: {
    cwd?: string;
    timeoutMs?: number;
    bootGate?: boolean;
    history?: boolean;
    tabComplete?: boolean;
    interrupt?: boolean;
    promptPrefix?: string;
  };
  capabilities?: {
    defaultAllow?: boolean;
    rules?: Array<{ pattern: string; allow: boolean }>;
  };
  lifecycle?: {
    disposeMode?: 'soft' | 'hard';
    flushOnPageHide?: boolean;
  };
  assets?: {
    integrity?: boolean;     // default true
  };
}
```

Invalid values produce a `ValidationError`; the plugin keeps its last valid
configuration and records the reason in `ctx.succinix.state.lastError`.

## Service surface

`ctx.succinix` is the complete service contract:

| Member | Purpose |
| --- | --- |
| `state` | Plugin state: version, container, host, instances, capabilities, `configRevision`, `lastError` |
| `container` | Current container handle: `mode`, `state`, `wc`, `hostPid`, `startedAt` |
| `executor` | Default-instance `TerminalExecutor`: `exec`, `spawn`, `listProcesses`, `kill`, `ping`, `pingDirect`, `interruptDirect`, `respawn` |
| `terminal` | `terminal.create(output, opts?)` returns a UI-free terminal session |
| `snapshot` | `save`, `restore`, `meta`, `clear` for the default instance |
| `persist` | Persistence context (snapshot keys, force save) |
| `workspace` | `restore`, `flush`, `list`, plus `stateRoot` and `home` |
| `ports` | `list`, `ready`, `expect`, `release`, `hasConflict`, `onServerReady`, `onServerClosed` |
| `services` | Declarative service management: `list`, `read`, `status`, `start`, `stop`, `enable`, `disable`, `add`, `remove`, `autostart`, `ensureFiles` |
| `capabilities` | Local capability registry: `check`, `list`, `define` |
| `instance` | Default `SuccinixInstance` or `null` |
| `boot` | Boot an internal WebContainer |
| `attach` | Adopt an external WebContainer |
| `ensureInstance` | Create or reuse an instance (`createSuccinixInstance` replacement) |
| `getInstance` | Read an existing instance |
| `releaseInstance` | Dispose and remove an instance |
| `listProcesses` | Process table snapshot for the default or a named instance |
| `on` | Typed domain event subscription |
| `onServerReady` / `onServerClosed` | Port event subscriptions |
| `dispose` | Soft teardown (fiber dispose) |
| `shutdown` | Hard teardown (host kill) |
| `reconfigure` | Validate and apply a new configuration |

Accessing `executor`, `snapshot`, `persist`, `workspace`, or `services` before
the default instance exists fails fast with a state-backed error.

## Instances

`ensureInstance(containerId, opts)` creates a per-instance stack on the shared
page host:

```ts
const alice = await ctx.succinix.ensureInstance('alice', {
  home: '/workspace/alice',
  persistence: { dbName: 'my-app', storeKey: 'alice' },
  executor: {},
});

await alice.executor.exec('node -v');
await alice.snapshot.save(true);
await alice.workspace.flush('manual');
```

Instance state roots, snapshot keys, service/port views, and process views are
partitioned per `containerId`. This is organizational isolation, not a security
boundary.

## Terminal sessions

The host brings its own rendering. `TerminalOutput` is a two-method contract:

```ts
const session = ctx.succinix.terminal.create({
  write: (data) => term.write(data),
  clear: () => term.clear(),
});

term.onData((data) => session.handleData(data));
await session.boot();
```

`SuccinixTerminalSession` owns history, Tab completion, command queueing,
Ctrl+C interrupt, and cwd-following prompts. xterm is not a dependency.

## Ports and services

Port events arrive through `succinix/server-ready` and
`succinix/server-closed`, or the convenience subscriptions:

```ts
ctx.succinix.onServerReady(({ port, url, instanceId }) => {
  app.recordPreview(port, url, instanceId);
});
```

`ctx.succinix.ports` is the canonical page-level view. `expect(port)` /
`release(port)` attribute a port to an instance before spawning.

Declarative services are managed with `ctx.succinix.services`:

```ts
await ctx.succinix.services.ensureFiles();
await ctx.succinix.services.add('web', 'node server.js', 3001);
const start = await ctx.succinix.services.start('web');
const status = await ctx.succinix.services.status('web');
await ctx.succinix.services.stop('web');
```

## Capabilities

The plugin ships a lightweight capability registry with the pattern set:

```text
terminal.exec, terminal.spawn, terminal.kill, terminal.interrupt,
fs.read, fs.write, workspace.restore, workspace.flush, workspace.list
```

```ts
if (!ctx.succinix.capabilities.check('terminal.exec')) {
  throw new Error('execution is not allowed');
}

const dispose = ctx.succinix.capabilities.define('fs.write', () => isAllowed());
```

When the host provides a `capability` service, the plugin registers the same
patterns there. The registry defaults to allow; `capabilities.defaultAllow`
and `capabilities.rules` override it.

## Lifecycle and hot reload

- The HostManager is a page-level module singleton, not a Cordis fiber.
- Fiber reload (`fiber.update`) re-runs `apply` without restarting the host;
  `ctx.succinix.state.host.startedAt` stays stable.
- `dispose()` is soft by default: instances and subscriptions are released,
  the host stays alive.
- `shutdown()` flushes instances, kills the host, clears page registries, and
  sets `containerState` to `disposed`.
- `lifecycle.disposeMode: 'hard'` makes fiber dispose also shut the host down.
- `pagehide` / `beforeunload` trigger shutdown; `flushOnPageHide` keeps the
  page alive while flushing the snapshot.
- `reconfigure(next)` validates synchronously, increments `configRevision`,
  and emits `succinix/state` with `reason: 'config'`. Config changes that
  alter host asset paths or the container mode first run a shutdown.

## Events

Typed events are available through `ctx.succinix.on` and Cordis `ctx.on`:

| Event | Payload |
| --- | --- |
| `succinix/state` | `{ state, reason, changed }` |
| `succinix/server-ready` | `{ port, url?, instanceId? }` |
| `succinix/server-closed` | `{ port, instanceId? }` |
| `succinix/command` | command telemetry: id, instance, runtime, exit, duration |
| `succinix/instance` | `{ containerId, state: 'created' \| 'released' }` |
| `succinix/workspace` | `{ instanceId, reason, savedAt? }` |
| `succinix/process` | `{ instanceId, processes }` (polled aggregate) |

## Assets and integrity

The package ships `assets/host.js`, `assets/lifo-core.js`, `assets/pyodide/*`,
and `assets/sha256.json`. Serve them as static files or import them with Vite:

```ts
import hostJsUrl from '@succinix/engine/host.js?url';
import lifoCoreUrl from '@succinix/engine/lifo-core.js?url';

const fiber = ctx.plugin(engine, {
  hostJsUrl,
  lifoCoreUrl,
  pythonAssetsUrl: '/pyodide/',
});
```

With `assets.integrity: true` (default), `host.js` and `lifo-core.js` are
verified against `sha256.json` before injection.

## Requirements and limitations

- Chromium-only (Chrome/Edge); WebContainers does not support Firefox, Safari,
  or mobile.
- The page must be cross-origin isolated:
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless`.
- Ports are virtual previews; there is no real inbound network.
- No interactive REPL stdin; file-based RPC is the channel.
- Lifo does not support symlinks or hard links.
- `chmod` semantics and permission bits are not simulated.
- Precise OS-level memory/CPU stats are unavailable; estimates are labeled.

## Related documents

- [MIGRATION.md](MIGRATION.md) — 0.4.0 to 0.5.0 guide
- [PLUGIN.md](PLUGIN.md) — third-party Cordis plugin integration
- [cordis-contract.md](cordis-contract.md) — authoritative contract snapshot
- [PROTOCOL.md](PROTOCOL.md) — file-RPC wire contract (v1)
- [FEATURES.md](FEATURES.md) — supported capabilities
