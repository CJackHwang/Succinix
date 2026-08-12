# Succinix TerminalExecutor — File RPC Protocol (authoritative)

> This is the **contract** for the Succinix command-execution engine (`src/engine/`).
> Ecosystem consumers should be able to build an alternative client or host against this
> document alone, without reading the implementation. The in-repo implementation is the
> reference: `src/engine/client.ts` (browser side) and `src/engine/host/` (in-container
> daemon). Protocol version: **1**.

## 1. Overview

Succinix runs a persistent **host daemon** (`node host.js`) inside a WebContainer.
The browser holds a **TerminalClient** that sends commands and receives results through
the container's shared filesystem. There is no socket, no stdin pipe, and no shared
result file — every request gets its own file. This is what makes commands reliable in an
environment where interactive stdin is known to be unreliable.

```
Browser (TerminalClient)                Container (node host.js)
        │  write /cmd.json                    │
        │  ──────────────────────────────────►│  poll every 50ms
        │                                     │  dispatch command
        │  poll /result-<id>.json             │
        │  ◄──────────────────────────────────│  write /result-<id>.json
        │  read + delete                       │
```

**Single-slot channel.** `/cmd.json` is a single-file mailbox: at most one request can be
in flight. The browser client serializes all requests through a mutex queue, and the host
processes one request at a time. This is deliberate — it makes failures deterministic.

## 2. Request format (`/cmd.json`)

The browser writes a JSON object to `/cmd.json`:

```jsonc
{
  "protocol": 1,        // protocol version (added in v1; a missing field is treated as 1)
  "id": 42,             // unique request id, strictly increasing per client
  "cmd": "run",         // one of: run | spawn | ps | kill | interrupt | cwd | setCwd | ping | exit
  "instanceId": "c-1",  // instance context (optional, additive; missing = default instance)
  "opts": {             // command-specific options (optional)
    "command": "...",   // full command string (run / spawn)
    "pid": 1234,        // target process id (kill)
    "cwd": "/workspace/proj", // target session cwd (setCwd; optional)
    "timeout": 30000    // host-side timeout in ms (run / spawn; optional)
  }
}
```

| `cmd`       | Purpose                                        | `opts`               |
|-------------|------------------------------------------------|----------------------|
| `run`       | Execute one command (unified routing)          | `command`, `timeout` |
| `spawn`     | Start a background long-running process (node) | `command`, `timeout` |
| `ps`        | List the process table                         | —                    |
| `kill`      | Terminate a real child process                 | `pid`                |
| `interrupt` | Kill the current foreground `run` child (Ctrl+C) | —                  |
| `cwd`       | Return the session working directory           | —                    |
| `setCwd`    | Explicitly set the session working directory   | `cwd`                |
| `ping`      | Liveness probe                                 | —                    |
| `exit`      | Graceful shutdown handshake                    | —                    |

The host polls `/cmd.json` every **50 ms**. It tracks the last processed `id` and ignores
a request whose `id` is not a number or equals the previous one (dedup). Unknown `cmd`
values are answered with `{ "ok": false, "error": "unknown command: <cmd>" }`.

After processing a request the host **deletes `/cmd.json`** (P0-2). `processedId` is an
in-process dedup that starts at `-1` in a freshly spawned host, so a stale `/cmd.json`
surviving a watchdog kill + respawn would otherwise be executed once by the new host; the
delete closes that window (the browser simply rewrites the file on its next request).

## 3. Response format (`/result-<id>.json`)

The host writes exactly one result file per request, named after the request id.
The browser polls the file, reads it, and **deletes it** (read-then-delete). A result
file is never shared between requests, so an asynchronous `close` write can never
overwrite a newer result.

Common fields:

```jsonc
{
  "id": 42,            // echoes the request id
  "ok": true,          // overall success
  "exitCode": 0,       // process exit code (run/spawn); -1 when no process ran
  "stdout": "...",     // captured output (run)
  "stderr": "...",     // captured error output (run)
  "runtime": "node",   // "node" | "lifo" — which route executed the command
  "kind": "pong"       // protocol-command discriminator (ps/cwd/ping/exit)
}
```

Per-command response fields:

| `cmd`    | Success shape                                                    |
|----------|------------------------------------------------------------------|
| `run`    | `{ ok, exitCode, stdout, stderr, runtime }` (+ optional `cwd` on a successful `cd`, TASK23) |
| `spawn`  | `{ ok: true, pid, runtime: "node" }` (immediate); on confirm-window failure `{ ok: false, exitCode, error, runtime }` |
| `ps`     | `{ ok, kind: "ps", processes: [{ pid, cmd, status, startTime, scope, containerId?, exitCode?, outputTail? }] }` — filtered to the requesting instance + `system` when `instanceId` is present |
| `kill`   | `{ ok, killed, message }`                                        |
| `interrupt` | `{ ok, kind: "interrupted", pid, killed, message }` — `pid` is a number when a current foreground `run` child was targeted (SIGTERM sent), `null` when no interruptible run is in flight |
| `cwd`    | `{ ok, kind: "cwd", cwd }`                                       |
| `setCwd` | `{ ok, kind: "cwd", cwd }` (the new session cwd)                 |
| `ping`   | `{ ok, kind: "pong" }`                                           |
| `exit`   | `{ ok, kind: "bye" }`                                            |

### Interrupt (`interrupt`)

`interrupt` implements browser **Ctrl+C** (P5-15). The host tracks the pid of the most
recent foreground `run` child (a real Node subprocess); `interrupt` sends it SIGTERM.
Scope: it only targets that foreground `run` — **background `spawn` services are never
interrupted**, and pure Lifo commands (which run inside the sandbox, not as a table child)
are not interruptible (the sandbox has no abort API). With `instanceId` present the target
is the requesting instance's current `run` (per-instance keying, additive). After the kill, the child's `close`
event settles the original `run` request (its result file appears) and clears the tracked
pid, so the browser's in-flight wait unblocks. The client sends it via `interruptDirect()`
— a direct `/cmd.json` write that bypasses the serialized queue (a queued `interrupt` would
only run *after* the very command it is meant to stop).

### Session cwd (`cwd` / `setCwd`)

The host maintains a **session cwd** (initial value `process.cwd()`, persisted to
`/etc/succinix.cwd` and restored on host start). Every real Node/Python child process is
spawned with `cwd = session cwd`. When a `run` command that starts with `cd` succeeds in
the Lifo sandbox **and** the new cwd is under the `/workspace` mount, the host syncs the
session cwd to it and includes the new value as a `cwd` field on the `run` result.
`cd` to a missing directory keeps the session cwd unchanged. `setCwd` sets it explicitly
(absolute path, must be an existing directory) — it is the explicit protocol form of the
same sync and is optional for clients (interactive `cd` already syncs automatically).

### TTL / prune

The host prunes stale `result-*.json` files (requests the browser abandoned by timing
out) every **60 s**, deleting any file older than the result TTL (**120 s** by default).
The TTL can be overridden by writing `{ "resultTtlMs": <ms> }` to `/etc/succinix.engine.json`
before the host starts (the engine's `boot` writes it only when `resultTtlMs` is passed).

### Instance context (`instanceId`)

`instanceId` is an **additive** optional request field (M3). A request without it — the
behavior of every existing client — targets the **default instance** and is byte-for-byte
compatible with the single-instance protocol. Each result file echoes the normalized
`instanceId` (`"default"` when absent) so the client can verify routing.

Per-instance semantics on the shared host (one page = one RPC channel + one host):

| Surface    | Behavior |
|------------|----------|
| State files | Session cwd (`/etc/succinix.cwd`), env (`/etc/succinix.env`), settings / services / autostart / motd / `succinix.engine.json` resolve under the instance state root `<stateRoot>/etc/...` (`stateRoot = /workspace/.succinix-<id>`, default = `/etc`). |
| `ps`       | With `instanceId`, the response lists only that instance's processes **plus** `system` processes. Without it, all processes (unchanged). Ownership is heuristic (spawn cwd), not a security boundary. |
| `kill`     | With `instanceId` (non-default), only processes owned by that instance may be killed; `system` processes and foreign/unattributed processes are rejected with `permission denied: process <pid> is not owned by instance '<id>'`. Default instance: unchanged (any table entry). Organizational only — same heuristic caveat as `ps`. |
| `interrupt` | Only interrupts the requesting instance's current foreground `run` child (`Map<instanceId, pid>`; default key = previous single-value behavior). Interrupting A never kills B's run. |
| Shared queue | `/cmd.json` remains a single serialized mailbox; `instanceId` only distinguishes ownership. |
| Shared runtime | The Lifo sandbox is page-level (one per host): interactive Lifo cwd is **not** per-instance. Per-instance cwd is a browser-side logical value; node/python spawns use explicit absolute cwd. See SDK.md "Multi-instance" for the full boundary. |

**Multi-user (U1):** `userId` and `instanceId` are the same field — the demo URL
`?user=<id>` maps to `instanceId=<id>` plus a per-user home
(`/workspace/users/<id>`; the session cwd is seeded to the home's Lifo view, so the
prompt renders `~` and node/python spawns start there). `ps` / `kill` above apply to
users exactly as to instances; the standalone app (`guest`) keeps the default-instance
behavior.

Validation note: two browser tabs are independent containers (separate hosts), so they never
exercise the shared-host `instanceId` routing — that path is covered by protocol-level unit
tests (`Map` keying, `ps` filtering, per-instance interrupt), not by the dual-tab e2e demo.

## 4. Command routing

The host applies a single, fixed routing rule to `run` commands:

- **`node|npm|npx`** (followed by whitespace or end of command) → a **real Node.js child
  process** via `child_process.spawn`. Result `runtime: "node"`. Exception (TASK24): if the
  tokenized argv contains a **shell metacharacter** token (`&&`, `||`, `|`, `>`, `>>`, `<`,
  `2>`, `2>&1`, `;`, `&`, `$(`, or a glued redirect like `>file`, `1>out`, `&>all`) the
  **whole command** runs through the Lifo shell instead (pipes/chains/redirects parsed there),
  result `runtime: "lifo"`; each `node`/`npm`/`npx` segment in the chain is forwarded to the
  **real binary** by the host (the Lifo shell's in-browser JS-interpreter shims are overridden).
  A pure node command with no metachars is unchanged (direct spawn).
- **`python|python3|pip|pip3`** (followed by whitespace or end of command) → a **real Node.js
  child process** running the resident Pyodide daemon (`python-daemon.js`, Pyodide 314.0.4 /
  Python 3.14.2). Result `runtime: "node"` (it *is* a node child process; the routing field stays
  stable). Exception (TASK24 复审): if the tokenized argv contains a shell metacharacter token the
  **whole command** runs through the Lifo shell (result `runtime: "lifo"`), and each
  `python`/`python3`/`pip`/`pip3` segment in the chain is forwarded to the **same resident daemon**
  — `python -c "print(1)" | grep 2` → empty, `python -c "print(42)" | grep 42` → `42`. The runtime
  is a system asset injected lazily on first use — `python -c "<code>"` executes a code string,
  `python <script.py>` executes a script (absolute paths are resolved against the browser
  filesystem root = host process cwd), `python -m pip install <pkg>` maps to Pyodide's micropip.
  Interactive REPL is not supported (AGENTS.md boundary); `pip` is available via micropip.
- **everything else** → the **Lifo sandbox** (`sandbox.commands.run`). Result `runtime: "lifo"`.

The command string is split with a shlex-style tokenizer (`src/engine/tokenize.ts`): single/double
quotes group whitespace, a backslash escapes the next character (`\"` inside quotes → literal `"`,
`\\` → `\`, `\'` in single quotes → `'`), and an **unterminated quote throws**
`unterminated quote in command` (reported as `{ ok: false, exitCode: -1, stderr: "unterminated quote in command", runtime: "node" }`)
instead of silently truncating. No variable expansion. Empty commands are answered with
`{ ok: false, exitCode: -1, stderr: "empty command", runtime: "lifo" }`.

### Error semantics

| Condition                       | Response                                                            |
|---------------------------------|---------------------------------------------------------------------|
| Unknown protocol `cmd`          | `{ ok: false, error: "unknown command: <cmd>" }`                    |
| Node subprocess not found       | `{ ok: false, exitCode: -1, stderr: String(e), runtime: "node" }`   |
| Node subprocess times out       | child killed; `{ ok: false, exitCode: -1, stderr: "node subprocess timed out after <ms>ms, killed", runtime: "node" }` |
| Node/npm stderr contains `EACCES` + `/usr/local` | original stderr, then a newline + `hint: /usr/local is read-only for guest. Install locally: npm i <pkg>  (or set a user prefix: npm config set prefix ~/.npm-global)` (TASK24) |
| Python assets not injected      | `{ ok: false, exitCode: -1, stderr: "python runtime failed to load: assets not injected yet ...", runtime: "node" }` |
| Lifo command throws             | `{ ok: false, exitCode: -1, stderr: <first 200 chars>, runtime: "lifo" }` |
| `spawn` with a non-node command | `{ ok: false, error: "spawn only supports node/npm/npx background processes ...", runtime: "lifo" }` |
| `kill` of a non-table pid       | `{ ok: false, killed: false, message: "process <pid> not in process table; Lifo-side processes are list-only (kill not supported)" }` |
| `setCwd` with a bad path        | `{ ok: false, error: "setCwd: cwd must be an absolute path ..." / "setCwd: not a directory: ..." }` |

**Output cap.** Each command's `stdout` and `stderr` are independently capped at ~1 MB
(tail kept). The host trims incrementally at 2× the cap and applies the final cut when
settling the result, so result files are bounded even for huge dumps.

## 5. Process model

- **`spawn`** starts a background long-running process (node family only; Lifo has no
  background concept). The host returns immediately with the pid, and the process's
  output streams into its process-table entry (`outputTail`, last ~500 chars).
- **Startup-confirmation window (2 s).** A spawned process that exits non-zero within
  2 seconds is reported as a **failure** (`ok: false`) — e.g. an `npx` package that does
  not exist, or a node script with a syntax error. Healthy services (tinbase, http
  servers) survive the window with no caller-visible change.
- **Process table** (`host-procs`): every real child is registered with `{ pid, cmd,
  status: running|exited, startTime, exitCode?, outputTail? }`. The table caps at 100
  entries, pruning the oldest exited entries.
- **Process ownership** (TASK-CISOL): each `ps` entry additionally carries `scope`
  (`system` | `container` | `unknown`) and, for `scope=container`, `containerId`
  (e.g. `c-1`). Classification is heuristic: commands matching Succinix system assets
  (`node host.js`, `node python-daemon.js`, any `/usr/lib/succinix/` path) → `system`;
  otherwise a child spawned with its cwd inside a container root (`.../c-<id>`, as happens
  when the caller runs `cd /workspace/c-<id> && <cmd>`) → `container` + `containerId`;
  otherwise `unknown`. These are new fields — the existing `pid/cmd/status/...` contract
  is unchanged.
  - ⚠️ **Not a security boundary.** `scope` is derived from the command string + launch
    cwd and can be spoofed (any user process whose command looks like a system asset is
    classified `system`). It is for **UI display, query filtering and organizational
    kill authorization only** — do not use it as a trust basis for real permission /
    security isolation. For hard semantics, switch to explicit declaration (the
    spawner passes `scope` at spawn time).
- **`kill`** sends SIGTERM to a table entry; the entry flips to `exited` on the child's
  `close` event. A failed spawn (e.g. ENOENT) is marked `exited` explicitly because
  `close` never fires in that case.
- **Lifo-side processes are list-only** — they are not in the table and `kill` reports
  the "not in process table" message rather than pretending to terminate them.

## 6. Port events

The engine does not tunnel ports itself; it relays WebContainer's port lifecycle to the
host application:

- `server-ready (port, url)` → `onServerReady(port, url)` (the host application records
  the preview URL).
- `port (port, "close")` → `onServerClosed(port)` (the host application removes the URL).

These callbacks are registered by the engine's `bootEngineHost` (`src/engine/index.ts`)
when it spawns the host. They are app-level notifications, not part of the file-RPC wire
protocol.

## 7. Timeout / retry

### Browser-side (client) waits

| Call                         | Default wait |
|------------------------------|--------------|
| `exec` / `terminal`          | 30 s         |
| `spawn`                      | 5 s          |
| `pingDirect` (watchdog)      | 30 s         |

A wait is the **RPC polling budget** — how long the browser waits for the result file.
The host may keep working after the browser gives up; the stale result is pruned by TTL.

### Host-side command timeouts

| Route      | Default timeout | Override                     |
|------------|-----------------|------------------------------|
| Lifo       | 25 s            | `opts.timeout` on `run`      |
| Node child | 30 s            | `opts.timeout` on `run`      |

On timeout the host kills the node child and settles the result; the browser sees a
non-zero exit with a `timed out` stderr message.

### Retry

Only **idempotent, read-only** protocol commands — `ping`, `ps`, `cwd` — are retried once
on RPC failure (re-sending them is safe). `run`, `spawn`, `kill`, `exit` are never
retried by the client.

### `pingDirect` watchdog

The host-liveness watchdog probes the host with a direct `ping` that **bypasses the mutex
queue**, so a long command holding the queue cannot delay liveness detection. The probe is
skipped (neutral) when the channel is busy: if there are queued-but-unstarted requests, or
the last `/cmd.json` write is within the **250 ms** host-poll margin (the host may not have
read it yet). `true` = pong, `false` = timeout (host unreachable), `null` = skipped.

## 8. Client behavior

- **Serialization.** All requests go through one FIFO queue; a request that times out
  does not break the chain.
- **Adaptive polling.** The browser polls the result file starting at 25 ms and backs off
  exponentially to a 150 ms ceiling, so fast commands return quickly and long commands do
  not hammer the filesystem.
- **Read-then-delete.** The result file is removed immediately after a successful read.
- **Protocol version.** Every request carries `protocol: 1`. A missing field is treated
  as version 1. The host does **not** strictly reject mismatched versions — unknown
  fields are ignored, so the version is advisory rather than a hard gate. Future changes
  should stay backward compatible; a breaking change would bump the version in this
  document and clients would adapt to the new response shape, not be refused outright.

## 9. Engine public API (summary)

In 0.5.0 the engine is consumed as a Cordis plugin: `@succinix/engine` exports
`{ name: 'succinix', apply, Config }`, and consumers reach the facade through
`ctx.succinix.executor` after injecting `succinix`. The pre-0.5.0 standalone SDK
exports (`createTerminalExecutor`, `createSuccinixInstance`, `./terminal`,
`./instance`) are removed; see [MIGRATION.md](./MIGRATION.md).

The package still wires the same low-level pieces inside `src/engine/`:

- `TerminalClient` — the file-RPC client (rich: `terminal`, `exec`, `spawn`,
  `pingDirect`); used by the Succinix frontend and the plugin runtime.
- `bootEngineHost(wc, client, hooks)` / `waitForHostReady(client)` — low-level boot
  helpers shared by the plugin and the Succinix boot sequence.

`ctx.succinix.executor` keeps the command-style facade semantics: `exec(command, opts)`,
`spawn(command, opts)`, `listProcesses()`, `kill(pid)`, `ping()`, `dispose()`.
`TerminalExecutor.exec` returns `{ ok: false, timedOut: true }` instead of throwing
when the RPC wait expires (the raw `TerminalClient.exec` still throws). `spawn` returns
the full `ExecResult` (a superset of `{ pid }`) so callers can read `ok`/`runtime`/`error`.

See [SDK.md](./SDK.md) for the plugin packaging/embedding design,
[PLUGIN.md](./PLUGIN.md) for third-party consumption, and `src/engine/` for the
reference implementation.

## 10. Known boundaries

These are intentional constraints of the environment/protocol:

- **Interactive stdin** is unreliable in WebContainer — file RPC replaces it. `log -f`
  and REPL-style processes are not supported. This is why `python` has no interactive
  REPL (use `python -c "<code>"` / `python <script.py>` / `python -m pip <cmd>`). `pip`
  is available via Pyodide's micropip (pure-Python wheels persist across refresh via the
  NODEFS site-packages; compiled wheels such as numpy need a `pip install` after refresh —
  the text snapshot does not carry `.so` files, see `docs/LANGUAGES.md`).
- **Session cwd sync covers the `/workspace` mount only**: a Lifo `cd` into a VFS-private
  path (e.g. `/tmp`, `/home/user`) succeeds in Lifo but has no host-filesystem equivalent,
  so the session cwd is left unchanged (Node/Python children keep the last synced cwd).
- **CORS** — `curl` to sites without CORS headers fails; use `https://r.jina.ai/<url>`.
- **Symlinks / hard links** are not supported by the Lifo VFS.
- **1 MB output cap** — stdout/stderr keep only the tail past 1 MB.
- **Lifo kernel lazy load** — `host.js` stays lightweight; the ~1 MB `lifo-core.js`
  bundle is loaded dynamically on the first Lifo command (with a 150 ms background
  prewarm). The first Lifo command can be slower than later ones.
- **Single-slot channel** — no true concurrency; parallel commands serialize.
