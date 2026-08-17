# Writing Third-Party Cordis Plugins for Succinix

This guide is for Cordis plugin authors who want to consume or extend
`@succinix/engine@0.7.0`. It complements [SDK.md](SDK.md), which documents the
engine's service surface.

## Execution-world rule

Succinix plugins extend the WebContainer/Lifo execution world. A command, runtime, package,
service, editor, TUI, or interactive tool must run inside the container userland and use the
engine's shared filesystem, instance, process, service, package, persistence, and capability
models. Browser code is only a control/device plane and may provide xterm rendering, keyboard/
resize transport, or unavoidable Web APIs; it must not implement a parallel command or editor.

The current v0.6 host uses headless `Sandbox.commands.run()` for batch execution. The v0.7
interactive path connects xterm to Lifo's in-container `ITerminal` and public
`CommandContext.stdin`/`setRawMode` seam. Third-party
interactive tools must use that same seam and declare `execution: 'batch' | 'interactive' | 'both'`
in their capability/package metadata. See [PLAN-v0.7.0.md](PLAN-v0.7.0.md).

## Plugin contract

The engine is registered as the `succinix` plugin and provides four dsh
services. Consumer plugins must declare them explicitly:

```ts
import { Context } from '@deepseek-ai/cordis';

export const name = 'my-sandbox-consumer';
export const inject = ['fs', 'sandbox', 'terminals', 'sessionPersistence'];

export function apply(ctx: Context) {
  // ctx.fs, ctx.sandbox, ctx.terminals, ctx.sessionPersistence are injected.
  const fileSystem = ctx.fs;
  const sandbox = ctx.sandbox;
}
```

Or probe at runtime when the services are optional:

```ts
export function apply(ctx: Context) {
  const fs = ctx.get('fs', false);
  if (!fs) {
    ctx.logger.warn('succinix engine is not loaded; skipping sandbox features');
    return;
  }
}
```

Do not rely on implicit globals or top-level `ctx.mixin`. The old
single-key `succinix` service is gone; app-level lifecycle facades are
available only through the internal `succinix` seam:

```ts
const host = ctx.get('succinix', false);
```

## Type augmentation

Importing `@succinix/engine` in the consumer's source makes the published
augmentations visible:

- `Context['fs']: FileSystem`
- `Context['sandbox']: SandboxProvider`
- `Context['terminals']: TerminalSessionService`
- `Context['sessionPersistence']: SessionPersistence`
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

- **Internal mode**: the engine boots the WebContainer through
  `host.boot()`.
- **External mode**: your app boots the WebContainer and calls
  `host.attach(wc)`. The engine still owns the in-container host daemon.

If your application already owns a WebContainer (for example a runtime plugin
that manages containers), use external mode so there is exactly one container.

```ts
const host = ctx.get('succinix', false)!;
const wc = await myRuntime.boot();
await host.attach(wc, { executor: {} });
await host.ensureInstance('default', {
  home: '/workspace',
  executor: {},
});
```

## Common integration patterns

### File operations

`ctx.fs` is the dsh file system:

```ts
const target = await ctx.fs.resolve('/workspace/notes.txt');
const created = await ctx.fs.writeText(target, 'hello\n');
const text = await ctx.fs.readText(target);
const edited = await ctx.fs.editText(target, {
  oldString: 'hello',
  newString: 'world',
  replaceAll: false,
});
```

### Confined commands

`ctx.sandbox.confine` returns argv for the Lifo execution world. Real
`node|npm|npx` requests fail closed:

```ts
const argv = ctx.sandbox.confine(['grep', 'foo', 'file.txt'], {
  mode: 'workspace-write',
  workspaceRoot: '/workspace',
});
// argv.argv -> ['succinix-sandbox', '--mode', 'workspace-write', ...]
```

### Terminal sessions

The public `ctx.terminals` registry is owner-scoped. The owner comes from the
host agent layer; Succinix never invents an implicit guest:

```ts
const session = await ctx.terminals.spawn(owner, {
  type: 'succinix',
  name: 'shell',
});
const send = ctx.terminals.startSend(owner, session.sessionId, {
  text: 'echo hi',
  submit: true,
});
const result = await send.done;
```

### Session persistence

```ts
const meta: SessionHeader = {
  version: 0,
  id: SessionId('session-1'),
  createdAt: Date.now(),
};
await ctx.sessionPersistence.create(meta);
await ctx.sessionPersistence.append(meta.id, [
  { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 0 } },
]);
const snapshot = await ctx.sessionPersistence.list();
```

### Port previews

Port lifecycle is app-level. Subscribe through the host seam:

```ts
const unsubReady = host.onServerReady(({ port, url, instanceId }) => {
  previewRegistry.set(port, { url, instanceId });
});

host.ports.expect(4821);
await host.executor.spawn('node server.js', { timeoutMs: 15000 });
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

Use the engine's local registry for your own gates:

```ts
host.capabilities.define('fs.write', () => myPolicy.allows('write'));

if (!host.capabilities.check('terminal.exec')) {
  throw new Error('terminal execution is not allowed');
}
```

## Lifecycle responsibilities

- Keep host asset URLs in plugin config, not runtime state.
- Register listeners with `ctx.effect` or use the returned unsubscribe
  functions so reloads do not leak subscriptions.
- For long-running host processes, call `host.shutdown()` when the feature is
  permanently disabled, not on every fiber reload.
- The engine's default fiber dispose is soft. If you disable the engine
  plugin itself, call `shutdown()` first unless the page is unloading.
- Register an `Agent` with `host.registerAgent(owner)` before using it with
  `ctx.terminals`, and unregister it with `host.unregisterAgent(owner)` when
  the agent is disposed.

```ts
ctx.effect(() => {
  const unsub = host.onServerReady((event) => preview(event));
  return unsub;
});
```

## Extending the engine

The engine does not export a separate client/UI runtime. Extend it by:

- building additional Cordis plugins that consume `ctx.fs`, `ctx.sandbox`,
  `ctx.terminals`, and `ctx.sessionPersistence`;
- replacing the app-level `succinix-app-*` plugins in this repository with
  your own equivalents;
- using `host.capabilities` to enforce your product policy;
- using `host.state` and `succinix/*` events to drive a management UI.

To add a userland command, publish a structured definition through the running
host. It is installed in the WebContainer/Lifo command registry, not in the
browser plugin:

```ts
const host = ctx.get('succinix', false)!;
const unregister = host.userland.registerCommand({
  name: 'project-greeting',
  status: 'adapter',
  runtime: 'lifo',
  execution: 'batch',
  source: { kind: 'shell', command: 'printf "project-ready\\n"', appendArgs: false },
});

await host.userland.flush();
await host.executor.exec('project-greeting');

ctx.effect(() => unregister);
```

`flush()` is required before the command is first used. Register packages and
service templates through the same `host.userland` surface. Interactive tools
must use Lifo's public stdin/raw-mode contract and the existing terminal seam;
browser-side command or editor implementations are outside this API. See
[SDK.md](SDK.md#userland-extensions) for the full contract.

## Examples in this repository

- `examples/cordis-app/` — an external consumer that depends only on the
  packed engine, `@deepseek-ai/cordis`, and `@webcontainer/api`.
- `src/host/` — the Succinix app itself as a Cordis host consuming the engine
  plugin.
- `examples/cordis-app/src/contract.ts` — the authoritative contract checks.

## Related documents

- [SDK.md](SDK.md) — full service and configuration reference
- [cordis-contract.md](cordis-contract.md) — contract snapshot and runner
- [MIGRATION.md](MIGRATION.md) — migration from the 0.4.0/0.5.0 forms
- [PROTOCOL.md](PROTOCOL.md) — file-RPC wire protocol
