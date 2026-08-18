# Succinix Transport Protocol

[简体中文](PROTOCOL.zh-CN.md)

## What It Is

This is the protocol between the browser control plane and the WebContainer execution plane. Normal integrations use the `@succinix/engine` executor and terminal services; read this only when replacing the host or transport layer.

## What It Is For

The protocol prevents requests from overwriting each other and keeps commands, terminal I/O, and instance identity in the same WebContainer execution world. The browser does not keep a second shell, filesystem, or editor state.

## How It Works

### Batch commands

```text
Browser writes /cmd.json
Host receives it and writes /ack-<id>.json
Host executes it and writes /result-<id>.json
Browser reads and removes the acknowledgement and result
```

`/cmd.json` is a one-slot submission point: it accepts one unacknowledged request at a time. Results are named by request ID and must never become a shared result file.

Every request carries the RPC version, request ID, boot nonce, command name, and instance ID. The client accepts an acknowledgement or result only when all identity fields match. Public operations include execution, background start, process listing, termination, foreground interrupt, working-directory reads or writes, liveness checks, and exit handshake. Fields and types are defined by `src/engine/client.ts` and exported package types.

### Command routing

- `node`, `npm`, and `npx` use real WebContainer Node subprocesses.
- `python`, `python3`, `pip`, and `pip3` use the built-in Pyodide runtime.
- Other commands use Lifo userland in the same instance.

They share files and session working directory. Generic interactive stdin for real Node or Python subprocesses is still unavailable; a Lifo interactive terminal is not a general PTY.

### Interactive terminals

Interactive terminals use a separate per-instance, per-session mailbox for input, output, size, and lifecycle frames. It connects to Lifo's public terminal API; the browser only forwards device events. Third parties create sessions with `ctx.terminals` or the host terminal service and must not read or write mailbox files directly.

## Constraints

- Results, acknowledgements, and terminal frames validate instance identity and boot nonce. Messages from an old page or host cannot settle a new request.
- Process and port views are organized by instance, not permissions.
- Ports are browser previews; there is no real inbound networking.
- The host removes expired unclaimed result files; callers still need their own timeout and retry policy.

For a protocol or public-behavior change, update the [Cordis contract](cordis-contract.md) example first, then run `node scripts/cordis-app-e2e.mjs`. For normal embedding, read [Integration](SDK.md).
