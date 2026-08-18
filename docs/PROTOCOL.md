# Succinix RPC and Interactive Terminal Protocols

> Authoritative contract for `@succinix/engine@0.7.0`. The batch RPC protocol
> version is **2**. The independent interactive-terminal mailbox currently has
> protocol version **1**. The reference implementations are
> `src/engine/client.ts`, `src/engine/host/`, and `src/terminal/`.

## 1. Execution boundary

The browser is the control/device plane. The WebContainer host and its
per-instance Lifo Sandbox are the execution world. Browser code may transport
requests and terminal frames, but it does not parse shell lines, keep shell
history, implement standard commands, or own editor/TUI state.

Two filesystem transports cross that boundary:

- **Batch RPC v2**: atomically publish `/cmd.json` -> `/ack-<id>.json` ->
  `/result-<id>.json`.
- **Interactive terminal v1**: session-scoped frames under
  `/.succinix-terminal/<instance>/<session>/`.

They serve different purposes. Batch RPC returns one bounded result object.
The terminal mailbox streams device input, output, resize, control, and
lifecycle frames into the same Lifo Shell.

## 2. Batch RPC v2

### 2.1 Delivery sequence

```text
Browser TerminalClient                    WebContainer host
        | write + rename /cmd.json                |
        |---------------------------------------->|
        | poll /ack-<id>.json                     | validate + accept
        |<----------------------------------------|
        | poll /result-<id>.json                  | execute in instance
        |<----------------------------------------|
        | read and delete ack/result files        |
```

`/cmd.json` remains a single-slot mailbox. All `TerminalClient` instances that
share one WebContainer also share one FIFO delivery queue, request prefix,
sequence, and batch host epoch. Each accepted request has independent
acknowledgement and result files, so a late asynchronous result cannot
overwrite another request. The client writes a request to a unique temporary
file and renames it into the mailbox; readers therefore never observe partial
JSON.

### 2.2 Request envelope

```ts
interface RpcV2Envelope {
  protocolVersion: 2;
  id: string | number;
  cmd: string;
  bootNonce: string;
  instanceId?: string;              // missing means "default"
  runtimeHint?: 'node' | 'python' | 'lifo' | 'protocol';
  opts?: Record<string, unknown>;
  queuedAt?: number;
}
```

String ids must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. Numeric ids must be
non-negative safe integers. The id is embedded in the ack/result filename, so
invalid ids fail before any path is constructed.

The host requires `protocolVersion === 2`, a valid `id`, a non-empty
`bootNonce`, and a string `cmd`. Protocol v1 and missing version fields are
rejected with `UNSUPPORTED_PROTOCOL`; there is no silent compatibility mode.
Before each host spawn, the client atomically writes this current epoch:

```ts
interface RpcHostEpoch {
  protocolVersion: 2;
  bootNonce: string;
  createdAt: number;
}
// /host-epoch.json
```

The host refuses to start without a valid epoch and accepts only envelopes
whose `bootNonce` equals that epoch for its whole lifetime. A restart fences
undelivered client work, rotates the request prefix and nonce, and makes an old
envelope fail with `STALE_BOOT_NONCE`.
Malformed requests use one of these structured error codes:

```text
MALFORMED_JSON
INVALID_REQUEST
INVALID_REQUEST_ID
UNSUPPORTED_PROTOCOL
STALE_BOOT_NONCE
```

When a valid id is available, the error is returned through that request's
result file. Otherwise the host writes `/rpc-error.json`.

### 2.3 Strict acknowledgement

Acceptance creates `/ack-<id>.json` atomically:

```ts
interface RpcDeliveryAck {
  protocolVersion: 2;
  id: string | number;
  bootNonce: string;
  instanceId: string;
  acceptedAt: number;
}
```

The browser does not begin result polling until it sees an acknowledgement
whose `(protocolVersion, id, bootNonce, instanceId)` exactly matches the
request. The default instance is normalized to the literal `default`. A stale,
cross-instance, or wrong-nonce acknowledgement is ignored. Delivery uses the
caller-provided end-to-end command timeout, including a cold lazy Lifo kernel
load.

The host keeps a bounded set of 4,096 processed ids. A duplicate delivery gets
another acknowledgement but is never executed twice; its original independent
result remains readable.

### 2.4 Result envelope

Every result repeats the same strict identity:

```ts
interface RpcV2Result {
  protocolVersion: 2;
  id: string | number;
  bootNonce: string;
  instanceId: string;
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  runtime?: 'node' | 'python' | 'lifo' | 'ruby' | 'wasi';
  error?: string;
  timing?: {
    queueMs?: number;
    hostMs?: number;
    resultPollMs?: number;
    totalMs?: number;
  };
  [key: string]: unknown;
}
```

The browser accepts a result only when the full identity tuple matches. Stale
results from another page epoch or instance are ignored. After a valid read it
deletes the result. Host writes use a temporary file plus rename so readers
never observe a partial JSON document.

The host polls `/cmd.json` every 50 ms. The client polls results with an
exponential delay from 25 ms to 150 ms. `ping`, `ps`, and `cwd` are read-only
and may be delivered once more after a transport failure; `run`, `spawn`,
`kill`, `interrupt`, `reset-instance`, and `exit` are never automatically
retried.

### 2.5 Commands

| `cmd` | Purpose | Relevant `opts` |
| --- | --- | --- |
| `run` | Execute a command through unified routing | `command`, `cwd`, `env`, `timeout` |
| `spawn` | Start a background real child process | `command`, `cwd`, `env`, `interactive` |
| `ps` | Return the unified real-child and Lifo process view | `runtime`, `scope`, `instanceId` |
| `kill` | Signal a real-child or projected Lifo PID | `pid`, `signal`, `forceAfterMs`, `instanceId` |
| `interrupt` | Abort the foreground command for one instance | none |
| `cwd` | Return the instance session cwd and host root | none |
| `setCwd` | Set an existing absolute cwd under `/workspace` | `cwd` |
| `reset-instance` | Kill instance-owned work and reset its Sandbox/cwd state | none |
| `ping` | Liveness probe | none |
| `exit` | Graceful protocol handshake | none |

`ping` and `interrupt` use a priority queue while an ordinary request is busy.
The host only consumes these two commands on the priority path. When removing
`/cmd.json`, it first verifies that the file still contains the processed id;
this prevents deletion of a priority request that replaced the mailbox.

### 2.6 Unified routing

- A plain `node`, `npm`, or `npx` command starts the real WebContainer binary.
- A plain `python`, `python3`, `pip`, or `pip3` command uses the resident
  Pyodide daemon.
- Everything else runs in the instance's Lifo Sandbox.
- A Node/Python command containing shell syntax runs through Lifo so pipes,
  chains, and redirects share one shell context; runtime adapters forward the
  relevant segment to the real runtime.
- `ruby`, `wasi-run`, and `wasi-info` are Lifo command adapters backed by their
  execution-world runtimes.

Each instance owns one `SandboxContext`: Sandbox, cwd/env, shell jobs, terminal
hub, command registry, package registry, and service registry. `/workspace`
mounts the same `node:fs` tree used by real Node and Python children. Private
Lifo paths such as `/tmp` are not valid cwd values for real child processes.

Single-command stdout/stderr is capped at approximately 1 MiB and retains the
tail. This limit applies to the batch result, not to terminal streaming.

## 3. Interactive terminal mailbox

The public app seam is `InteractiveTerminalService.open()`:

```ts
interface InteractiveTerminalService {
  open(options: {
    instanceId: string;
    cols: number;
    rows: number;
  }): Promise<InteractiveTerminalSession>;
}

interface InteractiveTerminalSession {
  readonly id: string;
  send(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  onData(listener: (data: string) => void): () => void;
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void>;
  close(): Promise<void>;
}
```

`host.terminal.open()` delegates to the default executor's interactive service.
`SuccinixTerminalSession`, `terminal.create()`, `TerminalOutput`, and browser
local-command handlers do not exist in v0.7.

### 3.1 Identity and paths

Every terminal frame carries:

```ts
interface TerminalIdentity {
  protocolVersion: 1;
  sessionId: string;
  instanceId: string;
  bootNonce: string;
}
```

The mailbox root is `/.succinix-terminal`. Instance/session path components
are validated and URL-encoded. A session contains:

- `open.json`: identity, initial `cols`/`rows`, and last acknowledged output;
- `in-<seq>.json`: input, resize, focus, clear, or dispose frames;
- `out-<seq>.json`: output or control frames;
- `ack.json`: highest contiguous output sequence consumed;
- `error.json`: `STALE_NONCE`, `INVALID_FRAME`, or `BACKPRESSURE`.

Input and output sequences are monotonic. The browser consumes only the next
contiguous output frame, acknowledges it, and waits when a gap exists so the
host can replay the missing frame. Reconnect preserves the last output ack.
Host respawn rotates the terminal boot nonce, drops input queued for the dead
host, and rejects old-nonce frames. Heartbeats run every 10 seconds; a missing
heartbeat expires a disconnected session after 30 seconds.

Frames are flushed every 16 ms and data is split at 32 KiB. Browser input,
host output, and disconnected-session buffers are each capped at 1 MiB. Data
beyond a cap is discarded at a UTF-8 boundary and reported as `BACKPRESSURE`;
the transport never grows without bound. Resize frames update live `cols` and
`rows`; Ctrl+C is transported as `SIGINT`/ETX to the same Lifo foreground
command. Dispose closes the terminal transport and detaches it from the
instance Sandbox.

The entire mailbox tree is runtime state and is excluded from snapshots.

## 4. Process and service views

`ps` merges real host children with every relevant Lifo
`ProcessRegistry`. Lifo-local PIDs are projected into stable host-local public
PIDs starting at `1_000_000_000`, avoiding collisions between per-instance
Sandboxes and real children. Entries include runtime, instance, cwd, state,
scope, start time, and optional interactive terminal identity.

`kill` resolves either kind of PID. Real children use Node signals with an
optional force-after grace period; projected Lifo PIDs are signalled through
the owning `ProcessRegistry`. Non-default instances can only act on their own
organizational process view. This partition is not a security boundary.

Service templates are installed into each Sandbox's Lifo service manager.
`systemctl` therefore observes the same per-instance process and service world.
The host facade `host.services` exposes declarative `list`, `status`, `start`,
`stop`, `restart`, `enable`, `disable`, `add`, `remove`, and `autostart`
operations. Templates include Node HTTP, Vite, static HTTP, Python HTTP,
tinbase (`--engine wasm`), WebSocket, and worker services.

## 5. Lifecycle and cleanup

- Abandoned `result-*.json` files are pruned after 120 seconds by default;
  `resultTtlMs` can override the host-wide cleanup interval.
- `cmd.json`, `ack-*.json`, `result-*.json`, `rpc-error.json`, and the terminal
  mailbox are excluded from snapshot data.
- Reset/dispose aborts foreground work, background jobs, services, terminal
  transport, and the per-instance Sandbox.
- Page-level host respawn does not create a browser shell or restore stale
  terminal input. Batch and terminal identity checks fail closed.

## 6. Deliberate limits

- File RPC is the reliable batch channel; it is not a generic PTY.
- The interactive mailbox terminates at Lifo's public `ITerminal` and
  `CommandContext.stdin`/`setRawMode` seam. It does not provide stdin for
  arbitrary real Node/Python child-process REPLs.
- Ports are WebContainer preview URLs, not inbound sockets.
- Permission bits, symlinks, hard links, native compilers, and a real kernel
  are not simulated.

## 7. Public entry points

Most consumers use `ctx.fs`, `ctx.sandbox`, `ctx.terminals`, and
`ctx.sessionPersistence`. Trusted app integrations may use the internal
`succinix` seam for `executor`, `terminal.open`, snapshots, ports,
services, process views, lifecycle, and typed `succinix/*` events. The removed
pre-0.6 standalone exports and browser-side shell APIs are not compatibility
surfaces.
