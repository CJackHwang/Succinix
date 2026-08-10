# Succinix Engine — SDK Form Design (recommendation)

> This is a **design document**, not a shipped package. It evaluates how to let *other*
> frontend projects embed the Succinix engine as a sandbox, and recommends a path.
> The in-repo decoupling is already done (`src/engine/`, see [PROTOCOL.md](./PROTOCOL.md)
> for the wire contract); this document decides what the *distribution* should look like.

## Target scenario

> **"Embed the Succinix engine into different people's frontend projects to provide a
> sandbox."**

The host app already runs in a Chromium browser and can create a WebContainer. It wants a
Unix-like shell / command executor for its users — with a real Node runtime and a Unix
userland, sharing the app's files — without building that itself.

## The three candidate forms

### Form A — npm package `@succinix/engine`

Package the engine directory (browser client + the two in-container host assets) and
publish it. A consumer installs it and does:

```ts
import { WebContainer } from '@webcontainer/api';
import { createTerminalExecutor } from '@succinix/engine';

const wc = await WebContainer.boot();
const term = createTerminalExecutor();
await term.boot(wc, {
  onServerReady: (port, url) => app.recordPreview(port, url),
  onServerClosed: (port) => app.dropPreview(port),
});

const r = await term.exec('node -e "console.log(1+1)"');   // runtime: "node"
const r2 = await term.exec('grep -i foo file.txt');        // runtime: "lifo"
await term.dispose();
```

The `TerminalExecutor` facade is the **complete ecosystem surface** (P1-3):

| Method | Purpose |
| --- | --- |
| `boot(wc, opts?)` | Inject host assets, spawn the host, wait until it answers `ping`. |
| `exec(cmd, opts?)` | Run one command (unified routing); a timeout returns `{ ok:false, timedOut:true }` instead of throwing. |
| `spawn(cmd, opts?)` | Background long-running process (node family); returns `{ pid }`. |
| `listProcesses()` | Snapshot of the unified process table (`ps`). |
| `kill(pid)` | SIGTERM a table entry; returns `true` on success. |
| `ping()` | Host liveness probe. |
| `pingDirect(timeoutMs?)` | Watchdog probe that **bypasses the serialized queue** — usable while a long command occupies it. `true`=alive, `false`=timeout, `null`=channel busy (skip the round, neutral). |
| `respawn()` | Restart the host: kill old → re-inject assets → spawn fresh → wait ready. Preserves the single-host invariant. |
| `dispose()` | Release resources (kill host, clear refs). Idempotent. |

> **Two execution surfaces, one host** (P1-3). The Succinix app's own terminal additionally
> uses the lower-level `TerminalClient` (from `bootEngineHost`) for its command path, because
> its command handlers rely on raw protocol semantics (`exec` throwing on timeout, the
> `processes`/`killed`/`cwd` fields, a `client` handle in command contexts). Both surfaces
> drive the **same** host and the **same** `/cmd.json` channel; they are deliberately not the
> same object. Embedders should use `createTerminalExecutor()`.

- **How it embeds:** as a library, same page, same origin, same WebContainer.
- **Integration depth:** deep — the engine shares the app's container filesystem, so the
  app and the sandbox see the same files. This is the product's core differentiator.
- **Isolation:** medium — no iframe boundary. Command isolation comes from the Lifo
  sandbox + the host process model, not from a separate document/global. Untrusted
  *node* code runs as a real child process (WebContainer's own sandbox).
- **Performance:** best — direct file-RPC on the shared filesystem, no serialization bridge.
- **Bundle size:** engine client is tiny; the host daemon (`host.js`, ~5 KB) must be
  served as a static asset (bundled or fetched from the package), and `lifo-core.js`
  (~1 MB) loads lazily on first Lifo command.
- **Maintenance:** one repo, one version; host and client ship together. Versioned by npm.

### Form B — iframe sandbox (Succinix as a deployed page)

Deploy Succinix as a standalone sandbox page; the host app embeds it with an `<iframe>`
and talks to it over `postMessage`.

- **How it embeds:** an iframe + a message bridge (command → result, port events relayed).
- **Integration depth:** shallow — files do not auto-share. The app must sync content into
  and out of the sandbox explicitly.
- **Isolation:** strong — separate origin, document, CSS, globals. Best for untrusted
  code or when the app cannot afford a WebContainer of its own... but the sandbox still
  needs *its own* WebContainer, so the app pays the container cost twice if it also boots one.
- **Performance:** a bridge (postMessage + JSON serialization per command) on top of the
  sandbox's own file-RPC. More moving parts, longer round trips.
- **Bundle size:** nothing in the host app; the sandbox page is deployed once.
- **Maintenance:** run/deploy/version the sandbox page independently; keep the bridge
  schema in sync.

### Form C — scaffolding `create-succinix-app`

A CLI/template that generates a "host + engine" project skeleton (Vite host app, engine
pre-wired, optional terminal UI, port registry, PROTOCOL-aware client).

- Not an alternative to A/B — it is the **onboarding** for them. Reduces the "how do I
  wire boot + a terminal + ports?" blank page.

## Comparison

| Dimension        | A — npm package                       | B — iframe sandbox                   | C — scaffold              |
|------------------|---------------------------------------|--------------------------------------|---------------------------|
| Integration depth| deep (shared filesystem)              | shallow (explicit sync)              | — (onboarding for A/B)    |
| Isolation        | medium (Lifo + process model)         | strong (document/origin boundary)    | —                         |
| Performance      | best (direct file-RPC)                | bridge overhead + double container   | —                         |
| Bundle size      | engine small; host assets to serve    | none in app; sandbox deployed once   | —                         |
| Maintenance      | one repo, npm-versioned               | sandbox page + bridge schema         | template tests            |
| Fits "embed into different frontends" | **yes** (same-page, best UX) | yes, but forfeits shared FS | accelerates A adoption |

## Recommendation: **Form A**, then evolve toward B and C

**Recommended primary form is A (`@succinix/engine`).** The target scenario is same-page
embedding: a frontend that already has a WebContainer wants a sandbox *in* its page,
sharing its files. A gives:

- **The shared-filesystem experience intact** — the app's `wc.fs`, Node child processes,
  and Lifo commands all see one tree. This is Succinix's reason to exist and only survives
  in a same-page integration.
- **The lowest latency and simplest operational surface** — no bridge, no second
  container, no separately deployed page to keep alive.
- **A clean extension boundary** — the engine already exposes the whole protocol through
  `TerminalExecutor`; a future postMessage adapter (Form B) can sit *on top of* it without
  changing the engine.

**Form B is the fallback for hard isolation.** If a consumer later needs a strong document
boundary (untrusted code, hostile CSS, or a host app that cannot itself boot a
WebContainer), a `@succinix/sandbox-page` + bridge package can wrap the same engine. It is
a *distribution* choice, not a different engine.

**Form C is the growth lever** — a template so new consumers get a working host + engine
app in one command.

## Landing roadmap

1. **Now (this task, POC):** engine decoupled into `src/engine/`, clean public API,
   authoritative protocol doc, this design doc. Same repo, same build (vite bundles the
   engine into the Succinix bundle); the directory/API boundary is what enables the split.
2. **Stage 1 — split the package (Form A).**
   - Prerequisites: engine has no runtime dependency on the Succinix app layer (done in
     this task: logging is injected via `onCommand`, no `persist`/`log`/`config` imports).
   - Publish `@succinix/engine` from `src/engine/` + the host assets (`public/host.js`,
     `public/lifo-core.js`); the consumer serves those two files (or we fetch from a CDN).
   - Define a release/versioning flow and a smoke test against an external Vite app.

> **Status — implemented (TASK-S2):** the package structure landed locally in
> `packages/engine/` as `@succinix/engine@0.1.0`: build-artifact publish (clean ESM
> `dist/` + `.d.ts`), host assets shipped in-package and exposed as `./host.js` /
> `./lifo-core.js` subpath exports, `npm pack --dry-run` + an offline consumer typecheck
> verified. Publishing is intentionally deferred (release agent).
3. **Stage 2 — postMessage bridge (Form B, optional).**
   - Prerequisites: Form A shipped; define the bridge schema as a 1:1 mapping of the
     file-RPC protocol (request id → result, port events relayed); document COOP/COEP
     requirements for the sandbox page.
   - Ship as an adapter + a deployable sandbox page (`@succinix/sandbox`).
4. **Stage 3 — scaffold (Form C).**
   - Prerequisites: Form A API stable, PROTOCOL/SDK docs complete, CI runs the template
     tests.
   - `create-succinix-app` generates the host + engine skeleton and wires `boot`, a
     terminal (optional), and the port registry.

Each stage is gated on the previous one; none of them changes the wire protocol
(see [PROTOCOL.md](./PROTOCOL.md), version 1).

## What already exists (after this task)

- `src/engine/index.ts` — public API: `TerminalClient`, `createTerminalExecutor()`,
  `bootEngineHost`, `waitForHostReady`, types (`TerminalExecutor`, `ExecResult`,
  `TerminalExecutorOptions`, `ProcInfo`).
- `src/engine/client.ts` — file-RPC client (log-decoupled via `onCommand`).
- `src/engine/host.ts`, `host-procs.ts`, `lifo-core.ts` — in-container host daemon and
  process registry, built to `public/host.js` + `public/lifo-core.js`.
- `docs/PROTOCOL.md` — the authoritative wire contract.
- This document — the SDK form decision.

## Terminal SDK (embedding a terminal session, 0.4.0)

Since 0.4.0 the package exposes `@succinix/engine/terminal` — a UI-free terminal
interaction core for hosts that want a full terminal experience (history, Tab
completion, real Ctrl+C interrupt, command queue, prompt with cwd tracking)
without bundling xterm. The host brings its own rendering: `TerminalOutput` is a
two-method contract (`write(data)` / `clear()`), so an xterm adapter is a ~10-line
shim.

```ts
import { SuccinixTerminalSession, type TerminalRpc } from '@succinix/engine/terminal';
import { createTerminalExecutor, type ExecResult } from '@succinix/engine';

const executor = createTerminalExecutor();
await executor.boot(wc); // inject host.js + spawn + wait ready (once per page)

const rpc: TerminalRpc = {
  exec: (cmd, _opts, timeoutMs) => executor.exec(cmd, { timeoutMs }),
  spawn: (cmd, _opts, timeoutMs) => executor.spawn(cmd, { timeoutMs }),
  listProcesses: () => executor.listProcesses(),
  kill: (pid) => executor.kill(pid),
  ping: () => executor.ping(),
  pingDirect: (t) => executor.pingDirect(t),
  interruptDirect: (t) => executor.interruptDirect(t),
};

const session = new SuccinixTerminalSession(rpc, { write: (d) => term.write(d), clear: () => term.clear() }, {
  localHandlers: { hello: async (ctx, args) => `hello ${args.join(' ')}\n` },
});
term.onData((d) => session.handleData(d));
await session.boot(); // unlock input gate + first prompt
```

### Contracts

- **`TerminalRpc`** — narrow RPC surface: `exec` (required), plus optional
  `spawn` / `listProcesses` / `kill` / `ping` / `pingDirect` / `interruptDirect` /
  `readdir`. `createTerminalExecutor()` satisfies it natively (see
  [engine index](./PROTOCOL.md)); optional methods degrade safely (e.g. no
  `readdir` → Tab completion falls back to command names only; no
  `interruptDirect` → Ctrl+C clears the queue without signaling the host).
- **`TerminalOutput`** — `{ write(data: string): void; clear(): void }`. The SDK
  never imports xterm; rendering (colors, font, scrollback) belongs to the host.
- **Local command injection** — `localHandlers: Record<string, (ctx, args) => ...>`.
  Built-ins are `help` / `clear` / `pwd` / `echo`; a host-provided handler overrides
  the built-in with the same name. Commands not in the table go to the RPC unchanged
  (the host answers `unknown command` semantics).
- **Boot steps configuration** — `createTerminalBoot(ui, { steps, testMode?, retry?,
  hostReadyDeadlineMs?, onCommand? })` runs the full boot flow (environment check,
  WebContainer.boot with retry, host injection/spawn, snapshot restore, workspace
  init, autostart) with `N/M` progress counting. `steps: string[]` labels the fixed
  sequence; dynamic steps carry their own messages. The standalone app uses
  `DEFAULT_BOOT_STEPS` (8 base steps + autostart services).

### Division of labor

- `createTerminalExecutor()` is the **imperative channel** (Agent/host plumbing):
  boot/exec/spawn/ps/kill/ping/respawn.
- `SuccinixTerminalSession` is the **interactive session**: it owns line editing,
  history, completion, queueing, cwd-following prompts and the boot gate, and
  renders command results through `TerminalOutput`.
- `createTerminalBoot()` is the **boot orchestrator**: step labels/progress/retry
  parameterization for hosts that want the same boot UX as the standalone app.

### Packaging notes

- `@succinix/engine/terminal` bundles `session` + `boot` (ESM, `@webcontainer/api`
  external as a peer dependency). `grep "node:" dist/terminal.js` is empty — the
  terminal layer is browser-only, like the engine itself.
- The host owns one executor per page (single host invariant); create multiple
  sessions over the same RPC channel when you need several terminal views.

## Multi-instance embedding (0.4.0)

Since 0.4.0 the package exposes `@succinix/engine/instance` — an aggregate factory
that assembles a full per-instance stack in one call: booted executor, terminal
session, snapshot persistence and service views.

```ts
import { createSuccinixInstance } from '@succinix/engine/instance';
import type { WebContainer } from '@webcontainer/api';

const wc = await WebContainer.boot();
const inst = await createSuccinixInstance({
  wc,
  instanceId: 'alice', // user/tenant id; 'default' (or '') = standalone behavior
  output: { write: (d) => term.write(d), clear: () => term.clear() }, // required
});
term.onData((d) => inst.terminal.handleData(d));
await inst.terminal.boot();

await inst.executor.exec('node -v');      // imperative channel, routed per instance
await inst.snapshot.save();               // per-instance persistence key
const states = await inst.services.list(); // per-instance service view
await inst.restart();                     // instance-level reset (clear state + rebuild session)
await inst.dispose();                     // releases session + executor (shared host untouched)
```

`SuccinixInstance` exposes `instanceId`, `client` (the per-instance RPC client),
`terminal` (session; `restart()` swaps in a fresh one), `executor`, `persist`,
`ports` (port → preview URL view), `snapshot {save, restore}`, `services
{list, start, stop}`, `restart()` and `dispose()`.

### Isolation model (DM-11)

Organizational isolation only — **not a security boundary**. One shared host
daemon per page; instances split directories, state, snapshots and process views.

| Dimension | Cross-container (two tabs/pages) | Same-page (multiple instances) |
| --- | --- | --- |
| Runtime (host, Node, Lifo) | fully separate | shared single host |
| Filesystem / interactive cwd | fully separate | shared (Lifo cwd is page-level) |
| Persistent state / snapshots | fully separate | per-instance keys |
| Services + port previews | fully separate | per-instance expected-port registry |
| Process table (`ps`) / `kill` | fully separate | filtered by `instanceId`; cross-instance/user `kill` rejected (host routing) |
| RPC channel / watchdog | one per page | one shared per page |

### Sharing rules (same page)

- **One RPC channel per WebContainer** — `/cmd.json` is a single-slot mailbox.
  Create one `TerminalClient` per instance (each stamped with its own
  `instanceId`); the channel (queue, request ids, write timing) is shared
  automatically per `wc`. Never boot several hosts on one page.
- **One watchdog per page, host-level** — `createSuccinixInstance` never creates a
  watchdog; wire it once per page (e.g. `startHostWatchdog`) and let all
  instances share it.
- **`rpc` option** — pass the page's already-booted client to reuse its host;
  when omitted the factory boots its own host (single-instance pages, or each tab
  of a multi-tab demo — identical to the standalone app).

### Host-style wiring (one instance per container / per user)

Recommended embedding: one WebContainer per user session, one instance per
container — each user gets full runtime isolation from the aggregate API:

```ts
async function userSession(userId: string) {
  const wc = await WebContainer.boot();
  const inst = await createSuccinixInstance({
    wc,
    instanceId: userId,
    home: `/workspace/users/${userId}`, // per-user home (browser wc.fs view)
    output: render(userId),
  });
  await runApplicationBootSteps(instBoot, {
    wc,
    client: inst.client,
    ports: inst.ports,
    instanceId: userId,
    userHome: `/workspace/users/${userId}`, // seeds home + session cwd
  });
  startHostWatchdog(inst.executor, wc); // once per page
  return inst;
}
```

Same-page multi-instance is supported (each instance needs its own client with
its own `instanceId` and its own `output`), but per DM-11 the shared runtime
means interactive Lifo cwd and long-running processes are page-level, not
per-instance.

### Multi-user semantics (0.4.0, U1)

`userId` and `instanceId` are the same field — a user is an instance with a home
directory. The demo URL `?user=<id>` is an alias of `?instance=<id>` that
additionally seeds a per-user home.

- **Home convention**: `/workspace/users/<id>` (browser `wc.fs` view; the root
  `/workspace/users` is overridable). Pass `home` to the factory — the session
  starts inside the home (Lifo view `/workspace/workspace/users/<id>`) and the
  prompt renders it as `~` (`alice@succinix:~$`).
- **Home init**: `runApplicationBootSteps({ userHome })` (or `ensureUserHome`)
  creates the directory on first boot, seeds a `.succinix` marker file with the
  user id, and writes the session-cwd state file so the host resumes in the home
  after refresh.
- **Process view**: `ps` with a user/instance id returns only that user's
  processes plus `system`. `kill` from a non-default instance rejects processes
  not owned by it (`permission denied: process <pid> is not owned by instance
  '<id>'`), including every `system` process. The default instance (`guest` /
  standalone app) keeps the pre-0.4.0 behavior: full process table, kill
  anything.
- **Identity**: the standalone app remains `guest`-only. Embed hosts pass a
  `promptPrefix` (e.g. `alice@succinix:`) and a `userId` for `whoami`.
- **Isolation caveat**: organizational only — process ownership is a
  cwd/scope heuristic, not a security boundary (see AGENTS.md "Explicitly Not
  Implemented").

### statePrefix caveat

`statePrefix` overrides where browser-side state files live (default
`/workspace/.succinix-<id>`; default instance = `/etc`). Host-side attribution
(process filtering, kill authorization, `ps`) uses the built-in
`.succinix-<id>` prefix, so when you override the prefix keep `instanceId` naming
aligned with it (e.g. `instanceId: 'users/alice'` maps host-side to
`/workspace/.succinix-users/alice`).

## Version strategy (TASK-S1/S2 decision)

- **Main project** releases on the `0.x` line (`0.2.0` → `0.3.0`, continuity with WebUnix history).
- **`@succinix/engine`** ships independently on its own line (`0.1.0` → `0.1.3` at the 0.3.0 release) — decoupled first release; the package is a new artifact with its own version lifecycle.
