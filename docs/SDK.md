# WebUnix Engine — SDK Form Design (recommendation)

> This is a **design document**, not a shipped package. It evaluates how to let *other*
> frontend projects embed the WebUnix engine as a sandbox, and recommends a path.
> The in-repo decoupling is already done (`src/engine/`, see [PROTOCOL.md](./PROTOCOL.md)
> for the wire contract); this document decides what the *distribution* should look like.

## Target scenario

> **"Embed the WebUnix engine into different people's frontend projects to provide a
> sandbox."**

The host app already runs in a Chromium browser and can create a WebContainer. It wants a
Unix-like shell / command executor for its users — with a real Node runtime and a Unix
userland, sharing the app's files — without building that itself.

## The three candidate forms

### Form A — npm package `@webunix/engine`

Package the engine directory (browser client + the two in-container host assets) and
publish it. A consumer installs it and does:

```ts
import { WebContainer } from '@webcontainer/api';
import { createTerminalExecutor } from '@webunix/engine';

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

### Form B — iframe sandbox (WebUnix as a deployed page)

Deploy WebUnix as a standalone sandbox page; the host app embeds it with an `<iframe>`
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

### Form C — scaffolding `create-webunix-app`

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

**Recommended primary form is A (`@webunix/engine`).** The target scenario is same-page
embedding: a frontend that already has a WebContainer wants a sandbox *in* its page,
sharing its files. A gives:

- **The shared-filesystem experience intact** — the app's `wc.fs`, Node child processes,
  and Lifo commands all see one tree. This is WebUnix's reason to exist and only survives
  in a same-page integration.
- **The lowest latency and simplest operational surface** — no bridge, no second
  container, no separately deployed page to keep alive.
- **A clean extension boundary** — the engine already exposes the whole protocol through
  `TerminalExecutor`; a future postMessage adapter (Form B) can sit *on top of* it without
  changing the engine.

**Form B is the fallback for hard isolation.** If a consumer later needs a strong document
boundary (untrusted code, hostile CSS, or a host app that cannot itself boot a
WebContainer), a `@webunix/sandbox-page` + bridge package can wrap the same engine. It is
a *distribution* choice, not a different engine.

**Form C is the growth lever** — a template so new consumers get a working host + engine
app in one command.

## Landing roadmap

1. **Now (this task, POC):** engine decoupled into `src/engine/`, clean public API,
   authoritative protocol doc, this design doc. Same repo, same build (vite bundles the
   engine into the WebUnix bundle); the directory/API boundary is what enables the split.
2. **Stage 1 — split the package (Form A).**
   - Prerequisites: engine has no runtime dependency on the WebUnix app layer (done in
     this task: logging is injected via `onCommand`, no `persist`/`log`/`config` imports).
   - Publish `@webunix/engine` from `src/engine/` + the host assets (`public/host.js`,
     `public/lifo-core.js`); the consumer serves those two files (or we fetch from a CDN).
   - Define a release/versioning flow and a smoke test against an external Vite app.
3. **Stage 2 — postMessage bridge (Form B, optional).**
   - Prerequisites: Form A shipped; define the bridge schema as a 1:1 mapping of the
     file-RPC protocol (request id → result, port events relayed); document COOP/COEP
     requirements for the sandbox page.
   - Ship as an adapter + a deployable sandbox page (`@webunix/sandbox`).
4. **Stage 3 — scaffold (Form C).**
   - Prerequisites: Form A API stable, PROTOCOL/SDK docs complete, CI runs the template
     tests.
   - `create-webunix-app` generates the host + engine skeleton and wires `boot`, a
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
