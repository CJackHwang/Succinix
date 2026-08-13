# Replay Support Research (C4 / J3)

Status: **restricted replay supported**. Succinix can replay a recorded command
sequence with deterministic command routing, serialized execution, structured
results, and snapshot restoration. It does not promise bit-for-bit replay of
wall-clock timing, process ids, preview URLs, external network responses, or
browser host scheduling.

## Deterministic Surface

The following properties are stable by design and can be relied on during replay:

- **Unified routing is static.** Commands starting with `node`, `npm`, or `npx`
  are dispatched to a real Node child process. All other commands go to the
  Lifo sandbox. The split does not depend on host state, so replay sees the same
  runtime for the same command string.
- **File RPC protocol is v1.** Each request uses `/cmd.json` followed by an
  independent `/result-<id>.json` response file. A replayed request sequence
  uses the same wire contract and never shares a single result file.
- **Per-instance execution is serialized.** The session queues commands, which
  preserves invocation order for a single instance. This is the primary
  ordering guarantee for replay.
- **Results are structured.** `TerminalExecutor.exec()` and `spawn()` return
  `exitCode`, `stdout`, `stderr`, `runtime`, `pid`, and timeout flags instead of
  unstructured terminal text. Recorded assertions can compare these fields.
- **Command telemetry is recorded.** succinix/command events carry `id`,
  `instanceId`, `command`, `runtime`, `exitCode`, `startedAt`, `durationMs`,
  `pid`, `timedOut`, and `error`. These events are the audit trail for replay.
- **Snapshot restore is explicit.** `host.snapshot.restore()` and
  `host.workspace.restore()` restore the known filesystem state before a
  replay begins. `host` is the internal `succinix-host` seam
  (`ctx.get('succinix-host', false)`).

## Non-Deterministic Boundary

Replay must not assert values produced by the environment:

- Host boot duration, command latency, and `durationMs`.
- Process ids from `pid`, `listProcesses()`, or the process table.
- WebContainer preview URLs and `server-ready` payload URLs.
- External network responses, including direct `curl` when CORS permits it.
- User commands that read `Date`, randomness, hostnames, or environment values
  that are not part of the restored snapshot.
- Python/Pyodide package installation timing and compiled package availability
  after a text-based snapshot restore.
- Background services and long-running processes that are not explicitly
  restarted from the service definition.
- Browser-side auto-snapshot timing and IndexedDB write ordering.

## Recommended Replay Contract

1. Restore the instance snapshot and workspace before starting the sequence.
2. Feed the recorded commands through the same instance in order.
3. Assert `exitCode`, `stdout`, `stderr`, and `runtime` for each step.
4. Use succinix/command events to verify step boundaries, instance isolation,
   and elapsed-time telemetry without comparing exact timestamps.
5. Normalize or omit pids, URLs, host boot times, and dates before comparing
   output documents.

Conclusion: Succinix supports **restricted replay** (full, deterministic command
semantics over a restored snapshot), not full time-travel replay. SunamAI should
replay at the command/event level and keep timing-sensitive assertions out of
the replay oracle.

## Session Boundary (J2)

Succinix exposes execution, process, and port events only. It does not
define turn, trigger, or session semantics; those belong to the host layer.
Replay records from Succinix therefore cover command execution and workspace
events, while conversation/turn ordering remains a SunamAI concern.

## Context Injection Events (J5)

succinix/workspace is emitted for known mutation sources: save, restore,
clear, and flush. WebContainer does not provide a reliable native filesystem
watch API in the supported browser environment, so Succinix does not simulate
file watching. Unknown external mutations are outside the event contract.
