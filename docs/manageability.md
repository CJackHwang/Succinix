# Succinix Manageability (C4)

`@succinix/engine@0.6.0` exposes a management surface through the internal
`succinix-host` seam: `host.state`, typed `succinix/*` events,
`onServerReady` / `onServerClosed`, configuration reload, and failure
isolation. The Succinix app provides two minimal local commands for
self-verification; full plugin-management UI belongs to the host (for example
SunamAI's plugin manager).

## State

`host.state` is a snapshot of the plugin's observable state:

- `version`
- `containerMode`: `internal` or `external`
- `containerState`: `unattached`, `booting`, `ready`, or `disposed`
- `host`: `{ pid, startedAt }`; browser `pid` is always `null` (WebContainer
  processes expose no pid), so use `startedAt` as the stable host token
- `instances`: `Array<{ instanceId, state }>`
- `capabilities`
- `configRevision`
- `lastError`

Every mutation is broadcast as `succinix/state` with
`{ state, reason, changed }`. Reasons are `boot`, `ready`, `instance`,
`config`, `error`, and `shutdown`; `changed` lists the fields that changed.

## Events

| Event | Payload purpose |
|---|---|
| `succinix/state` | Plugin state change with reason and changed fields |
| `succinix/server-ready` | Port became ready with instance attribution |
| `succinix/server-closed` | Port closed with instance attribution |
| `succinix/command` | Telemetry: id, instance, runtime, exit code, timing, pid, error |
| `succinix/instance` | Instance created or released |
| `succinix/workspace` | Snapshot/workspace save, restore, clear, or flush |
| `succinix/process` | Process-table snapshot from `listProcesses()` |

Consumers can subscribe through `host.on(...)` or the Cordis event channel
`ctx.on('succinix/...')`.

## Configuration Reload

`host.reconfigure(next)` validates the next config synchronously:

- Hot fields (`resultTtlMs`, capability rules, terminal defaults, lifecycle
  flags) reload the fiber without restarting the host.
- Host fields (`hostJsUrl`, `lifoCoreUrl`, `pythonAssetsUrl`, container mode)
  require a shutdown before the next apply.
- Invalid config throws `ValidationError`, preserves the last valid config, and
  records the issue in `state.lastError`.

## Local Commands

- `succinix status` prints `host.state` plus the engine fiber state.
- `succinix plugins` lists each Cordis plugin runtime and its fiber states,
  including `FAILED`.

Both outputs are ASCII, English, and emoji-free.

## Failure Isolation

- Each app plugin is an independent fiber. A failing app plugin does not remove
  the four dsh services or other app plugin services.
- Engine apply/config failure leaves the page-level `HostManager` singleton
  intact. Reapplying a valid engine config restores the service without
  restarting the host.
- Host boot failure records `lastError` and does not spawn a second host.
- Fiber dispose is soft by default: subscriptions and instance references are
  released while the shared host remains alive. `host.shutdown()` is the
  explicit hard teardown.

## Replay and Session Boundaries

See `docs/replay-support.md` for the J3 replay conclusion and the J2/J5 event
boundary.
