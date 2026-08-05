# WebUnix TerminalExecutor — File RPC Protocol (authoritative)

> This is the **contract** for the WebUnix command-execution engine (`src/engine/`).
> Ecosystem consumers should be able to build an alternative client or host against this
> document alone, without reading the implementation. The in-repo implementation is the
> reference: `src/engine/client.ts` (browser side) and `src/engine/host.ts` (in-container
> daemon). Protocol version: **1**.

## 1. Overview

WebUnix runs a persistent **host daemon** (`node host.js`) inside a WebContainer.
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
  "cmd": "run",         // one of: run | spawn | ps | kill | cwd | setCwd | ping | exit
  "opts": {             // command-specific options (optional)
    "command": "...",   // full command string (run / spawn)
    "pid": 1234,        // target process id (kill)
    "cwd": "/workspace/proj", // target session cwd (setCwd; optional)
    "timeout": 30000    // host-side timeout in ms (run / spawn; optional)
  }
}
```

| `cmd`    | Purpose                                        | `opts`               |
|----------|------------------------------------------------|----------------------|
| `run`    | Execute one command (unified routing)          | `command`, `timeout` |
| `spawn`  | Start a background long-running process (node) | `command`, `timeout` |
| `ps`     | List the process table                         | —                    |
| `kill`   | Terminate a real child process                 | `pid`                |
| `cwd`    | Return the session working directory           | —                    |
| `setCwd` | Explicitly set the session working directory   | `cwd`                |
| `ping`   | Liveness probe                                 | —                    |
| `exit`   | Graceful shutdown handshake                    | —                    |

The host polls `/cmd.json` every **50 ms**. It tracks the last processed `id` and ignores
a request whose `id` is not a number or equals the previous one (dedup). Unknown `cmd`
values are answered with `{ "ok": false, "error": "unknown command: <cmd>" }`.

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
| `ps`     | `{ ok, kind: "ps", processes: [{ pid, cmd, status, startTime, exitCode?, outputTail? }] }` |
| `kill`   | `{ ok, killed, message }`                                        |
| `cwd`    | `{ ok, kind: "cwd", cwd }`                                       |
| `setCwd` | `{ ok, kind: "cwd", cwd }` (the new session cwd)                 |
| `ping`   | `{ ok, kind: "pong" }`                                           |
| `exit`   | `{ ok, kind: "bye" }`                                            |

### Session cwd (`cwd` / `setCwd`)

The host maintains a **session cwd** (initial value `process.cwd()`, persisted to
`/etc/webunix.cwd` and restored on host start). Every real Node/Python child process is
spawned with `cwd = session cwd`. When a `run` command that starts with `cd` succeeds in
the Lifo sandbox **and** the new cwd is under the `/workspace` mount, the host syncs the
session cwd to it and includes the new value as a `cwd` field on the `run` result.
`cd` to a missing directory keeps the session cwd unchanged. `setCwd` sets it explicitly
(absolute path, must be an existing directory) — it is the explicit protocol form of the
same sync and is optional for clients (interactive `cd` already syncs automatically).

### TTL / prune

The host prunes stale `result-*.json` files (requests the browser abandoned by timing
out) every **60 s**, deleting any file older than the result TTL (**120 s** by default).
The TTL can be overridden by writing `{ "resultTtlMs": <ms> }` to `/etc/webunix.engine.json`
before the host starts (the engine's `boot` writes it only when `resultTtlMs` is passed).

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
- **`python|python3`** (followed by whitespace or end of command) → a **real Node.js child
  process** loading the built-in `python-runtime.js` (python-wasm, Python 3.11). Result
  `runtime: "node"` (it *is* a node child process; the routing field stays stable). Exception
  (TASK24 复审): if the tokenized argv contains a shell metacharacter token the **whole command**
  runs through the Lifo shell (result `runtime: "lifo"`), and each `python`/`python3` segment in
  the chain is forwarded to the real runtime — `python -c "print(1)" | grep 2` → empty,
  `python -c "print(42)" | grep 42` → `42`. The runtime is a system asset injected lazily on
  first use — `python -c "<code>"` executes a code string, `python <script.py>` executes a
  script (absolute paths are resolved against the browser filesystem root = host process cwd).
  Interactive REPL and `pip` are not supported.
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

The engine is consumed through `src/engine/index.ts`:

- `TerminalClient` — the file-RPC client (rich: `terminal`, `exec`, `spawn`,
  `pingDirect`); used by the WebUnix frontend.
- `createTerminalExecutor(): TerminalExecutor` — clean command-style facade for
  ecosystem consumers: `boot(wc, opts)`, `exec(command, opts)`, `spawn(command, opts)`,
  `listProcesses()`, `kill(pid)`, `ping()`, `dispose()`.
- `bootEngineHost(wc, client, hooks)` / `waitForHostReady(client)` — low-level boot
  helpers shared by the facade and the WebUnix boot sequence.

`TerminalExecutor.exec` returns `{ ok: false, timedOut: true }` instead of throwing when
the RPC wait expires (the raw `TerminalClient.exec` still throws). `spawn` returns the
full `ExecResult` (a superset of `{ pid }`) so callers can read `ok`/`runtime`/`error`.

See [SDK.md](./SDK.md) for the packaging/embedding design, and `src/engine/` for the
reference implementation.

## 10. Known boundaries

These are intentional constraints of the environment/protocol:

- **Interactive stdin** is unreliable in WebContainer — file RPC replaces it. `log -f`
  and REPL-style processes are not supported. This is why `python` has no interactive
  REPL (use `python -c "<code>"` / `python <script.py>`); `pip` is not available either.
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
