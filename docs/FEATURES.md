# SuccinixOS — Supported Features & Capabilities

> **Authoritative inventory of what SuccinixOS supports today.** Every capability below is
> implemented and verified — nothing here is aspirational or speculative. The **Source** column
> cites the implementing TASK (see the CHANGELOG for details) or the authoritative document that
> records it. 中文版：[FEATURES.zh-CN.md](FEATURES.zh-CN.md).

## 1. System overview

SuccinixOS is a **browser-native Linux**: a full-screen Unix terminal in a browser tab, driven by
WebContainer + Lifo, with a **real Node.js runtime** (`node|npm|npx`) and a **Lifo Unix userland**
(everything else) sharing **one filesystem**. No installation, no backend — a Chromium browser tab
boots into the environment and offers Unix tools, Node.js, process management, port forwarding, a
Postgres database (tinbase), and persistence.

| Item | Value | Source |
| ---- | ----- | ------ |
| Product | SuccinixOS (formerly WebUnix) — unified brand, zero functional change | TASK26 |
| Engine | dsh Cordis plugin: `ctx.fs`, `ctx.sandbox`, `ctx.terminals`, `ctx.sessionPersistence` (unified routing: `node|npm|npx` → real Node child; everything else → Lifo sandbox) | TASK1, C2 |
| Runtime | WebContainer + Lifo, shared virtualized `node:fs` (browser `wc.fs`, Node children, Lifo — one tree) | TASK1, README |
| Succinix app version | **0.6.0** | CHANGELOG |
| Engine package | **`@succinix/engine` 0.6.0** — dsh Cordis plugin (`@deepseek-ai/cordis@4.0.1`) | CHANGELOG, cordis-contract.md |
| License | **MIT** © 2026 CJackHwang | README |
| Browser | Chromium family only (Chrome/Edge) + COOP/COEP cross-origin isolation + SharedArrayBuffer | TASK4, README |

## 2. Built-in command families

Browser-side commands (handled in the browser, routed to the host where needed). Each family's
state persists in its `/etc/succinix.*` state file, all of which ride the workspace snapshot.

| Command | What it does | Source |
| ------- | ------------ | ------ |
| `help` / `clear` | Command help / clear screen (`Ctrl+L`) | TASK1, TASK3 |
| `sysinfo` | Browser-detected system information | TASK3 |
| `version` / `whoami` | Version / current user (`guest`; the user id in `?user=` mode) | TASK3, U1 |
| `ports` | List ready service ports and preview URLs (from `server-ready` registry) | TASK2 |
| `db start` / `db status` / `db stop` | tinbase (PGlite/WASM) lifecycle; auto-installs on first start | TASK2 |
| `snapshot` | Persistence status / manual save (`snapshot now`) / reset (`snapshot clear --yes`) | TASK5 |
| `free` / `top` | Memory overview (device + JS heap; honest `~` sandbox estimates) / process table snapshots | TASK6 |
| `reboot` / `shutdown` | Browser reload (persisted data survives) / power off | TASK6 |
| `cache` / `cache clear` | Report / clear only rebuildable caches (never `/workspace`) | TASK6 |
| `workspace` | Isolated workspaces (`create`/`switch`/`rm`); current recorded in `/ws/.current` | TASK7 |
| `env` | Persistent environment variables (`/etc/succinix.env`, merged into real Node children at spawn) | TASK10 |
| `settings` | Persistent system settings (`/etc/succinix.settings`: tinbase `preview-port` 3001, `default-workspace`, live `font-size`) | TASK10 |
| `service` | Declarative background services (`list`/`start`/`stop`/`status`/`enable`/`disable`; `/etc/succinix.services` + boot autostart `/etc/succinix.autostart`) | TASK11 |
| `log` | journald-style system log (`/var/log/succinix.log`; `log`, `log -n <count>`, `log boot`, `log clear`) | TASK12 |
| `pkg` | Unified package manager (`list`/`search`/`install`/`remove`/`info`) across lifo + npm channels | TASK13 |
| `netstat` | Virtual listening-port table from the port registry (`netstat -p` attaches the process) | TASK14 |
| `ip addr` | Honest virtual network identity (`lo: virtual loopback`, `eth0: <preview-domain> (virtual)`) | TASK14 |
| `uname` | Honest system identity (`Succinix <v> js-runtime+webcontainer <api-version> <arch>`; `-a`/`-r`/`-m`) | TASK15 |
| `motd` | View / set / reset the persistent login banner (`/etc/succinix.motd`) | TASK15 |
| `lang` | List built-in language runtimes and versions | TASK23 |

Persistent state files (all ride the snapshot, survive refresh): `/etc/succinix.env` (TASK10),
`/etc/succinix.settings` (TASK10), `/etc/succinix.services` (TASK11), `/etc/succinix.autostart`
(TASK11), `/etc/succinix.motd` (TASK15), `/etc/succinix.cwd` (TASK23), `/etc/succinix.engine.json`
(result TTL override, TASK21/TASK26), `/ws/.current` (TASK7), `/var/log/succinix.log` (TASK12).

## 3. Language runtimes

Measured in a real browser/container — the authoritative, measurement-backed matrix is
[docs/LANGUAGES.md](LANGUAGES.md) (中文: [docs/LANGUAGES.zh-CN.md](LANGUAGES.zh-CN.md)). Status
legend: `[OK]` measured working · `[x]` confirmed absent · text = partial/probe.

| Language | Command | Runtime | Version (measured) | Package install | Status | Source |
| -------- | ------- | ------- | ------------------ | --------------- | ------ | ------ |
| **Python** | `python`, `python3` | resident **Pyodide 314.0.4** daemon (node child, instance reused) | 3.14.2 | `[OK]` **pip** via micropip — pure-Python wheels persist across refresh; compiled wheels re-install after refresh | `[OK]` | TASK23, TASK27, `LV·P1–P9`, `S11` |
| **pip** | `pip`, `pip3` | maps to Pyodide micropip (`python -m pip` too) | micropip 0.11.1 | `[OK]` install / uninstall / list / show | `[OK]` | TASK27, `LV·P6` |
| **Node.js** | `node` | real Node.js (WebContainer runtime) | 22.22.3 | `[OK]` npm, local per-project installs | `[OK]` | TASK1, TASK24, `LV·N1–N5` |
| **npm** | `npm` | real npm (ships with node) | 10.8.2 | `[OK]` local; `[x]` global (`/usr/local` read-only → EACCES + hint) | `[OK]` | TASK24, `LV·N4` |
| **TypeScript** | `npx tsc`, `tsx`, `vitest` | npm-installed toolchain; node 22 `--experimental-strip-types` | latest via npm | `[OK]` via npm | `[OK]` | TASK25, `LV·N3`, `S13`, `S14` |
| **Ruby** | (none built-in) | `@ruby/wasm-wasi` v2 + `@ruby/head-wasm-wasi` (probe only) | head ruby.wasm | `[OK]` npm install; `[x]` **no gem** | probe — runs, not integrated | TASK25, `LV·R1` |
| **C** | `gcc` | none | — | — | `[x]` confirmed absent | TASK25, `LV·R2` |
| **Rust** | `rustc`, `cargo` | none | — | — | `[x]` confirmed absent | TASK25, `LV·R2` |
| **Go** | `go` | none | — | — | `[x]` confirmed absent | TASK25, `LV·R2` |
| **WASI** | `node:wasi` | Node.js WASI (preview1) | node 22 | — | `[OK]` runs precompiled WASI modules | TASK25, `LV·R3` |

Key measured facts:

- **Node.js is a real binary**, not an emulation: `node -e "console.log(21*2)"` → `42`
  (`runtime=node`); `npm --version` reports the real npm version. **Shell fusion (TASK24):** a
  node-family command containing shell metacharacters (`&&`, `|`, `>`, `2>&1`, …) runs the whole
  chain through the Lifo shell, and each `node`/`npm`/`npx` segment is forwarded back to the **real
  binary** — `node -e "console.log(21*2)" | grep 42` → `42` (`runtime=lifo`). Tokenizer preserves
  escaped quotes; unterminated quotes report `unterminated quote in command`.
- **Python** runs on a resident Pyodide daemon: 11/11 stdlib imports green
  (json/csv/re/math/os/sqlite3/subprocess/collections/datetime/hashlib/urllib), sqlite3 + json
  verified live, `python -c` / `python <script.py>` / `python -m <module>` semantics preserved,
  **pip via micropip** (install/uninstall/list/show/--version). Boundaries: no interactive REPL
  (use `python -c`), `subprocess` imports but cannot spawn (`OSError: [Errno 138] ...`),
  compiled wheels (e.g. numpy) need one `pip install` after a refresh.
- **TypeScript ecosystem** closed loop: `npm i -D typescript tsx vitest` → `npx tsc` →
  `node dist/*.js` → `npx vitest run` (1 passed) — measured in scenarios S13/S14.
- **Ruby** is probe-only: the v2 `@ruby/wasm-wasi` API runs Ruby WASM in-container (`6*7` → 42)
  but is not a routed/built-in runtime and has no gem installer. **C/Rust/Go** compilers are
  confirmed absent; precompiled **WASI** modules do run via `node:wasi`.

## 4. Persistence

- **Workspace snapshot → IndexedDB.** The container filesystem (files, `/etc` state, workspace) is
  snapshotted to the IndexedDB database `succinix-persist` (auto-save ~every 2.5 s + `pagehide`
  fallback) and restored on boot. Refreshes never lose user files. `snapshot` shows status / saves
  manually / resets. | TASK5, TASK26, README
- **Text-first snapshot, honest boundaries.** Binary/unreadable files are skipped (counted in the
  save log); snapshots over ~50 MB are skipped with a warning (`skipped (over 50MB limit)`) rather
  than written. Empty directories are recorded and recreated. | TASK16, TASK19
- **Exclusions.** The `.tinbase` tree (binary PGlite store) is excluded — tinbase data persists
  across `db stop`/`db start` in-session but not across a browser refresh (documented). The
  `/usr/lib/succinix` runtime assets (~13 MB Python) are excluded and re-injected on first use.
  The log file is excluded from the change-detection signature (still rides snapshots). | TASK19,
  TASK23, TASK18
- **pip persistence (best-effort, honest).** The Pyodide site-packages directory is NODEFS-mounted
  to `/.pyodide/site-packages` (inside the snapshot); `/.pyodide/installed.json` records pip
  installs. **Pure-Python wheels (e.g. `pyparsing`) persist across a refresh**; **compiled wheels
  (e.g. `numpy`) need one `pip install <pkg>` after a refresh** (their `.so` files are binary and
  the snapshot is text-only). | TASK27
- **Per-origin data scoping.** IndexedDB is isolated per origin — changing the deployment domain
  starts a fresh system; same-origin refresh restores the snapshot. | TASK22

## 5. Processes & services

- **Unified process table** with `ps` / `kill`: every real child process is registered with
  `{ pid, cmd, status, startTime, exitCode?, outputTail? }`; table caps at 100 entries; `kill`
  SIGTERMs a table entry. Lifo-side processes are list-only (kill reports not-in-table). | TASK1,
  PROTOCOL.md
- **Background `spawn`** for long-running node-family processes (no Lifo background concept),
  with a **2 s startup-confirmation window**: a spawned process that exits non-zero within 2 s is
  reported as a failure (`ok:false`). | TASK1, TASK2, TASK19
- **Service management**: `service` defines named declarative services
  (`/etc/succinix.services`, `name|command|port`, `${PORT}` from `preview-port`), manages
  `start`/`stop`/`status`/`enable`/`disable`, and `enable` writes `/etc/succinix.autostart` for
  declarative restart at boot (not a daemon — no crash self-healing). | TASK11
- **Port registry**: WebContainer `server-ready` events register a preview URL; `ports` lists them,
  `netstat` renders a virtual `Proto  Local Address  State` table (`netstat -p` matches the owning
  process). | TASK2, TASK14

## 6. Networking

- **Outbound HTTP** is subject to CORS: direct `curl` to CORS-less sites fails (`exit 7`); use a
  CORS-friendly proxy such as `curl https://r.jina.ai/<url>`. Python `urllib` shares the same
  boundary. | README, AGENTS.md, LANGUAGES.md
- **Ports are virtual previews.** Services are reachable via the virtual preview URL only; there is
  no physical inbound network path — an honest, accepted boundary. | TASK14, README
- **Virtual network identity**: `ip addr` reports `lo: virtual loopback` and
  `eth0: <preview-domain> (virtual)`; nothing is fabricated (no fake interfaces, IPs, or
  connections). | TASK14

## 7. Session

- **Session cwd sync** (the "fusion cornerstone"): a successful Lifo `cd` under `/workspace` syncs
  the host-maintained session cwd (persisted to `/etc/succinix.cwd`, restored on host start); every
  real Node/Python child spawns with `cwd = session cwd`. `pwd` shows the session cwd; a failed
  `cd` keeps it unchanged. Explicit `setCwd <dir>` protocol command exists. | TASK23, PROTOCOL.md
- **`/workspace` path mapping**: Lifo's `/workspace` is the VFS view of the browser-FS root; real
  node/python children are spawned in the mapped real path (spawn failures after `cd /workspace`
  were fixed in TASK24). | TASK23, TASK24
- **Persistent environment merging**: `env KEY=value` writes `/etc/succinix.env`, merged into real
  Node child processes at spawn time (`process.env`); the double-root bug where env never reached
  children was fixed and is self-tested. | TASK10, TASK24
- **Shell fusion**: node/python commands containing shell metacharacters run through the Lifo
  shell, each segment forwarded to the real runtime — real pipes, chains, redirects. | TASK24

## 8. Deployment

- **Static site, no backend**: Vite build → `dist/`; all state lives in the browser's IndexedDB.
  Any static host that can send custom response headers can serve it; the one-click path is Vercel.
  | TASK22, README
- **COOP/COEP headers**: `vercel.json` serves `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: credentialless` on **every** path (including `assets/*` and
  `host.js`) — required for WebContainer cross-origin isolation. | TASK22
- **Deploy-readiness gate**: `scripts/verify-deploy.mjs` builds → `vite preview` → asserts
  COOP/COEP on `/`, `/host.js` and the JS bundle → runs `?test=1` in headless Chrome
  (gate `>=71` passed, 0 failed). | TASK22
- **Per-origin data**: changing the deployment domain starts a new system (IndexedDB is origin-
  scoped); Vercel preview deployments are each their own isolated data scope. | TASK22

## 9. Ecosystem / SDK

- **Decoupled engine, dsh single-track**: the command-execution core lives in
  `src/engine/` and stays Cordis-free; `src/plugin/` is the thin Cordis layer.
  `@succinix/engine@0.6.0` is the only public form: a plugin registered as
  `succinix`, consumed through `ctx.fs` / `ctx.sandbox` / `ctx.terminals` /
  `ctx.sessionPersistence`. | C1–C6, AGENTS.md
- **Authoritative protocol**: `docs/PROTOCOL.md` is the file-RPC wire contract (version 1) —
  request/response shapes, command routing, process model, port events, timeouts; an ecosystem
  consumer can build an alternative client/host from it alone. | TASK21, PROTOCOL.md
- **Published package exports**: `.` (plugin entry `{ name, apply, Config }` + types),
  `./host.js` + `./lifo-core.js` (in-container assets), `./assets/*` (Pyodide + SHA manifest),
  `./package.json`. The 0.4.0 `./terminal` / `./instance` subpaths are removed. | C1, C6
- **dsh service surface**: `ctx.fs` (12 primitives, 13 `FS_*` codes),
  `ctx.sandbox` (sync `confine`, node fail-closed), `ctx.terminals`
  (owner-scoped PTY registry), and `ctx.sessionPersistence` (event-sourced
  JSONL). Internal lifecycle facades (`executor`, `terminal`, `snapshot`,
  `persist`, `workspace`, `ports`, `services`, `capabilities`, `instance`,
  `boot` / `attach` / `ensureInstance`) live behind the `succinix-host` seam.
  | C2, cordis-contract.md
- **Typed events**: `succinix/state` (with `reason` / `changed`), `server-ready`,
  `server-closed`, `command` telemetry, `instance`, `workspace`, `process`. | C4,
  manageability.md
- **Capability registry**: `terminal.exec`, `terminal.spawn`, `terminal.kill`,
  `terminal.interrupt`, `fs.read`, `fs.write`, `workspace.restore`, `workspace.flush`,
  `workspace.list`; default-allow with configurable rules. | C2
- **Lifecycle semantics**: page-level HostManager singleton; fiber reload does not restart the
  host; `dispose()` is soft, `shutdown()` is hard; `attach`/`boot` mode mismatch throws
  `ERR_MODE_MISMATCH`; asset SHA-256 integrity is enforced by default. | C2, C5
- **Multi-instance (0.6.0+)** — `host.ensureInstance(id, opts)` creates or
  reuses a per-instance stack on the shared page host. `?instance=<id>` starts
  the app as a named instance: state files (`/workspace/.succinix-<id>`),
  IndexedDB snapshot keys, env, services/ports views and process views are
  per-instance; cross-instance `kill` is rejected. Two tabs with different ids
  are fully isolated (separate hosts — e2e verified). | M1–M5, PROTOCOL.md
- **Multi-user (0.6.0+)** — `?user=<id>` (alias of `?instance=<id>`) seeds a per-user home
  (`/workspace/users/<id>`): session starts in the home (prompt `~`, node/python spawns there),
  `whoami`/prompt show the user, and state/snapshots/process views are per-user with `ps`
  filtering + `kill` authorization (organizational only — not a security boundary). | U1, SDK.md
- **External demo / contract snapshot**: `examples/cordis-app/` depends only on
  the packed engine, `@deepseek-ai/cordis`, and `@webcontainer/api`;
  `scripts/cordis-app-e2e.mjs` runs the contract in headless Chrome. | C5,
  cordis-contract.md

## 10. Honest boundaries

Accepted environment constraints — not bugs, and never simulated:

| Boundary | Detail | Source |
| -------- | ------ | ------ |
| No real kernel / `apt` / native binaries | Physically impossible in the sandbox; Succinix is a browser-native Linux | README, AGENTS.md |
| Multi-user is organizational isolation only | Embed mode partitions directories/state/process views per instance/user (`?instance=`/`?user=`); **not a security boundary**; the standalone app stays `guest`-only and `chmod` semantics are not faked | AGENTS.md, SDK.md |
| No inbound network | Ports are virtual previews; tunnels are outbound bridges, not real inbound | TASK14 |
| No interactive REPL stdin | File-based RPC replaces stdin; `log -f` and REPL-style processes unsupported | TASK1, README |
| No symlinks / hard links | Lifo VFS does not support them | README |
| Firefox / Safari / mobile unsupported | WebContainers requires Chromium; the environment-check error page explains | TASK4 |
| C-extension pip packages don't persist across refresh | Text snapshot carries no `.so`; reinstall `numpy` etc. after refresh | TASK27 |
| External `curl` needs a CORS proxy | `https://r.jina.ai/<url>` style | README |
| `npm i -g` → EACCES | `/usr/local` is read-only for `guest`; an actionable hint is appended | TASK24 |
| 1 MB output cap | stdout/stderr keep only the tail past 1 MB (bounds container memory) | TASK18 |
| First `python` command is slow | ~13 MB Pyodide runtime is lazily injected; subsequent commands reuse the daemon | TASK27 |
| Precise OS-level memory/CPU stats unavailable | Estimates only, always marked `~` with an `(estimated ...)` footnote | TASK6, AGENTS.md |

## 11. Self-test & testing

- **`?test=1` self-test** — runs the full diagnostic suite in the browser: **76 passed, 0 failed,
  5 skipped** (the 5 skips are documented known boundaries, not silent failures). | TASK1, TASK3,
  TASK20, TASK25
- **Scenario suite** — `scripts/scenarios.mjs` (headless Chrome + CDP): 14 real workflows S1–S14
  (npm dev loop, git via lifo-pkg-git, tinbase lifecycle, service autostart, workspace isolation,
  queue serialization, big output, persistence stress, error paths, reboot boundary, python
  workflow, cd-synced install, TS ecosystem, language regression). | TASK19, TASK23, TASK25
- **Language verification** — `scripts/lang-verify.mjs`: 28 CDP-driven checks
  (`LV·P1–P9`, `N1–N5`, `R1–R3`) backing the LANGUAGES matrix. | TASK25
- **Bench** — `scripts/bench.mjs`: reproducible headless-Chrome benchmark (boot, command
  round-trip, snapshot, big output) with JSON output for CI. | TASK18
- **CI** — GitHub Actions (`.github/workflows/ci.yml`): `check` job (lint → typecheck → unit tests
  + coverage → build → `verify-deploy` headless self-test) on push/PR, plus a scheduled
  `nightly-scenarios` job. | TASK20
- **Unit tests** — Vitest (node) covering pure-logic modules with an in-memory mock FS / fake
  IndexedDB; v8 coverage gate **>=70%** on core files. | TASK20
- **e2e pipeline** — `npm run test:e2e` builds once, then runs `verify-deploy` → `bench` →
  `scenarios` → `lang-verify` → `instance-demo` → `instance-routing` → `cordis-app`. | TASK20, TASK25

## 12. Quick start & docs index

```bash
npm install
npm run dev          # start the Vite dev server (COOP/COEP preconfigured)
# open http://localhost:7892
```

Type `help` in the shell for the full command list. Documentation family (English · 中文):

- **README** — overview, usage, architecture: [English](../README.md) · [中文](README.zh-CN.md)
- **FEATURES** — this document: [English](FEATURES.md) · [中文](FEATURES.zh-CN.md)
- **LANGUAGES** — measured language support matrix: [English](LANGUAGES.md) · [中文](LANGUAGES.zh-CN.md)
- **PROTOCOL** — file-RPC wire contract (v1): [English](PROTOCOL.md) · [中文](PROTOCOL.zh-CN.md)
- **SDK** — Cordis plugin integration: [English](SDK.md) · [中文](SDK.zh-CN.md)
- **PLUGIN** — third-party Cordis plugin authoring: [English](PLUGIN.md)
- **MIGRATION** — 0.4.0/0.5.0 to 0.6.0 guide: [English](MIGRATION.md)
- **cordis-contract** — contract snapshot and runner: [English](cordis-contract.md)
- **AGENTS** — agent & design guidelines: [English](../AGENTS.md) · [中文](../AGENTS.zh-CN.md)
- **CHANGELOG** — change history: [English](../CHANGELOG.md) · [中文](../CHANGELOG.zh-CN.md)
- **CONTRIBUTING** — how to contribute: [English](../CONTRIBUTING.md) · [中文](../CONTRIBUTING.zh-CN.md)
