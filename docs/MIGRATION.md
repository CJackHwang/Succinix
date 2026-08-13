# Succinix Engine Migration Guide

This guide moves an existing `@succinix/engine` consumer from the **0.4.0
standalone SDK form** to the **0.5.0 Cordis plugin form**. The 0.5.0 package is
single-track: the only public integration surface is the `succinix` Cordis
plugin and the services it provides as `ctx.succinix`.

The migration is breaking by design. It changes the public exports, the
lifecycle ownership, the configuration style, and the way runtime callbacks
are consumed. The wire protocol (file RPC over `/cmd.json`) is unchanged.

## What changed

### Exports

| 0.4.0 | 0.5.0 |
| --- | --- |
| `import { createTerminalExecutor } from '@succinix/engine'` | apply the Cordis plugin, then use `ctx.succinix.executor` |
| `import { SuccinixTerminalSession } from '@succinix/engine/terminal'` | `ctx.succinix.terminal.create(output)` |
| `import { createSuccinixInstance } from '@succinix/engine/instance'` | `ctx.succinix.ensureInstance(containerId, opts)` |
| `boot(wc, { onServerReady })` callback configuration | `ctx.succinix.onServerReady(handler)` or `ctx.on('succinix/server-ready', handler)` |
| `boot(wc, { onServerClosed })` callback configuration | `ctx.succinix.onServerClosed(handler)` or `ctx.on('succinix/server-closed', handler)` |
| `pagePorts` | `ctx.succinix.ports` (canonical ports view) |

The root export of `@succinix/engine@0.5.0` is the plugin object
`{ name: 'succinix', apply, Config }`. The `./terminal` and `./instance`
subpath exports are removed. The only remaining subpath exports are
`./host.js`, `./lifo-core.js`, `./assets/*`, and `./package.json`.

### Lifecycle ownership

In 0.4.0, the consumer owned the host lifecycle through
`createTerminalExecutor()` and `dispose()` killed the host. In 0.5.0, the
plugin owns lifecycle semantics:

- `ctx.succinix.boot()` boots a WebContainer in **internal** mode.
- `ctx.succinix.attach(wc)` adopts a host-owned WebContainer in **external**
  mode. The plugin still injects and spawns the in-container host daemon.
- `attach()` and `boot()` are mutually exclusive; switching modes throws
  `ERR_MODE_MISMATCH`.
- Fiber reload / dispose is **soft** by default (`disposeMode: 'soft'`): the
  page-level HostManager keeps the host process alive.
- `ctx.succinix.shutdown()` is the hard teardown: it flushes instances, kills
  the host, clears subscriptions, and resets the page-level singleton state.
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
npm install @succinix/engine@0.5.0 cordis @webcontainer/api
```

### 2. Apply the plugin

```ts
import { Context } from 'cordis';
import engine from '@succinix/engine';

const ctx = new Context();
const fiber = ctx.plugin(engine, {
  container: { mode: 'external' },
});
await fiber;
```

The package `.d.ts` augments `Context['succinix']` and the `Events` map, so
`ctx.succinix` and `ctx.on('succinix/...')` type-check once the plugin is
imported.

### 3. Give the plugin a container

**External mode** (the host application owns the WebContainer):

```ts
const wc = await WebContainer.boot();
await ctx.succinix.attach(wc, {
  executor: {},
});
```

**Internal mode** (the plugin boots the WebContainer):

```ts
const wc = await ctx.succinix.boot({
  instanceId: 'default',
  executor: {},
});
```

### 4. Create the default instance

```ts
const inst = await ctx.succinix.ensureInstance('default', {
  home: '/workspace',
  persistence: { dbName: 'my-app', storeKey: 'default' },
  executor: {},
});
```

`ctx.succinix.executor`, `snapshot`, `persist`, `workspace`, `ports`, and
`services` operate on this default instance. Multiple instances reuse the same
page-level host.

### 5. Replace `createTerminalExecutor()`

```ts
// Before (0.4.0)
const term = createTerminalExecutor();
await term.boot(wc);
const result = await term.exec('node -e "console.log(1+1)"');

// After (0.5.0)
const result = await ctx.succinix.executor.exec('node -e "console.log(1+1)"');
```

### 6. Replace `@succinix/engine/terminal`

```ts
import type { TerminalOutput } from '@succinix/engine';

const output: TerminalOutput = {
  write: (data) => term.write(data),
  clear: () => term.clear(),
};
const session = ctx.succinix.terminal.create(output);
term.onData((data) => session.handleData(data));
await session.boot();
```

The host still owns rendering; the plugin never imports xterm.

### 7. Replace `createSuccinixInstance()`

```ts
// Before (0.4.0)
const inst = await createSuccinixInstance({ wc, instanceId: 'alice' });

// After (0.5.0)
const inst = await ctx.succinix.ensureInstance('alice', {
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
const unsubReady = ctx.succinix.onServerReady(({ port, url, instanceId }) => {
  app.recordPreview(port, url, instanceId);
});
const unsubClosed = ctx.succinix.onServerClosed(({ port, instanceId }) => {
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

| 0.4.0 config callback | 0.5.0 replacement |
| --- | --- |
| `onServerReady` | `ctx.succinix.onServerReady` / `succinix/server-ready` |
| `onServerClosed` | `ctx.succinix.onServerClosed` / `succinix/server-closed` |
| `onCommand` | `ctx.succinix.on('succinix/command')` |
| terminal `TerminalOutput` | passed to `ctx.succinix.terminal.create(output)` |

## Runnable example

The compact surface example lives in
[`examples/cordis-app/src/migration.ts`](../examples/cordis-app/src/migration.ts)
and is executed as part of the external demo contract
([`examples/cordis-app/src/contract.ts`](../examples/cordis-app/src/contract.ts)).
It verifies the migration mapping without booting a container:

```ts
import { Context } from 'cordis';
import engine from '@succinix/engine';

const ctx = new Context();
const fiber = ctx.plugin(engine, {
  container: { mode: 'external' },
  defaultInstance: { instanceId: 'migration-demo' },
});
await fiber;

const service = ctx.succinix;
// executor, terminal, snapshot, persist, workspace, ports, services,
// capabilities, instance, and container all exist on the service surface.

await fiber.dispose();
```

Run it with the external demo:

```bash
npm run build:engine-package
node scripts/cordis-app-e2e.mjs
```

See [docs/cordis-contract.md](cordis-contract.md) for the full contract
snapshot and [docs/PLUGIN.md](PLUGIN.md) for third-party plugin integration.
