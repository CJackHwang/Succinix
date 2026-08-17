# Succinix Engine — dsh Cordis Integration

> Status: **0.7.0 dsh service provider (release-ready)**. `@succinix/engine` is a
> Cordis plugin for `@deepseek-ai/cordis@4.0.1` and the only public integration
> surface. It provides the dsh service keys `ctx.fs`, `ctx.sandbox`,
> `ctx.terminals`, and `ctx.sessionPersistence`. The old 0.4.0 standalone SDK
> exports (`createTerminalExecutor`, `./terminal`, `./instance`) and the 0.5.0
> single-key `succinix` service are removed; see
> [MIGRATION.md](MIGRATION.md).

`@succinix/engine` gives any dsh-compatible Cordis application a browser-native
Unix execution world inside a WebContainer: a real Node runtime
(`node|npm|npx`), a built-in Pyodide Python (`python|python3|pip|pip3`), and a
Lifo Unix userland for everything else. The container filesystem is shared with
the host application.

This document is the integration reference. For the wire protocol, see
[PROTOCOL.md](PROTOCOL.md). For the capability matrix, see
[FEATURES.md](FEATURES.md). For third-party plugin authoring, see
[PLUGIN.md](PLUGIN.md).

## Install

```bash
npm install @succinix/engine@0.7.0
npm install @deepseek-ai/cordis @webcontainer/api   # peer dependencies
```

`@succinix/engine` requires `@deepseek-ai/cordis ^4.0.1` and
`@webcontainer/api ^1.6.4`.

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
  terminal: { timeoutMs: 120000, bootGate: false },
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
Consumers declare `inject: ['fs', 'sandbox', 'terminals', 'sessionPersistence']`
or probe with `ctx.get('fs', false)`. The published `.d.ts` augments the
`@deepseek-ai/cordis` `Context` and `Events` maps.

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

- `.` is the plugin entry: `{ name: 'succinix', apply, Config }`, plus dsh
  types and the host-seam types.
- `./host.js`, `./lifo-core.js`, and `./assets/*` are static assets for the
  host daemon, Lifo kernel, Pyodide runtime, and `sha256.json`.
- There is no `./terminal` or `./instance` subpath in 0.7.0.

## Public dsh services

The four public service keys are the dsh 0.1.0-rc.6 shapes vendored under
[`docs/contracts/dsh-0.1.0-rc.6/`](contracts/dsh-0.1.0-rc.6/SOURCES.md):

| Key | Contract | Succinix behavior |
| --- | --- | --- |
| `ctx.fs` | 12 primitives, 13 `FS_*` codes, `sandboxMode` | Canonical `/workspace` execution-world paths, atomic text/byte reads and writes, version guards, sandbox-policy fencing |
| `ctx.sandbox` | synchronous `confine(argv, policy)` | Lifo wrapper argv with `enforcement: 'full'`; `node|npm|npx` fail closed with `SANDBOX_UNAVAILABLE` |
| `ctx.terminals` | owner-scoped PTY registry | Exact `Agent` owners, fixed signal whitelist, one in-flight send per session, idempotent `kill` |
| `ctx.sessionPersistence` | event-sourced session log | Append-only JSONL under the instance state root, raw artifacts, truncate-only repair, source-qualified revisions |

Import the published types from `@succinix/engine`:

```ts
import {
  FsError,
  SandboxUnavailableError,
  TerminalError,
  SessionId,
  SessionPersistenceCorruptionError,
  type FileSystem,
  type SandboxProvider,
  type TerminalSessionService,
  type SessionPersistence,
} from '@succinix/engine';
```

### `ctx.fs`

The browser execution world exposes a `FileSystem` with `resolve`,
`processPath`, `fileUrl`, `contains`, `stat`, `lstat`, `readText`,
`streamText`, `readBytes`, `listDir`, `writeText`, and `editText`.

- `resolve(path, opts?)` returns an opaque `targetKey` plus a display path.
  `targetKey` must not be parsed by consumers.
- `stat` / `lstat` return `undefined` for missing targets.
- `readBytes` requires `signal` and `maxBytes`; oversized targets throw
  `FS_TOO_LARGE` instead of returning truncated bytes.
- `writeText` / `editText` accept an optional `sandboxPolicy`; `read-only`
  denies all mutation and `workspace-write` confines writes to the policy's
  `workspaceRoot`.
- Outcomes are LF-normalized so `before` / `after` share the same diff basis.
- `sandboxMode` is `'workspace-write'`: without an explicit policy, mutations
  default to the workspace root.

### `ctx.sandbox`

`confine(argv, policy)` is synchronous and fail-closed:

- Only `read-only` and `workspace-write` are accepted as `SandboxPolicy`.
- A `danger-full-access` mode passed at runtime is rejected.
- Real `node|npm|npx` argv cannot be fenced per call and throws
  `SandboxUnavailableError` (`SANDBOX_UNAVAILABLE`).
- Lifo argv is wrapped as `['succinix-sandbox', '--mode', mode, '--workspace',
  root, ...argv]` with Lifo denial signatures and runner failure rules.
- The wrapper is an execution-world replacement, not a desktop sandbox and not
  a security boundary; shell scripts can still call nested commands.

### `ctx.terminals`

`TerminalSessionService` is owner-scoped and requires an exact `Agent`:

```ts
const agent: Agent = { id: SessionId('agent-1'), status: 'idle', ctx: {} };
host.registerAgent(agent);

const session = await ctx.terminals.spawn(agent, {
  type: 'succinix',
  name: 'shell-1',
});
const send = ctx.terminals.startSend(agent, session.sessionId, {
  text: 'echo hello',
  submit: true,
});
const result = await send.done;
const view = ctx.terminals.read(agent, session.sessionId, { count: 100 });
await ctx.terminals.kill(agent, session.sessionId, 'done');
host.unregisterAgent(agent);
```

There is no implicit `guest` owner. Unregistered owners fail with
`OWNER_NOT_LIVE`; cross-owner access fails with `FOREIGN_SESSION`. Sessions are
process-local and are not restored after a host restart.

### `ctx.sessionPersistence`

`SessionPersistence` is an append-only event log stored as a manifest plus
segmented JSONL files under `/workspace/.succinix/sessions/segments` in v0.7.
The old single-artifact `.jsonl` format remains readable only when a host is
explicitly configured for the v0.6 compatibility adapter:

- `create(meta)` may be lazy: a session with no appended events does not appear
  in `list` / `listSnapshots`.
- `append(id, events)` requires contiguous `seq` values and rejects
  non-JSON-serializable event data.
- `load` repairs only torn trailing lines and never rewrites a complete log.
- `inspect` is read-only and does not commit repair.
- `readRaw` returns the verbatim artifact when `supportsRawArtifacts` is true.
- Segments roll at 500 events or 1 MiB; appends touch only the active segment,
  and compaction switches a temporary manifest atomically.
- `readRaw` reconstructs the header and segment payload on demand; revisions are
  source-qualified and contiguous sequence gaps fail closed.
- Durability is a WebContainer filesystem write plus the active binary snapshot
  generation flush. Snapshot chunks are SHA-256 verified and retain a
  last-known-good generation; v0.6 IndexedDB records are reported as
  `legacy snapshot detected` and are never imported automatically.

### Snapshot v2 lifecycle

Instance snapshots are exported from the WebContainer as binary data and stored
in generation-scoped IndexedDB chunks (256 KiB by default). A manifest is
committed only after all chunks and its SHA-256 digest verify; the active pointer
then advances while retaining the previous generation as last-known-good. The
instance persistence status is `clean`, `dirty`, `saving`, `saved`,
`quota-exceeded`, `corrupt`, or `degraded`. `pagehide`, hidden-page lifecycle
events, `snapshot now`, and the 30-second maximum-age backstop request a
best-effort flush. Files absent from a verified generation are removed after a
successful mount; a failed verification does not advance the active pointer.

## Host seam

`succinix` is the internal lifecycle and app-observability seam. It is not
a dsh service key; trusted consumers that run inside the same Cordis context
can probe it:

```ts
const host = ctx.get('succinix', false);
if (!host) throw new Error('succinix is not available');
```

The seam exposes:

| Member | Purpose |
| --- | --- |
| `state` | Plugin state: version, container, host, instances, capabilities, `configRevision`, `lastError` |
| `container` | Current container handle: `mode`, `state`, `wc`, `hostPid`, `startedAt` |
| `executor` | Default-instance `TerminalExecutor`: `exec`, `spawn`, `listProcesses`, `kill`, `ping`, `pingDirect`, `interruptDirect`, `respawn` |
| `terminal` | `terminal.open({ instanceId, cols, rows })` opens the WebContainer-native interactive Lifo terminal |
| `snapshot` | `save`, `restore`, `meta`, `clear` for the default instance |
| `persist` | Persistence context (snapshot keys, force save) |
| `workspace` | `restore`, `flush`, `list`, plus `stateRoot` and `home` |
| `ports` | `list`, `ready`, `expect`, `release`, `hasConflict`, `onServerReady`, `onServerClosed` |
| `services` | Declarative service management: `list`, `read`, `status`, `start`, `stop`, `enable`, `disable`, `add`, `remove`, `autostart`, `ensureFiles` |
| `userland` | Execution-world extension registry: structured commands, packages, and service templates; `flush` publishes registrations to the active host |
| `capabilities` | Local capability registry: `check`, `list`, `define` |
| `instance` | Default `SuccinixInstance` or `null` |
| `boot` | Boot an internal WebContainer |
| `attach` | Adopt an external WebContainer |
| `ensureInstance` | Create or reuse an instance (`createSuccinixInstance` replacement) |
| `getInstance` | Read an existing instance |
| `releaseInstance` | Dispose and remove an instance |
| `registerAgent` / `unregisterAgent` | Maintain the live-agent set used by `ctx.terminals` |
| `listProcesses` | Process table snapshot for the default or a named instance |
| `on` | Typed `succinix/*` event subscription |
| `onServerReady` / `onServerClosed` | Port event subscriptions |
| `dispose` | Soft teardown (fiber dispose) |
| `shutdown` | Hard teardown (host kill) |
| `flush` | Best-effort snapshot flush for every live instance |
| `reconfigure` | Validate and apply a new configuration |

Accessing `executor`, `terminal`, `snapshot`, `persist`, `workspace`, or
`services` before the default instance exists fails fast with a state-backed
error.

## Container modes

### Internal mode

The plugin boots the WebContainer itself, with retries:

```ts
const wc = await host.boot({
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
await host.attach(wc, { executor: {} });
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
    persistence?: { dbName?: string; storeKey?: string; includeGit?: boolean };
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
configuration and records the reason in `host.state.lastError`.

## Instances

`host.ensureInstance(containerId, opts)` creates a per-instance stack on the
shared page host:

```ts
const alice = await host.ensureInstance('alice', {
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

The human shell runs inside the instance's WebContainer/Lifo Sandbox. The
browser terminal is only a device: it forwards input, output, and live
dimensions through `InteractiveTerminalService.open()`.

```ts
const session = await host.terminal.open({
  instanceId: 'default',
  cols: term.cols,
  rows: term.rows,
});

const output = session.onData((data) => term.write(data));
const input = term.onData((data) => void session.send(data));
const resize = term.onResize(({ cols, rows }) => {
  void session.resize(cols, rows);
});

// During teardown:
input.dispose();
resize.dispose();
output();
await session.close();
```

The returned `InteractiveTerminalSession` exposes `id`, `send`, `resize`,
`onData`, `signal`, and `close`. History, completion, raw mode, cwd, shell jobs,
and `vi`/`nano` state remain in Lifo. The removed
`SuccinixTerminalSession`, `TerminalOutput`, and `terminal.create()` APIs have
no compatibility wrapper. Batch `executor.exec()` continues to use RPC v2.

The public `ctx.terminals` service remains the dsh owner-scoped registry. Its
Succinix backend delegates to the same interactive session, so built-in tools
and third-party terminal consumers share one execution-world path.

## Ports and services

Port events arrive through `succinix/server-ready` and
`succinix/server-closed`, or the convenience subscriptions:

```ts
host.onServerReady(({ port, url, instanceId }) => {
  app.recordPreview(port, url, instanceId);
});
```

`host.ports` is the canonical page-level view. `expect(port)` /
`release(port)` attribute a port to an instance before spawning.

Declarative services are managed with `host.services`:

```ts
await host.services.ensureFiles();
await host.services.add('web', 'node server.js', 3001);
const start = await host.services.start('web');
const status = await host.services.status('web');
await host.services.stop('web');
```

## Capabilities

The engine ships a lightweight capability registry with the pattern set:

```text
terminal.exec, terminal.spawn, terminal.kill, terminal.interrupt,
fs.read, fs.write, workspace.restore, workspace.flush, workspace.list
```

```ts
if (!host.capabilities.check('terminal.exec')) {
  throw new Error('execution is not allowed');
}

const dispose = host.capabilities.define('fs.write', () => isAllowed());
```

The registry defaults to allow; `capabilities.defaultAllow` and
`capabilities.rules` override it.

## Userland extensions

Register extensions on the running host, after `boot()` or `attach()`. The
registration is serialized to the WebContainer mailbox; `flush()` is the
deterministic boundary before executing the newly registered command.

```ts
const host = ctx.get('succinix', false)!;
const unregister = host.userland.registerCommand({
  name: 'hello-userland',
  status: 'adapter',
  runtime: 'lifo',
  execution: 'batch',
  source: { kind: 'shell', command: 'printf "hello\\n"', appendArgs: false },
});

await host.userland.flush();
const result = await host.executor.exec('hello-userland');
unregister();
await host.userland.flush();
```

`host.userland` is the only registration surface connected to the active
execution world. `createUserlandRegistry()` is exported for offline
descriptions and tests; it does not install a command in a running host.
Commands accept only structured execution-world sources, never browser
functions. The registry rejects duplicate names and the kernel-dependent
denylist. Package and service-template registrations use the same mailbox,
package manifest, VFS, process, service, instance, and lifecycle state.

Interactive commands must declare `execution: 'interactive'` and use Lifo's
public `CommandContext.stdin` and `setRawMode` contract. They share the same
terminal transport as `vi`, `nano`, and installed Lifo packages; consumers
must not import Lifo's internal terminal implementation or create a browser
terminal application.

## Lifecycle and hot reload

- The HostManager is a page-level module singleton, not a Cordis fiber.
- `container.hostPid` / `state.host.pid` is always `null` in the browser
  because WebContainer processes expose no pid; `startedAt` is the stable
  host-identity token across soft reloads.
- Fiber reload (`fiber.update`) re-runs `apply`. Hot fields keep
  `host.state.host.startedAt` stable; restart-required fields shut the host
  down before the fiber re-applies.
- `dispose()` is soft by default: instances and subscriptions are released,
  the host stays alive.
- `shutdown()` flushes instances, kills the host, clears page registries, and
  sets `containerState` to `disposed`.
- `lifecycle.disposeMode: 'hard'` makes fiber dispose also shut the host down.
- `flushOnPageHide` enables a best-effort flush on `pagehide`; `beforeunload`
  always triggers best-effort shutdown. Browser unload cannot await async work.
- `reconfigure(next)` validates synchronously, increments `configRevision`,
  and emits `succinix/state` with `reason: 'config'`. Config changes that
  alter host asset paths or the container mode first run a shutdown.
- Every successful `reconfigure` or fiber reapply increments
  `configRevision`; the page-level HostManager keeps the counter monotonic
  across soft reloads.

## Events

Typed `succinix/*` events are internal app-observability events available
through `host.on` and the Cordis context:

| Event | Payload |
| --- | --- |
| `succinix/state` | `{ state, reason, changed }` |
| `succinix/server-ready` | `{ port, url?, instanceId? }` |
| `succinix/server-closed` | `{ port, instanceId? }` |
| `succinix/command` | command telemetry: id, instance, runtime, exit, duration |
| `succinix/command-start` | `{ id, instanceId, command, startedAt }` before execution |
| `succinix/command-finish` | same payload as `succinix/command` |
| `succinix/runtime-ready` | `{ runtime, loadedAt, cached, instanceId? }` runtime asset booted |
| `succinix/degradation` | `{ code, message, runtime, retryable, degraded, instanceId? }` |
| `succinix/persistence` | `{ instanceId, state, generation?, savedAt?, error? }` state transitions |
| `succinix/terminal-open` / `succinix/terminal-close` | `{ instanceId, sessionId, bootNonce }` session lifecycle |
| `succinix/terminal-backpressure` | `{ instanceId, sessionId, bootNonce, queuedBytes, limitBytes }` |
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
- File-based RPC v2 is the batch channel; it is not a generic child-process PTY.
- The execution-world boundary is intentional: WebContainer/Lifo owns userland commands,
  runtimes, packages, services, editors, TUIs, and third-party extensions. The browser is only
  the control/device plane and must not implement a parallel command or editor model. The current
  host connects explicitly interactive userland commands to Lifo's exported
  `ITerminal` and public `CommandContext.stdin`/`setRawMode` seam through thin
  transport.
- This does not make arbitrary Node/Python child-process REPLs supported. Generic child-process
  stdin remains unavailable until a separate, verified host transport exists.
- Lifo does not support symlinks or hard links.
- `chmod` semantics and permission bits are not simulated.
- Precise OS-level memory/CPU stats are unavailable; estimates are labeled.
- `ctx.sandbox` is an execution-world replacement, not a desktop security
  boundary.
- `ctx.sessionPersistence` durability is best-effort across browser reload.

## Related documents

- [MIGRATION.md](MIGRATION.md) — migration to the 0.7.0 single-track plugin
- [PLUGIN.md](PLUGIN.md) — third-party Cordis plugin integration
- [cordis-contract.md](cordis-contract.md) — authoritative contract snapshot
- [PROTOCOL.md](PROTOCOL.md) — RPC v2 and interactive-terminal wire contracts
- [FEATURES.md](FEATURES.md) — supported capabilities
