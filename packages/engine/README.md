# @succinix/engine

Succinix engine: a Unix-like sandbox that runs **inside a WebContainer** and shares the
container's filesystem with your app. It provides a real Node runtime (`node`, `npm`,
`npx`) plus a Unix userland (Lifo) — `grep`, `ls`, `tar`, `python`, ... — over a single
`TerminalExecutor` API.

The engine is the **same-page embedding** form of
[Succinix](https://github.com/CJackHwang/Succinix): no iframe, no postMessage bridge, no
second container. Your app boots a WebContainer, the engine injects a small host daemon
into it, and commands run as file-RPC on the shared filesystem.

## Install

```bash
npm install @succinix/engine
npm install @webcontainer/api   # peer dependency
```

## Quick start

```ts
import { WebContainer } from '@webcontainer/api';
import { createTerminalExecutor } from '@succinix/engine';
import hostJsUrl from '@succinix/engine/host.js?url';
import lifoCoreUrl from '@succinix/engine/lifo-core.js?url';

const wc = await WebContainer.boot();

const term = createTerminalExecutor();
await term.boot(wc, {
  hostJsUrl,              // host daemon asset URL
  lifoCoreUrl,            // Lifo kernel asset URL (lazily loaded on first Lifo command)
  onServerReady: (port, url) => app.recordPreview(port, url),
  onServerClosed: (port) => app.dropPreview(port),
});

const r = await term.exec('node -e "console.log(1+1)"');  // runtime: "node"
const r2 = await term.exec('grep -i foo file.txt');       // runtime: "lifo"

await term.dispose();
```

> `import ... from '@succinix/engine/host.js?url'` is Vite's asset-URL import. If you are
> not on Vite, see [Host assets](#host-assets) for the alternatives.

## Public API

- `createTerminalExecutor(): TerminalExecutor` — the high-level entry point.
  - `boot(wc, opts?)` — inject host assets, spawn the host, wait until ready.
  - `exec(command, opts?)` — run one command (routing: `node|npm|npx` -> real Node, everything
    else -> Lifo). Timeouts return `{ ok: false, timedOut: true }` instead of throwing.
  - `spawn(command, opts?)` — long-running background process (Node only); returns a pid.
  - `listProcesses(): Promise<ProcInfo[]>` — process-table snapshot.
  - `kill(pid): Promise<boolean>` — SIGTERM a real child process.
  - `ping(): Promise<boolean>` — host liveness probe.
  - `dispose(): Promise<void>` — kill the host, clear references.
- `TerminalClient` — lower-level file-RPC client (the same channel the app itself uses).
- `bootEngineHost(wc, client, hooks?)` — lower-level host bootstrap (skips `waitForHostReady`).
- `waitForHostReady(client, attempts?)` — poll until the host answers `ping`.
- `ensurePythonRuntime(wc)` — lazily inject the Python (Pyodide) runtime into the container.

Types: `TerminalExecutor`, `TerminalExecutorOptions`, `ExecResult`, `CommandLogEntry`,
`ProcInfo`, `EngineBootHooks`.

## Host assets

Two prebuilt assets ride inside the package and are exposed as subpath exports:

| Subpath export | Package file | Purpose |
|---|---|---|
| `@succinix/engine/host.js` | `assets/host.js` | host daemon (`node host.js` in the container) |
| `@succinix/engine/lifo-core.js` | `assets/lifo-core.js` | Lifo kernel, lazily imported by the host on the first Lifo command |

They are **not modules to import as code** — the engine fetches their text and writes them
into the container. Serve them one of these ways:

1. **Vite `?url` (recommended)** — as in the quick start. The bundler emits the asset and
   returns its URL; the engine fetches and injects it.
2. **Copy to your static directory** and rely on the default URLs:

   ```bash
   cp node_modules/@succinix/engine/assets/*.js public/
   ```

   ```ts
   await term.boot(wc);   // fetches /host.js and /lifo-core.js
   ```

3. **Serve from your own CDN** and pass the URLs to `boot` (`hostJsUrl` / `lifoCoreUrl`).

## Packaging decisions

**Build artifacts, not source.** The package ships prebuilt `dist/` (clean ESM + `.d.ts`)
rather than `.ts` source behind an exports map. Reasons:

- Consumers get a zero-config bundle that works in any bundler or directly in the browser;
  source-direct publishing would push TS compilation of this package onto every consumer.
- `.d.ts` are generated once with the package's own tsconfig, giving one authoritative type
  surface instead of per-consumer variance under their strictness settings.
- The two host assets are inherently build artifacts (esbuild bundles, minified, with
  externals), so source-direct would not even remove the build step.
- Bundling strips internal host-only modules (e.g. `host-procs.ts`, whose `node:child_process`
  import is type-only) — the published client is a single self-contained ESM file.

**Assets in-package, not CDN-only.** The host assets ship in `assets/` alongside the client,
so client and host always stay the same version and work offline. `hostJsUrl` / `lifoCoreUrl`
remain for consumers who prefer their own serving.

## Requirements and limitations

- **Cross-origin isolation.** WebContainer requires `SharedArrayBuffer`; your app must send
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`
  (or `require-corp`) headers.
- **Chromium only.** Firefox, Safari and mobile browsers are not supported by WebContainers.
- **Container layout.** The engine writes into the container root: `/host.js`, `/lifo-core.js`,
  `/cmd.json`, `/result-<id>.json`, and optionally `/etc/succinix.engine.json`.
- **Python runtime is out of scope.** `ensurePythonRuntime` lazily injects the Pyodide runtime
  by fetching `/pyodide/...` relative URLs; this package ships only `host.js` + `lifo-core.js`.
  If you need Python, serve the `/pyodide/*` assets the engine expects.

## Versioning

`@succinix/engine` is versioned independently of the host app (first release `0.1.0`).
The wire protocol is versioned separately (see the Succinix `docs/PROTOCOL.md`).
