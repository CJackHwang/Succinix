# WebUnix

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-black.svg)](package.json)
[![CI](https://github.com/CJackHwang/WebUnix/actions/workflows/ci.yml/badge.svg)](https://github.com/CJackHwang/WebUnix/actions/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**A browser-native Linux: a full-screen Unix terminal powered by WebContainer + Lifo, with a unified TerminalExecutor that routes `node|npm|npx` to a real Node.js runtime and everything else to a Lifo Unix userland — sharing one filesystem.**

Open a browser tab, boot into a Linux-like environment, and use Unix tools, Node.js, process management, port forwarding, and a Postgres database (tinbase) without installing anything.

---

## Features

- **Full-screen terminal experience** — a centered DOM boot splash with system self-checks and graceful environment-exit (shows a professional error page instead of degrading), then an interactive shell (`guest@webunix:~$`).
- **Unified command execution** — one terminal entry point:
  - `node`, `npm`, `npx` and project binaries run on a **real Node.js process** (WebContainer).
  - Everything else (`grep`, `sed`, `awk`, `cat`, `tar`, `curl`, pipes, redirects, ...) runs on **Lifo**, a clean-room TypeScript implementation of Unix.
- **Shared filesystem** — the browser (`wc.fs`) and Lifo commands operate on the *same* files. No bridge code; WebContainer virtualizes `node:fs` for processes, and Lifo consumes it via `NativeFsProvider`.
- **Process management** — `ps` / `kill` over a unified process table (real child processes + tracked state), including background `spawn`.
- **Port management** — services are detected via WebContainer `server-ready` events and listed by `ports` with their preview URLs.
- **Database** — `db start` boots a real Postgres (tinbase, PGlite/WASM engine) inside the container; `db status` / `db stop` manage it.
- **Persistence** — the workspace (files, config, env, settings, workspaces) is snapshotted to IndexedDB and restored on boot; refresh never loses user files. `snapshot` command for status / manual save / reset. Snapshots are text-focused: binary/unreadable files are skipped (counted and reported in the save log), and a snapshot whose collected size exceeds ~50 MB is skipped with a warning rather than written (`snapshot now` reports `skipped (over 50MB limit)`). The tinbase database store (`.tinbase`, PGlite/WASM) is excluded entirely — it is binary and a text-only partial restore would corrupt it, so tinbase data persists across `db stop`/`db start` in a session but **not** across a browser refresh (refresh recreates a fresh store).
- **Memory management** — `free` / `top` give a memory overview (device + JS heap; sandbox estimates are honestly labeled), `reboot` restarts the system with a browser reload (persisted data survives), `shutdown` powers off, and `cache` / `cache clear` report and clean rebuildable caches without touching `/workspace`.
- **Workspace split** — `workspace` manages multiple isolated workspaces: each lives in its own `/ws/<name>` directory with its own files and state; `create` / `switch` / `rm` manage them, and the current workspace is recorded in `/ws/.current` (persists across refreshes). The default `main` workspace is initialized on first boot.
- **System configuration** — `env` manages persistent environment variables (`/etc/webunix.env`, merged into real Node child processes at spawn time) and `settings` manages persistent system settings (`/etc/webunix.settings`): the tinbase port (`preview-port`, default 3001), the initial workspace (`default-workspace`, default `main`), and the terminal font size (`font-size`, applied live). Both files ride the snapshot so they survive refreshes.
- **Service management** — `service` manages named background services declaratively on top of `spawn`/`ps`/`kill` and the port registry: definitions live in `/etc/webunix.services` (`name|command|port`, `#` comments, `${PORT}` placeholder resolved from `preview-port`), with `start`/`stop`/`status`/`enable`/`disable`. `enable` records the service in `/etc/webunix.autostart` and boot pulls it up declaratively — a declarative restart, not a daemon (no crash self-healing).
- **System log (journald-style)** — a persistent log written to `/var/log/webunix.log` on the container FS (rides the snapshot, so it survives refreshes), formatted `2026-08-05T04:00:00Z [level] message`. It captures boot events (`BOOT`), command executions (`INFO` with `cmd`/`exit`/`runtime`), service events (`INFO`/`WARN`), snapshot events (`INFO`) and errors (`ERROR`). `log` reads it (`log` last 20, `log -n <count>`, `log boot` BOOT-only, `log clear`); the file auto-truncates to a ~200 KB tail when oversized. Interactive `log -f` (tail -f) is intentionally not implemented (POC).
- **Package management** — `pkg` unifies the two real package channels behind one apt-style interface: **lifo** (`lifo list` / `lifo install` / `lifo remove` / `lifo search` — Lifo extension packages such as `lifo-pkg-git`, `lifo-pkg-ffmpeg`) and **npm** (real Node npm for the full ecosystem). Source is auto-detected: a package whose `lifo-pkg-<name>` exists on npm installs via lifo, otherwise via npm; on a name conflict lifo wins (tool packages). `pkg list` merges both channels with a `SOURCE` column, `pkg search` merges both searches, `pkg install`/`remove` echo the real command output and never swallow failures. The npm installed list is read from the `node_modules` **top-level directories only** (a "top-level direct-install" simplification — the container's preinstalled runtime dependencies appear too, and the dependency tree is not parsed).
- **Virtual network view** — `netstat` renders the port registry as a virtual listening-port table (`Proto  Local Address  State`, `tcp 127.0.0.1:<port> LISTEN`; `netstat -p` adds the associated process, matched by port number in the process command, `-` when unmatched) and `ip addr` shows the browser's virtual network identity (`lo: virtual loopback`, `eth0: <preview-domain> (virtual)`). Everything is honestly labeled `virtual` — no fabricated interfaces, IPs, or connections.
- **System information & login banner** — `uname` reports the honest browser-native system identity (`WebUnix 0.2.0 js-runtime+webcontainer <api-version> <arch>`; kernel identified as `js-runtime+webcontainer`, never impersonating a Linux kernel; `-a` adds hostname/OS, `-r` is the `@webcontainer/api` runtime version, `-m` is the UA-derived architecture) and `motd` shows/edits the login banner at `/etc/webunix.motd` (persisted with snapshots; the default welcome line is printed on every boot and restored by `motd reset`).
- **Self-test mode** — `?test=1` runs a system-diagnostics self-check in the browser.

## Architecture

```
┌─────────────────────────── Browser tab ───────────────────────────┐
│  xterm.js (JetBrains Mono, dark-amber theme)                      │
│    │  terminal(command)                                           │
│    ▼                                                              │
│  TerminalClient — file RPC over the shared filesystem             │
│    /cmd.json  { id, cmd, opts }                                   │
│    /result-<id>.json  { id, ok, exitCode, stdout, stderr, runtime }│
└───────────────┬───────────────────────────────────────────────────┘
                │  WebContainer (COOP/COEP, virtualized node:fs)
┌───────────────▼───────────────────────────────────────────────────┐
│  node host.js — TerminalExecutor (persistent daemon, PID 1)       │
│    ├─ node|npm|npx ...  → child_process.spawn  (real Node.js)     │
│    ├─ everything else   → Lifo sandbox.commands.run (Unix tools)  │
│    ├─ ps / kill         → unified process registry                │
│    └─ spawn             → background long-running processes       │
└───────────────────────────────────────────────────────────────────┘
```

Key design decision: **the filesystem is the single source of truth.** Because WebContainer exposes the container filesystem to processes via `node:fs`, and Lifo mounts `process.cwd()` through `NativeFsProvider`, browser, Node processes and Lifo all see one filesystem. There is no filesystem bridge to maintain.

## Quick Start

Requirements: a modern Chromium-based browser (Chrome/Edge) with cross-origin isolation (COOP/COEP headers) and `SharedArrayBuffer` support. No server-side infrastructure needed for local development.

```bash
npm install          # install dependencies
npm run dev          # start Vite dev server (COOP/COEP headers preconfigured)
# open http://localhost:7892
```

The page boots WebUnix: system self-checks, then a shell prompt. Type `help` for available commands.

### Build & checks

```bash
npx tsc -p tsconfig.json --noEmit   # type check (0 errors required)
node scripts/build-host.mjs         # bundle the in-container host (host.js)
npm run build                       # production build
node scripts/verify-deploy.mjs      # deploy-readiness gate (build + preview + COOP/COEP + ?test=1)
```

### Testing

WebUnix has a layered test setup that runs locally and in CI (GitHub Actions). No new runtime dependencies were added for testing — e2e reuses the existing CDP scripts (`verify-deploy` / `bench` / `scenarios`), and unit tests use mock filesystem / IndexedDB / network.

- **Lint** — `npm run lint` (ESLint flat config in `eslint.config.js`). `typescript-eslint` recommended + project rules: `no-explicit-any` (error), no leftover `console.log` (warn; `console.warn`/`error` allowed for the degradation-log convention, host-side files exempt), no unused vars/imports. Gate: **0 errors**.
- **Typecheck** — `npm run typecheck` (`tsc -p tsconfig.json --noEmit`). Gate: **0 errors**.
- **Unit tests** — `npm run test` (Vitest, node environment) covers the pure-logic modules `src/log.ts`, `src/persist.ts`, `src/services.ts`, `src/pkg.ts`, `src/motd.ts`, `src/config.ts` against in-memory mocks (see `tests/`). `npm run test:coverage` adds the v8 coverage gate: **≥70%** statements/branches/functions/lines on those core files.
- **e2e** — `npm run test:e2e` builds once, then runs the three CDP scripts sequentially against `vite preview` in headless Chrome:
  1. `scripts/verify-deploy.mjs` — deploy-readiness gate + `?test=1` self-test (gate **≥57 passed, 0 failed**);
  2. `scripts/bench.mjs` — performance benchmark (JSON output);
  3. `scripts/scenarios.mjs` — the 10 real-workflow scenario suite.
  Playwright is intentionally not used: the CDP scripts keep the pipeline zero-dependency and identical to local runs.
- **CI** — `.github/workflows/ci.yml` runs lint → typecheck → unit tests (with coverage) → build → `verify-deploy` (headless self-test) on every push/PR; a scheduled nightly job runs the heavy scenario suite. See the CI badge at the top of this file.
- **pre-commit (optional, zero-dependency)** — `npm run setup:hooks` writes a `.git/hooks/pre-commit` that runs `tsc --noEmit` and ESLint on the changed files only (`scripts/pre-commit.sh`). It is **not forced**: skipping `setup:hooks` leaves the project fully commit-ready.

### Dependencies & audit

Dependency policy: **report-only, no automatic upgrades** (upgrades are evaluated separately to avoid regressions). Audit results as of the TASK17 final round (2026-08-05):

- `npm audit` → **0 vulnerabilities** (all direct + transitive dependencies clean).
- `npm outdated` → only **`@lifo-sh/core` 0.10.8 → 0.10.9** has a newer release; everything else is current. Not upgraded (policy), pending separate evaluation.
- `public/host.js` is esbuild-minified (`minify: true` in `scripts/build-host.mjs`); size was reduced from 1,965,361 B to 1,070,913 B (**-45.5%**). The `keepNames: true` variant measures 1,106,353 B (**-43.7%**); plain `minify` is used because the full `?test=1` suite passes against the minified bundle (Lifo has no `Function.name` dependency that breaks under name-minification).

### Self-test mode

```bash
# open http://localhost:7892/?test=1
```

Runs the full diagnostics suite (filesystem, routing, process lifecycle, ports, config, services, logs, packages, smoke) inside the centered boot-splash overlay, then prints the summary into the terminal and drops you into the shell.

### Deployment (Vercel)

WebUnix is a **pure static site** (Vite → `dist/`): no backend and no server-side state — workspaces, files, config and settings live in the browser's IndexedDB and ride the snapshot (the tinbase database store is excluded; see Persistence). It deploys to any static host that can send custom response headers; the one-click path is Vercel.

**Why COOP/COEP matters.** WebContainer requires cross-origin isolation. Without the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` headers the page fails the boot environment check and shows the error page instead of the terminal. `vercel.json` ships these headers for **every** path (including `assets/*` and `host.js`), matching the dev and preview servers. Skipping them is the #1 cause of a "white screen + environment error page" on deployment.

**One-click deploy (Vercel):**

1. Push this repository to GitHub / GitLab / Bitbucket.
2. In the Vercel dashboard, **Import Project** → pick the repo. Vercel auto-detects Vite (`framework: vite`, `buildCommand: npm run build`, `outputDirectory: dist` from `vercel.json`).
3. Deploy. Optionally add a custom domain, e.g. `webunix.alibicore.com` or a `cjack.me` subdomain.

CLI equivalent (requires a Vercel account/token):

```bash
npm i -g vercel
vercel login
vercel --prod
```

**Local deploy-readiness verification** (no Vercel token needed). `vite preview` serves the built `dist/` the same way Vercel does, so this is the "static artifact is deployable" proof:

```bash
npm run build
node scripts/verify-deploy.mjs
# starts vite preview, asserts COOP/COEP on /, /host.js and the JS bundle,
# then runs ?test=1 in headless Chrome — PASSED requires >=57 passed and 0 failed
```

**Data scoping.** IndexedDB is isolated **per origin**. Changing the deployment domain = starting a fresh system: workspaces, files and database data do **not** migrate between domains. Refresh on the same domain is safe (the snapshot restores); only a domain change resets the system. This also applies to Vercel preview deployments: each preview gets its own unique URL (a distinct origin), so every preview environment has its own separately-scoped IndexedDB — data does not carry over between preview deployments either.

## Usage

### Built-in commands (handled in the browser)

| Command        | Description                                              |
| -------------- | -------------------------------------------------------- |
| `help`         | Show command help                                        |
| `clear`        | Clear the screen (`Ctrl+L` also works)                   |
| `sysinfo`      | Show browser-detected system information                 |
| `ports`        | List ready service ports with preview URLs               |
| `db start`     | Start the tinbase database (auto-installs if missing)    |
| `db status`    | Show database status (port registry + process table)     |
| `db stop`      | Stop the database                                       |
| `version`      | Show version                                            |
| `whoami`       | Show current user (`guest`)                              |
| `snapshot`     | Persistence status; `snapshot now` saves, `snapshot clear --yes` resets |
| `free`         | Show memory overview (device + JS heap; sandbox estimates marked `~`)    |
| `top`          | Live process table — 3 snapshots 2s apart, then exits                    |
| `reboot`       | Restart WebUnix (browser reload; persisted data survives)                |
| `shutdown`     | Power off (you can close this tab)                                       |
| `cache`        | Show cache usage; `cache clear` cleans rebuildable caches                |
| `workspace`    | List workspaces; `create` / `switch` / `rm` manage isolated workspaces  |
| `env`          | List / set (`env KEY=value`) / unset (`env -u KEY`) environment variables, persisted in `/etc/webunix.env` |
| `settings`     | View / set / reset (`settings reset KEY`) system settings, persisted in `/etc/webunix.settings` |
| `service`      | List services (state + port); `start` / `stop` / `status` / `enable` / `disable <name>` manage them. Definitions in `/etc/webunix.services`, boot autostart in `/etc/webunix.autostart` (declarative restart, not a daemon) |
| `log`          | Show recent system-log entries (last 20) from `/var/log/webunix.log`; `log -n <count>` last N, `log boot` BOOT-only, `log clear` empties the file |
| `pkg`          | Package management: `pkg list` (lifo + npm merged with `SOURCE`), `pkg search <term>` (both channels), `pkg install <name>` (lifo if `lifo-pkg-<name>` exists, else npm), `pkg remove <name>` (via the installed source), `pkg info <name>` |
| `netstat`      | List virtual listening ports (port registry as `tcp 127.0.0.1:<port> LISTEN`); `netstat -p` adds the associated process (matched by port number in the process command, `-` when unmatched) |
| `ip addr`      | Show virtual network identity — `lo: virtual loopback`, `eth0: <preview-domain> (virtual)`; no fabricated interfaces or IPs |
| `uname`        | Show system identity: summary line (`WebUnix <version> js-runtime+webcontainer <api-version> <arch>`); `uname -a` all fields, `-r` runtime version, `-m` architecture (from UA, `unknown` if absent) |
| `motd`         | View the login banner (`/etc/webunix.motd`); `motd <text>` sets it (persisted), `motd reset` restores the default |

### Host commands (TerminalExecutor, unified routing)

| Command                 | Route   | Description                                   |
| ----------------------- | ------- | --------------------------------------------- |
| `node ...` / `npm ...` / `npx ...` | Node | Real Node.js child process               |
| `grep`, `cat`, `tar`, `curl`, ...   | Lifo | Unix tools, pipes, redirects            |
| `ps`                    | —       | List the unified process table                |
| `kill <pid>`            | —       | Terminate a process (SIGTERM)                 |
| `cwd` / `ping` / `exit` | —       | Protocol commands                              |

## Verified Behavior

Result of the browser runtime verification suite (see `src/tests.ts`): **57 passed, 0 failed, 5 skipped** (TASK19 final run, 2026-08-05, against the minified host bundle). The 5 skips are known boundaries (external network, symlink fallback, device-memory stats), never silent failures. In `?test=1` mode the summary line and any failure list are additionally printed to the terminal after the boot overlay fades (self-test results stay visible).

- Shared filesystem: browser -> Lifo and Lifo -> browser reads/writes work.
- Routing: `node -e "console.log(21*2)"` -> `42` (`runtime=node`); `npm --version` -> real npm version; `grep`/`cat`/`wc` -> `runtime=lifo`.
- Process lifecycle: `spawn` a background service, `ps` shows it, `kill` transitions it to `exited`.
- Port registry: `server-ready` events surface preview URLs.
- Database: tinbase (PGlite/WASM) boots and serves.
- Memory: device memory / JS heap stats reported by the browser (`free` can render).
- Config: `env` set/get/delete lifecycle and `settings` write/reset persist to `/etc/webunix.*`.
- Services: `service` lists the built-in tinbase definition; a temporary echo server can be started, observed `running` (process table + port registry), stopped, and removed with zero residue; `service enable`/`disable` write and remove the `/etc/webunix.autostart` file (deduped).
- Logs: command executions are recorded with `exit`/`runtime`, boot events are recorded as `BOOT` entries, and `log clear` empties the log file (asserted by the self-test suite).
- Packages: `pkg list` renders the two-channel table (NAME / SOURCE / VERSION); `pkg search git` hits `lifo-pkg-git` (network-dependent — skipped on failure, per the known-boundary convention).
- Network view: `netstat` renders the port registry as a virtual listening-port table and `netstat -p` associates a spawned echo server (port 3456) with its process; after `kill` the port disappears from the table. `ip addr` prints the virtual loopback and preview domain, honestly labeled `(virtual)`.
- System info: `uname` renders the honest system line (`WebUnix <version> js-runtime+webcontainer <api-version> <arch>`) and the `-a`/`-r`/`-m` forms; the `-r`/`-m` flag parsing is additionally asserted through the command-dispatch path (not just the builders). `motd` set → read-back → reset leaves `/etc/webunix.motd` at its default (zero residue).
- Smoke: all 23 safe built-in commands (help/clear/sysinfo/version/whoami/ports/db status/db stop/snapshot/free/top/cache/workspace/env/settings/service/log/pkg/netstat/ip addr/uname -a/motd/shutdown) dispatch through the browser handler without error; `reboot` and `db start` are excluded from the automated smoke (destructive/heavy side effects).
- Stability: the RPC client serializes requests over the single-slot `/cmd.json` channel (no more parallel-channel race), retries read-only commands (ping/ps/cwd) once on transport failure, and the browser watchdog re-injects + respawns `host.js` after 2 consecutive failed pings.

## Known Boundaries

These are environmental constraints, not bugs:

- **CORS**: `curl` to sites without CORS headers fails (`exit 7`). Use a CORS-friendly proxy, e.g. `curl https://r.jina.ai/<url>`.
- **Symlinks**: not supported by the Lifo VFS (`ln` reports the limitation).
- **No package manager / native binaries**: there is no `apt`; native executables cannot run. This layer is reserved for a future v86-backed fallback.
- **stdin for interactive processes**: unreliable in the WebContainer environment; the design uses file-based RPC instead.
- **Streaming cross-runtime pipes**: cross-runtime pipes are buffered (fine for agent-style "run then read" workflows).
- **Watchdog probe can be swallowed by a queued command**: the host liveness watchdog writes a direct `ping` probe to the single-slot `/cmd.json` channel; if a user command is enqueued in the same ~120 ms host-poll window it overwrites the probe, so that probe times out and the watchdog skips the round (neutral, not counted as a failure). This only delays liveness detection by one 30 s cycle in the rare overlap case; it does not kill a healthy host.
- **Single-command output is capped at 1 MB**: to bound container memory and result-file size, each command's `stdout`/`stderr` keeps at most the last ~1 MB of output (large dumps are truncated to their tail). Normal use (`seq 1 5000`, `cat` mid-size files, `npm install` logs) is far below the cap.
- **Declarative autostart (not a daemon)**: `service enable` only records the service for a boot-time restart. There is no crash detection or self-healing — if a service exits after boot, restart it manually (`service start <name>`).
- **`log -f` (tail -f) not implemented**: interactive streaming output is deferred (POC; interactive stdin is unreliable in WebContainer). Use `log` / `log -n <count>` instead. `log clear` wipes `/var/log/webunix.log` and is therefore not itself recorded in the log.
- **External inbound networking**: services are reachable via virtual preview URLs, not from the public internet.
- **Services claim processes by command string**: `service stop` (and `db stop`) locate a service by matching its rendered command against the process table, not by PID lineage. A manually started process running the same command may be matched and killed. `service start` likewise reports "already running" if a process with that command is found.
- **Built-in tinbase service needs one install step**: the preset `service` definition (`tinbase`) runs `npx tinbase start --port ${PORT} --engine wasm`, which requires tinbase to be installed in the container. Run `db start` once first to complete the in-container install before using `service start tinbase`.
- **lifo packages are session-scoped; npm packages persist**: `lifo install` places packages in the Lifo runtime's in-memory global module directory, so they exist for the current host session and are recreated when the host restarts (a full refresh boots a fresh Lifo kernel). npm packages install into `/node_modules` on the shared filesystem and persist with the workspace snapshot. `pkg list` merges both; the source rule is "lifo if `lifo-pkg-<name>` exists on npm, otherwise npm; lifo wins on a name conflict".
- **`pkg` installs need registry access**: `pkg install`/`search`/`info` hit the npm registry (via `lifo search` / real npm). When the registry is unreachable the command reports the reason and does not pretend to succeed.
- **Single-user, no permission bits**: WebUnix is a single-user browser sandbox (`guest` is the only user); there is no multi-user login / isolation, and permission-bit management (`chmod` semantics) is not simulated — simulated modes would add no real value.
- **Chromium-only**: WebContainers requires a Chromium-based browser (Chrome/Edge). Firefox, Safari, and mobile browsers are not supported; the environment-check error page explains the requirements instead of degrading.
- **Deployment hosts must send custom response headers**: WebContainer's cross-origin isolation requires the COOP/COEP headers configured in `vercel.json`. Hosts that cannot set custom response headers (e.g. some object-storage/CDN static hosting) cannot run WebUnix. Vercel's free plan supports custom headers via `vercel.json`.

## Project Structure

```
src/
  main.ts            # entry: xterm terminal, REPL, boot orchestration
  boot.ts            # boot sequence, system info detection, env pre-check
  boot-ui.ts         # centered DOM boot overlay renderer (splash/logs/env-fail page)
  commands.ts        # browser-side commands (help/ports/db/free/top/cache/workspace/env/settings/service/log/pkg/netstat/ip/...)
  config.ts          # system configuration: /etc/webunix.env + /etc/webunix.settings I/O & defaults
  motd.ts            # login banner: /etc/webunix.motd I/O & default
  services.ts        # service management: /etc/webunix.services + /etc/webunix.autostart I/O, status/start/stop
  log.ts             # journald-style system log: /var/log/webunix.log append/read/clear/BOOT-filter
  pkg.ts             # package management: pkg list/search/install/remove/info over lifo + npm channels
  terminal-client.ts # file-RPC client (single terminal() entry)
  tests.ts           # self-test suite (?test=1)
  host.ts            # TerminalExecutor daemon (runs inside WebContainer)
  host-procs.ts      # unified process registry
scripts/
  build-host.mjs     # esbuild bundle of the in-container host (host.js + lazy lifo-core.js)
  verify-deploy.mjs  # deploy-readiness gate: build + preview + COOP/COEP + ?test=1 self-test
  bench.mjs          # headless-Chrome performance benchmark (JSON output)
  scenarios.mjs      # 10 real-workflow scenario suite (headless Chrome + CDP)
  run-e2e.mjs        # npm run test:e2e: build once + run verify-deploy/bench/scenarios sequentially
  pre-commit.sh      # optional pre-commit: tsc + eslint on changed files (zero-dependency)
  setup-hooks.mjs    # npm run setup:hooks: wire .git/hooks/pre-commit to pre-commit.sh
tests/
  log.test.ts        # Vitest unit tests for src/log.ts (mock FS)
  persist.test.ts    # ... src/persist.ts (exclusion/signature/force/empty-dirs, mock FS + fake IDB)
  services.test.ts   # ... src/services.ts (parse/port-render/state, mock client)
  pkg.test.ts        # ... src/pkg.ts (source detection/command construction, mock network)
  motd.test.ts       # ... src/motd.ts
  config.test.ts     # ... src/config.ts
  helpers/fakes.ts   # in-memory FileSystemAPI / fake IndexedDB / scriptable terminal client
eslint.config.js     # ESLint flat config (typescript-eslint recommended + project rules)
vitest.config.ts     # Vitest config + v8 coverage gate (>=70% on core pure-logic modules)
.github/workflows/
  ci.yml             # CI: lint → typecheck → unit tests (coverage) → build → verify-deploy; nightly scenarios
public/
  host.js            # lightweight in-container host daemon (generated)
  lifo-core.js       # @lifo-sh/core kernel bundle, lazily imported by host.js (generated)
```

## Development Archive

`TASK2.md`–`TASK17.md` document this project's incremental development history (each task's requirements, retention rules, and quality gates). They are kept in the repository as a **historical development archive** and are not part of the shipped product.

## Roadmap

- [x] POC: Lifo inside WebContainer with shared filesystem
- [x] TerminalExecutor v1: unified routing + process table
- [x] Product shell: full-screen terminal, boot sequence, ports, tinbase
- [x] Production-grade interface: English UI, dark-amber theme, JetBrains Mono, system self-checks
- [x] Boot splash: centered DOM overlay, responsive layout, graceful environment-exit
- [x] Persistence layer: files/state persisted to IndexedDB, restored on boot (no data loss on refresh)
- [x] Memory management: `free`/`top`-style commands, cache cleanup, reboot to reclaim memory
- [x] Workspace split: multiple virtual directories with isolated state (like Sunam workspaces)
- [x] Virtual network view: `netstat` virtual listening-port table + `ip addr` honest virtual identity
- [ ] SunamAI integration: replace `shell_run` engine with TerminalExecutor — **deferred** (planned as TASK8; not scheduled)
- [ ] Optional: WebSocket tunnel for external access, v86 fallback layer

## License

MIT © 2026 [CJackHwang](https://github.com/CJackHwang). See [LICENSE](LICENSE).

## Acknowledgements

- [Lifo](https://github.com/lifo-sh) — the TypeScript Unix userland (MIT).
- [WebContainers](https://webcontainers.io) by StackBlitz — Node.js runtime in the browser.
- [xterm.js](https://xtermjs.org/) — terminal emulation (MIT).
- [tinbase](https://github.com/tinbase/tinbase) — browser Postgres (PGlite/WASM).
- [Vite](https://vitejs.dev/) — build tooling (MIT).
