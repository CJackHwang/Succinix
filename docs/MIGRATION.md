# Succinix Engine Migration Guide

This guide moves an existing `@succinix/engine` consumer to the **0.7.0 dsh
service form**. The 0.7.0 package is single-track: it is a Cordis plugin for
`@deepseek-ai/cordis@4.0.1` and provides `ctx.fs`, `ctx.sandbox`,
`ctx.terminals`, and `ctx.sessionPersistence`. The 0.4.0 standalone SDK exports
and the 0.5.0 single-key `succinix` service are removed.

The migration is breaking by design. It changes the public exports, the service
keys, the lifecycle ownership, the configuration style, and the way runtime
callbacks are consumed. The file transport remains `/cmd.json`, but 0.7.0
requires batch RPC v2 and therefore is not wire-compatible with 0.6 clients.

## What changed

### Service keys

| 0.4.0 / 0.5.0 | 0.7.0 |
| --- | --- |
| `createTerminalExecutor()` / single-key `succinix` service | apply the plugin, then use `ctx.fs`, `ctx.sandbox`, `ctx.terminals`, and `ctx.sessionPersistence` |
| `ctx.fs` command facade (`exec` / `spawn` / `ps` / `kill`) | `ctx.fs` for files and `ctx.sandbox.confine` for confined argv; process management stays behind the `succinix` seam |
| `terminal.create(output)` | `ctx.terminals` owner-scoped registry for dsh consumers; the app-level session remains behind the host seam |
| `snapshot` / `persist` facade | `ctx.sessionPersistence` event-sourced log; snapshot remains an internal host capability |
| `boot(wc, { onServerReady })` callback configuration | `succinix` seam (`host.boot` / `host.attach`) plus `host.onServerReady` or `succinix/server-ready` events |
| `pagePorts` | `host.ports` behind the host seam |

The root export of `@succinix/engine@0.7.0` is the plugin object
`{ name: 'succinix', apply, Config }`. The `./terminal` and `./instance`
subpath exports are removed. The only remaining subpath exports are
`./host.js`, `./lifo-core.js`, `./assets/*`, and `./package.json`.

### Dependency baseline

The engine now peers on `@deepseek-ai/cordis ^4.0.1` instead of upstream
`cordis`. Consumer projects must install the dsh fork:

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
```

### Lifecycle ownership

In 0.4.0, the consumer owned the host lifecycle through
`createTerminalExecutor()` and `dispose()` killed the host. In 0.5.0, the
plugin owned the lifecycle but exposed a monolithic service. In 0.7.0:

- `host.boot()` boots a WebContainer in **internal** mode.
- `host.attach(wc)` adopts a host-owned WebContainer in **external** mode. The
  plugin still injects and spawns the in-container host daemon.
- `attach()` and `boot()` are mutually exclusive; switching modes throws
  `ERR_MODE_MISMATCH`.
- Fiber reload / dispose is **soft** by default (`disposeMode: 'soft'`): the
  page-level HostManager keeps the host process alive.
- `host.shutdown()` is the hard teardown: it flushes instances, kills the
  host, clears subscriptions, and resets the page-level singleton state.
- With `lifecycle.flushOnPageHide` enabled, `pagehide` triggers a best-effort
  flush; `beforeunload` always triggers best-effort shutdown.

### Configuration style

Runtime callbacks are no longer accepted in configuration. `SuccinixConfig` is
a serializable, synchronously validated object. Use service subscriptions for
ports and events, and pass `output`, `terminal`, `executor`, `bootSteps`, and
`bootUI` to `ensureInstance()` / `boot()` / `attach()` at call time.

## Step-by-step migration

### 1. Install peers

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
```

### 2. Apply the plugin

```ts
import { Context } from '@deepseek-ai/cordis';
import engine from '@succinix/engine';

const ctx = new Context();
const fiber = ctx.plugin(engine, {
  container: { mode: 'external' },
});
await fiber;
```

The package `.d.ts` augments `Context['fs']`, `Context['sandbox']`,
`Context['terminals']`, and `Context['sessionPersistence']`, so injected dsh
keys and `succinix/*` events type-check once the plugin is imported.

### 3. Give the plugin a container

**External mode** (the host application owns the WebContainer):

```ts
const host = ctx.get('succinix', false)!;
const wc = await WebContainer.boot();
await host.attach(wc, {
  executor: {},
});
```

**Internal mode** (the plugin boots the WebContainer):

```ts
const wc = await host.boot({
  instanceId: 'default',
  executor: {},
});
```

### 4. Create the default instance

```ts
const inst = await host.ensureInstance('default', {
  home: '/workspace',
  persistence: { dbName: 'my-app', storeKey: 'default' },
  executor: {},
});
```

`host.executor`, `snapshot`, `persist`, `workspace`, `ports`, and `services`
operate on this default instance. Multiple instances reuse the same page-level
host.

### 5. Replace command execution

```ts
// Before (0.4.0)
const term = createTerminalExecutor();
await term.boot(wc);
const result = await term.exec('node -e "console.log(1+1)"');

// After (0.7.0)
const result = await host.executor.exec('node -e "console.log(1+1)"');
```

For file access, use `ctx.fs`:

```ts
const target = await ctx.fs.resolve('/workspace/hello.txt');
await ctx.fs.writeText(target, 'hello\n');
const text = await ctx.fs.readText(target);
```

### 6. Replace the terminal API

dsh consumers use the owner-scoped `ctx.terminals`:

```ts
const agent: Agent = { id: SessionId('agent-1'), status: 'idle', ctx: {} };
host.registerAgent(agent);

const session = await ctx.terminals.spawn(agent, {
  type: 'succinix',
  name: 'shell',
});
```

The old UI-free session still exists behind the host seam for the app shell:

```ts
const session = host.terminal.create({
  write: (data) => term.write(data),
  clear: () => term.clear(),
});
term.onData((data) => session.handleData(data));
await session.boot();
```

### 7. Replace instance creation

```ts
// Before (0.4.0)
const inst = await createSuccinixInstance({ wc, instanceId: 'alice' });

// After (0.7.0)
const inst = await host.ensureInstance('alice', {
  home: '/workspace/alice',
  persistence: { dbName: 'my-app', storeKey: 'alice' },
  executor: {},
});
```

The returned `SuccinixInstance` keeps the familiar shape: `instanceId`,
`client`, `terminal`, `executor`, `persist`, `ports`, `snapshot`, `services`,
`workspace`, `restart()`, and `dispose()`.

### 8. Replace `onServerReady` / `onServerClosed`

```ts
const unsubReady = host.onServerReady(({ port, url, instanceId }) => {
  app.recordPreview(port, url, instanceId);
});
const unsubClosed = host.onServerClosed(({ port, instanceId }) => {
  app.dropPreview(port, instanceId);
});
```

The same events are available on the Cordis context:

```ts
ctx.on('succinix/server-ready', ({ port, url }) => {
  app.recordPreview(port, url);
});
ctx.on('succinix/server-closed', ({ port }) => {
  app.dropPreview(port);
});
```

### 9. Serve assets and enable integrity

The package ships `host.js`, `lifo-core.js`, `pyodide/*`, and `sha256.json`
under `assets/`. Copy the runtime assets to your static directory, or import
them with Vite's `?url` syntax and set `hostJsUrl` / `lifoCoreUrl` /
`pythonAssetsUrl` in config. Asset SHA-256 verification is on by default.

```bash
cp node_modules/@succinix/engine/assets/* public/
```

### 10. Move callbacks out of config

Any 0.4.0 option that was a function must move to a service argument or an
event subscription:

| 0.4.0 config callback | 0.7.0 replacement |
| --- | --- |
| `onServerReady` | `host.onServerReady` / `succinix/server-ready` |
| `onServerClosed` | `host.onServerClosed` / `succinix/server-closed` |
| `onCommand` | `ctx.on('succinix/command')` |
| terminal `TerminalOutput` | passed to `host.terminal.create(output)` |

## Runnable example

The compact surface example lives in
[`examples/cordis-app/src/migration.ts`](../examples/cordis-app/src/migration.ts)
and is executed as part of the external demo contract
([`examples/cordis-app/src/contract.ts`](../examples/cordis-app/src/contract.ts)).
It verifies the migration mapping without booting a container:

```ts
import { Context } from '@deepseek-ai/cordis';
import engine from '@succinix/engine';

const ctx = new Context();
const fiber = ctx.plugin(engine, {
  container: { mode: 'external' },
  defaultInstance: { instanceId: 'migration-demo' },
});
await fiber;

const legacyGone = ctx.get('succinix', false) === undefined;
const host = ctx.get('succinix', false);
const fs = ctx.get('fs', false);
const sandbox = ctx.get('sandbox', false);
const terminals = ctx.get('terminals', false);
const persistence = ctx.get('sessionPersistence', false);

await fiber.dispose();
```

Run it with the external demo:

```bash
npm run build:engine-package
node scripts/cordis-app-e2e.mjs
```

See [docs/cordis-contract.md](cordis-contract.md) for the full contract
snapshot and [docs/PLUGIN.md](PLUGIN.md) for third-party plugin integration.

## v0.6 to v0.7 migration matrix

`@succinix/engine@0.7.0` keeps the single-track plugin export
`{ name: 'succinix', apply, Config }`, the `inject: ['succinix']` requirement,
and the `ctx.succinix.*` service namespace. The upgrade is nevertheless
breaking for file-RPC clients and for consumers that supplied the removed
terminal configuration. The table is the public compatibility contract.

| v0.6 surface or assumption | v0.7 contract | Required consumer change |
| --- | --- | --- |
| Plugin root export and `ctx.succinix.*` services | Unchanged | No code change for this surface. |
| Batch file RPC v1, or an envelope without `protocolVersion: 2` and `bootNonce` | Removed. The host rejects it with `UNSUPPORTED_PROTOCOL` before execution. | Send the v2 envelope documented in [PROTOCOL.md](PROTOCOL.md), including `protocolVersion`, a valid `id`, `bootNonce`, and `cmd`. |
| Treating a successful `/cmd.json` write as delivery | Replaced by a matched `/ack-<id>.json` followed by a matched `/result-<id>.json`. | Do not poll results until the ACK identity `(protocolVersion, id, bootNonce, instanceId)` matches the request. |
| Reusing an RPC nonce across a host respawn | Removed. The browser writes a new `/host-epoch.json` before spawning the host; the host accepts only that nonce for its lifetime. | Fence queued work before respawn, rotate the request prefix and terminal nonce, and discard old ACK/result/frame files. A stale batch request returns `STALE_BOOT_NONCE`. |
| Top-level `terminal.cwd`, `timeoutMs`, `bootGate`, `history`, `tabComplete`, `interrupt`, or `promptPrefix` config | Removed and rejected by the synchronous config schema. These fields never controlled the Lifo/RPC terminal. | Pass cwd as an instance/boot/attach option and use `host.terminal.open()` for interactive sessions. |
| v0.6 snapshot store | No automatic import. v0.7 keeps the v0.6 snapshot untouched and reports it as legacy. | Export or preserve the old snapshot independently; do not expect implicit migration. |
| Browser-owned terminal/editor behavior | Removed. Interactive Lifo tools use the WebContainer-native `ITerminal` seam. Generic Node/Python child-process REPLs remain unsupported. | Send input, resize, and signal frames through the interactive-terminal v1 mailbox. |

### Protocol upgrade rules

The batch protocol version is 2, while the independent interactive terminal
mailbox version is 1. They are separate protocols with separate nonces.
`/cmd.json` is still a single-slot mailbox, but the client publishes it through
a temporary file and rename. Before every host spawn, the client atomically
publishes the current batch epoch in `/host-epoch.json`; a host without a valid
epoch refuses to start. The old client must not retry a rejected v1 request as
v1: there is no compatibility fallback.

The executable contract is covered by `tests/client.test.ts` (v2 envelopes,
ACK/result identity, and stale results), `tests/rpc-v2.test.ts`
(envelope primitives and bounded IDs), `tests/host-route.test.ts` (host routing
and mailbox removal), and `tests/terminal-transport.test.ts` (terminal nonce
rotation). Run the focused suite with:

```bash
npx vitest run tests/client.test.ts tests/rpc-v2.test.ts tests/host-route.test.ts tests/terminal-transport.test.ts
```

### Other 0.7 changes

- **New optional config**: `rubyAssetsUrl` (deferred `ruby` runtime asset,
  same shape as `pythonAssetsUrl`). When the bridge cannot supply it, `ruby`
  fails closed with exit 69 instead of guessing an asset location.
- **Typed events are additive**: `succinix/command-start`,
  `succinix/command-finish`, `succinix/runtime-ready`, `succinix/degradation`,
  `succinix/persistence`, `succinix/terminal-open`, `succinix/terminal-close`,
  and `succinix/terminal-backpressure` add telemetry without repurposing the
  existing event names.
- **Runtime pins**: `@lifo-sh/core` is pinned to `0.10.10` (with
  `browser-metro` `1.0.36`) for the WS-locked toolchain.
