# Writing Third-Party Cordis Plugins for Succinix

This guide is for Cordis plugin authors who want to consume or extend
`@succinix/engine@0.5.0`. It complements [SDK.md](SDK.md), which documents the
engine's own service surface.

## Plugin contract

The engine is registered as the `succinix` service. Consumer plugins must
declare it explicitly:

```ts
import { Context } from 'cordis';

export const name = 'my-sandbox-consumer';
export const inject = ['succinix'];

export function apply(ctx: Context) {
  const service = ctx.succinix;
  // Use service.executor, service.terminal, service.ports, etc.
}
```

Or probe at runtime when the service is optional:

```ts
export function apply(ctx: Context) {
  const service = ctx.get('succinix', false);
  if (!service) {
    ctx.logger.warn('succinix engine is not loaded; skipping sandbox features');
    return;
  }
}
```

Do not rely on implicit globals or top-level `ctx.mixin`; `ctx.succinix` is the
only integration surface.

## Type augmentation

Importing `@succinix/engine` in the consumer's source makes the published
augmentations visible:

- `Context['succinix']: SuccinixService`
- `Events['succinix/state']`, `'succinix/server-ready'`,
  `'succinix/server-closed'`, `'succinix/command'`, `'succinix/instance'`,
  `'succinix/workspace'`, and `'succinix/process'`

```ts
import '@succinix/engine';

ctx.on('succinix/server-ready', (event) => {
  // event is typed: { port: number; url?: string; instanceId?: string }
});
```

## Boot and container ownership

Choose one container owner per page:

- **Internal mode**: the engine boots the WebContainer.
- **External mode**: your app boots the WebContainer and calls
  `ctx.succinix.attach(wc)`. The engine still owns the in-container host
  daemon.

If your application already owns a WebContainer (for example a runtime plugin
that manages containers), use external mode so there is exactly one container.

```ts
const wc = await myRuntime.boot();
await ctx.succinix.attach(wc, { executor: {} });
await ctx.succinix.ensureInstance('default', {
  home: '/workspace',
  executor: {},
});
```

## Common integration patterns

### Imperative commands

```ts
const result = await ctx.succinix.executor.exec('node -e "console.log(6*7)"', {
  timeoutMs: 30000,
});
if (!result.ok) throw new Error(result.stderr ?? 'command failed');
```

### Terminal UI

The engine is UI-free. Your plugin supplies the rendering target:

```ts
const session = ctx.succinix.terminal.create({
  write: (data) => myTerminal.write(data),
  clear: () => myTerminal.clear(),
});
myTerminal.onData((data) => session.handleData(data));
await session.boot();
```

### Port previews

```ts
const unsubReady = ctx.succinix.onServerReady(({ port, url, instanceId }) => {
  previewRegistry.set(port, { url, instanceId });
});

ctx.succinix.ports.expect(4821);
await ctx.succinix.executor.spawn('node server.js', { timeoutMs: 15000 });
```

### Telemetry and management

```ts
ctx.on('succinix/command', (event) => {
  telemetry.record({
    instance: event.instanceId,
    command: event.command,
    runtime: event.runtime,
    durationMs: event.durationMs,
    exitCode: event.exitCode,
  });
});

ctx.on('succinix/state', (event) => {
  pluginManager.render(event.state);
});
```

`succinix status` and `succinix plugins` in the Succinix app itself are
implementations of this pattern; see `src/host/` for reference.

### Capability policy

Use the engine's local registry for your own gates, or provide a `capability`
service and the engine will register its patterns with it:

```ts
ctx.succinix.capabilities.define('fs.write', () => myPolicy.allows('write'));

if (!ctx.succinix.capabilities.check('terminal.exec')) {
  throw new Error('terminal execution is not allowed');
}
```

## Lifecycle responsibilities

- Keep host asset URLs in plugin config, not runtime state.
- Register listeners with `ctx.effect` or use the returned unsubscribe
  functions so reloads do not leak subscriptions.
- For long-running host processes, call `ctx.succinix.shutdown()` when the
  feature is permanently disabled, not on every fiber reload.
- The engine's default fiber dispose is soft. If you disable the engine
  plugin itself, call `shutdown()` first unless the page is unloading.

```ts
ctx.effect(() => {
  const unsub = ctx.succinix.onServerReady((event) => preview(event));
  return unsub;
});
```

## Extending the engine

The engine does not export a separate client/UI runtime. Extend it by:

- building additional Cordis plugins that consume `ctx.succinix` (commands,
  UI, telemetry, policy, persistence policies);
- replacing the app-level `succinix-app-*` plugins in this repository with
  your own equivalents;
- using `ctx.succinix.capabilities` to enforce your product policy;
- using `ctx.succinix.state` and `succinix/*` events to drive a management UI.

## Examples in this repository

- `examples/cordis-app/` — an external consumer that depends only on the
  packed engine, `cordis`, and `@webcontainer/api`.
- `src/host/` — the Succinix app itself as a Cordis host consuming the engine
  plugin.
- `examples/cordis-app/src/contract.ts` — the authoritative contract checks.

## Related documents

- [SDK.md](SDK.md) — full service and configuration reference
- [cordis-contract.md](cordis-contract.md) — contract snapshot and runner
- [MIGRATION.md](MIGRATION.md) — migration from the 0.4.0 SDK form
- [PROTOCOL.md](PROTOCOL.md) — file-RPC wire protocol
