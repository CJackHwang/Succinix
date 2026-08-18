# SuccinixOS — Supported Features & Capabilities

> **Implementation inventory, not a release certificate.** The **Source** column identifies
> the implementation or measurement evidence for each entry. Entries with `LV`, `S`, or `ST`
> cite reproducible browser measurements; other entries describe the current source contract and
> still require the release gates named in section 11. 中文版：[FEATURES.zh-CN.md](FEATURES.zh-CN.md).

## 1. System overview

SuccinixOS is a **browser-native Linux**: a full-screen Unix terminal in a browser tab, driven by
WebContainer + Lifo, with a **real Node.js runtime** (`node|npm|npx`) and a **Lifo Unix userland**
(everything else) sharing **one filesystem**. No installation, no backend — a Chromium browser tab
boots into the environment and offers Unix tools, Node.js, process management, port forwarding, a
Postgres database (tinbase), and persistence.

The execution-world rule is normative: WebContainer/Lifo owns userland commands, runtimes,
packages, services, editors, TUIs, and third-party extensions. The browser is only the control/device
plane (boot, xterm, keyboard/resize events, unavoidable Web APIs, and thin transport). v0.7
connects the browser terminal to Lifo's exported `ITerminal` and public
`CommandContext.stdin`/`setRawMode` seam inside WebContainer instead of implementing parallel
browser-side applications. See [PLAN-v0.7.0.md](PLAN-v0.7.0.md).

| Item | Value | Source |
| ---- | ----- | ------ |
| Product | SuccinixOS (formerly WebUnix) — unified brand, zero functional change | TASK26 |
| Engine | dsh Cordis plugin: `ctx.fs`, `ctx.sandbox`, `ctx.terminals`, `ctx.sessionPersistence` (unified routing: `node|npm|npx` → real Node child; everything else → Lifo sandbox) | TASK1, C2 |
| Runtime | WebContainer + Lifo, shared virtualized `node:fs` (browser `wc.fs`, Node children, Lifo — one tree) | TASK1, README |
| Succinix app version | **0.7.0** | `src/plugin/host-service.ts` |
| Engine package | **`@succinix/engine` 0.7.0** — dsh Cordis plugin (`@deepseek-ai/cordis@4.0.1`) | `packages/engine/package.json`, cordis-contract.md |
| License | **MIT** © 2026 CJackHwang | README |
| Browser | Chromium family only (Chrome/Edge) + COOP/COEP cross-origin isolation + SharedArrayBuffer | TASK4, README |

## 2. Built-in command families

The following are **v0.7 browser control commands** (handled in the browser, routed to the host
where needed). Their state persists in `/etc/succinix.*` files that ride the workspace snapshot.
Standard Unix commands and interactive tools run in WebContainer/Lifo userland; browser-only
management stays under the `succinix ...` namespace.

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
| `service` | Declarative background services (`list`/`start`/`stop`/`status`/`enable`/`disable`) backed by Lifo `ServiceManager` and `/etc/systemd/system/*.service`; enablement markers are snapshot-backed | TASK11 |
| `log` | journald-style system log (`/var/log/succinix.log`; `log`, `log -n <count>`, `log boot`, `log clear`) | TASK12 |
| `pkg` | Unified package manager (`list`/`search`/`install`/`remove`/`info`) across lifo + npm channels | TASK13 |
| `netstat` | Virtual listening-port table from the port registry (`netstat -p` attaches the process) | TASK14 |
| `ip addr` | Honest virtual network identity (`lo: virtual loopback`, `eth0: <preview-domain> (virtual)`) | TASK14 |
| `uname` | Honest system identity (`Succinix <v> js-runtime+webcontainer <api-version> <arch>`; `-a`/`-r`/`-m`) | TASK15 |
| `motd` | View / set / reset the persistent login banner (`/etc/succinix.motd`) | TASK15 |
| `lang` | List built-in language runtimes and versions | TASK23 |
| `vi` / `nano` | Lifo-native interactive editors: raw-mode stdin, full-screen redraw, save/quit/search — the same `ITerminal` seam as third-party TUIs | v0.7 |
| `net` | Honest network view: `net doctor` capability report, `net preview` virtual port list, `net tunnel` fail-closed (`unavailable`) | v0.7 |
| `succinix status` / `succinix plugins` | Plugin state / Cordis plugin + fiber states | C4 |
| `succinix capabilities` | `succinix-linux-userland/0.7` profile: every command with status/runtime/execution contract + fail-closed denylist (exit 126) | v0.7 |
| `succinix doctor` | Self-check: host RPC ping, persistence, userland profile, engine state (`[  OK  ]` / `[ FAIL ]` / `[SKIP]`) | v0.7 |
| `succinix net doctor` / `net preview` / `net tunnel` | Network capability report / virtual preview ports / outbound tunnel (unavailable) | v0.7 |
| `succinix init` | Detect project type from `package.json`, `pyproject.toml`, `requirements.txt`, Vite config, `index.html` | v0.7 |
| `succinix run` | Spawn the detected dev command (`npm run dev` / `npm start` / `node <main>`) through the execution world | v0.7 |
| `succinix serve` | Register + start the matching declarative service (`vite` / `static-http`) and print the preview URL | v0.7 |
| `succinix open [port]` | Print the preview URL for a ready port | v0.7 |

Persistent state files (all ride the snapshot, survive refresh): `/etc/succinix.env` (TASK10),
`/etc/succinix.settings` (TASK10), `/etc/systemd/system/*.service` units and
`/workspace/.succinix-service-state/*.enabled` enablement markers (TASK11), `/etc/succinix.motd` (TASK15), `/etc/succinix.cwd` (TASK23), `/etc/succinix.engine.json`
(result TTL override, TASK21/TASK26), `/ws/.current` (TASK7), `/var/log/succinix.log` (TASK12).

Command logs and Cordis command events redact secrets by default: tokens, passwords, npm auth
(`_authToken` / `_auth`), env secrets, and URL query secrets never reach
`/var/log/succinix.log`, telemetry events, or session mirrors.

## 3. Language runtimes

Measured in a real browser/container where an `LV`, `S`, or `ST` source is listed; the
measurement-backed matrix is
[docs/LANGUAGES.md](LANGUAGES.md) (中文: [docs/LANGUAGES.zh-CN.md](LANGUAGES.zh-CN.md)). Status
legend: `[OK]` measured working · `[x]` confirmed absent · text = partial/probe.

| Language | Command | Runtime | Version (measured) | Package install | Status | Source |
| -------- | ------- | ------- | ------------------ | --------------- | ------ | ------ |
| **Python** | `python`, `python3` | resident **Pyodide 314.0.4** daemon (node child, instance reused) | 3.14.2 | `[OK]` **pip** via micropip — pure-Python and compiled wheels persist across refresh (v0.7 binary snapshot) | `[OK]` | TASK23, TASK27, `LV·P1–P9`, `S11` |
| **pip** | `pip`, `pip3` | maps to Pyodide micropip (`python -m pip` too) | micropip 0.11.1 | `[OK]` install / uninstall / list / show | `[OK]` | TASK27, `LV·P6` |
| **Node.js** | `node` | real Node.js (WebContainer runtime) | 22.22.3 | `[OK]` npm, local per-project installs | `[OK]` | TASK1, TASK24, `LV·N1–N5` |
| **npm** | `npm` | real npm (ships with node) | 10.8.2 | `[OK]` local; `[x]` global (`/usr/local` read-only → EACCES + hint) | `[OK]` | TASK24, `LV·N4` |
| **TypeScript** | `npx tsc`, `tsx`, `vitest` | npm-installed toolchain; node 22 `--experimental-strip-types` | latest via npm | `[OK]` via npm | `[OK]` | TASK25, `LV·N3`, `S13`, `S14` |
| **Ruby** | `ruby` | Registered Lifo command; browser asset bridge lazily installs a WASM adapter run by a real Node child | head ruby.wasm | npm install; no gem | implementation present; direct WASM probe measured | `src/engine/host/runtime-commands.ts`, `LV·R1` |
| **C** | `gcc` | none | — | — | `[x]` confirmed absent | TASK25, `LV·R2` |
| **Rust** | `rustc`, `cargo` | none | — | — | `[x]` confirmed absent | TASK25, `LV·R2` |
| **Go** | `go` | none | — | — | `[x]` confirmed absent | TASK25, `LV·R2` |
| **WASI** | `wasi-run` / `wasi-info` | Lifo adapter over `node:wasi` (preview1), modules loaded from `/workspace` | node 22 | — | `[OK]` integrated (`wasi-run <file>`, ≤ 32 MB) | v0.7, `LV·R3` |

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
  **pip via micropip** (install/uninstall/list/show/--version). The current host has no generic
  Python child-process REPL (use `python -c`), `subprocess` imports but cannot spawn (`OSError: [Errno 138] ...`),
  compiled wheels (e.g. numpy) persist across refresh — the v0.7 binary export keeps their `.so` files.
- **TypeScript ecosystem** closed loop: `npm i -D typescript tsx vitest` → `npx tsc` →
  `node dist/*.js` → `npx vitest run` (1 passed) — measured in scenarios S13/S14.
- **Ruby** is a registered Lifo command. On first use it requests a browser-provided WASM runtime,
  then runs the installed adapter in a real Node child. `LV·R1` measures the underlying WASM API
  (`6*7` → 42), not the complete routed command; there is no gem installer. **C/Rust/Go**
  compilers are confirmed absent; precompiled **WASI** modules do run via `node:wasi`.

## 4. Persistence

- **Workspace snapshot → IndexedDB v2.** The container filesystem (files, `/etc` state,
  workspace, pip site-packages) is exported as a binary generation to the IndexedDB database
  `succinix-persist-v2` (dirty-driven auto-save after a 5 s debounce, forced no later than 30 s + `pagehide` fallback) and
  restored on boot. Refreshes never lose user files. `snapshot` shows status / saves manually /
  resets. | v0.7 (PLAN §7), TASK5, TASK26, README
- **Binary snapshot, exact restore.** Generations are written as ≤256 KiB chunks, then a
  SHA-256 manifest, then the active pointer (`current`); a torn write never switches the active
  generation (last-known-good retained). The v0.6 `succinix-persist` store is only detected and
  reported as `legacy snapshot detected` — never migrated or deleted. Default quota 256 MiB;
  empty directories are recorded and recreated. | v0.7 (PLAN §7.1), TASK16, TASK19
- **Exclusions.** `node_modules` / `dist` / `.git` trees are excluded from the binary export by default; set `defaultInstance.persistence.includeGit: true` to retain Git metadata.
  The `.succinix-terminal` mailbox, host/RPC artifacts (`host.js`, `lifo-core.js`, `cmd.json`,
  `result-*.json`), the `.tinbase` tree (binary PGlite store — persists across
  `db stop`/`db start` in-session but not across a browser refresh), and the `/usr/lib/succinix`
  runtime assets (~13 MB Python, re-injected on first use) never make it into the restored tree.
  Same-page instances additionally scope to their own state root and user home. | TASK19,
  TASK23, TASK18, M5
- **pip persistence.** The Pyodide site-packages directory is NODEFS-mounted to
  `/.pyodide/site-packages` (inside the snapshot); `/.pyodide/installed.json` records pip
  installs. **Pure-Python wheels (e.g. `pyparsing`) and compiled wheels (e.g. `numpy`) both
  persist across a refresh** — the binary export carries their `.so` files (`S11`). | TASK27
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
- **Service management**: `service`/`systemctl` manage named declarative units
  (`/etc/systemd/system/*.service`) through the shared Lifo `ServiceManager`, process table,
  and port registry. Enablement is mirrored to snapshot-backed markers for boot restore
  (not a PID 1 daemon — no crash self-healing). | TASK11
- **Port registry**: WebContainer `server-ready` events register a preview URL; `ports` lists them,
  `netstat` renders a virtual `Proto  Local Address  State` table (`netstat -p` matches the owning
  process). | TASK2, TASK14

## 6. Networking

- **Git over HTTPS**: `git init/status/add/rm/commit/log/diff/branch/checkout/clone/fetch/pull/push`
  run through Isomorphic Git inside the WebContainer execution world. Only HTTPS remotes are
  accepted; SSH returns `git: SSH transport is unsupported` with exit 126. `GIT_HTTP_TOKEN`
  stays in the live environment, is redacted from errors, and never enters a command log or
  snapshot. | v0.7
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
- **Here-documents**: `<<` and `<<-` are explicitly unsupported (`succinix: here-document: unsupported`, exit 2); quoted and escaped literal `<<` text remains valid. | v0.7

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
  `@succinix/engine@0.7.0` is the only public form: a plugin registered as
  `succinix`, consumed through `ctx.fs` / `ctx.sandbox` / `ctx.terminals` /
  `ctx.sessionPersistence`. | C1–C6, AGENTS.md
- **Protocol contract**: `docs/PROTOCOL.md` defines batch file RPC v2 and the independent
  interactive-terminal mailbox v1 —
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
  `boot` / `attach` / `ensureInstance`) live behind the `succinix` seam.
  | C2, cordis-contract.md
- **Typed events**: `succinix/state` (with `reason` / `changed`), `server-ready`,
  `server-closed`, `command` / `command-start` / `command-finish` telemetry,
  `runtime-ready`, `degradation`, `persistence`, `terminal-open` / `terminal-close` /
  `terminal-backpressure`, `instance`, `workspace`, `process`. | C4, manageability.md
- **Capability registry**: `terminal.exec`, `terminal.spawn`, `terminal.kill`,
  `terminal.interrupt`, `fs.read`, `fs.write`, `workspace.restore`, `workspace.flush`,
  `workspace.list`; default-allow with configurable rules. | C2
- **Lifecycle semantics**: page-level HostManager singleton; fiber reload does not restart the
  host; `dispose()` is soft, `shutdown()` is hard; `attach`/`boot` mode mismatch throws
  `ERR_MODE_MISMATCH`; asset SHA-256 integrity is enforced by default. | C2, C5
- **Multi-instance (0.7.0+)** — `host.ensureInstance(id, opts)` creates or
  reuses a per-instance stack on the shared page host. `?instance=<id>` starts
  the app as a named instance: state files (`/workspace/.succinix-<id>`),
  IndexedDB snapshot keys, env, services/ports views and process views are
  per-instance; cross-instance `kill` is rejected. Two tabs with different ids
  use separate hosts. | M1–M5, PROTOCOL.md
- **Multi-user (0.7.0+)** — `?user=<id>` (alias of `?instance=<id>`) seeds a per-user home
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
| Generic child-process interactive stdin | Current host uses file-based RPC and headless Lifo execution; arbitrary Node/Python REPLs remain unsupported. v0.7 adds a WebContainer-native Lifo terminal transport for explicitly interactive userland commands | TASK1, README, PLAN-v0.7.0 |
| No symlinks / hard links | Lifo VFS does not support them | README |
| Firefox / Safari / mobile unsupported | WebContainers requires Chromium; the environment-check error page explains | TASK4 |
| External `curl` needs a CORS proxy | `https://r.jina.ai/<url>` style | README |
| `npm i -g` → EACCES | `/usr/local` is read-only for `guest`; an actionable hint is appended | TASK24 |
| 1 MB output cap | stdout/stderr keep only the tail past 1 MB (bounds container memory) | TASK18 |
| First `python` command is slow | ~13 MB Pyodide runtime is lazily injected; subsequent commands reuse the daemon | TASK27 |
| Precise OS-level memory/CPU stats unavailable | Estimates only, always marked `~` with an `(estimated ...)` footnote | TASK6, AGENTS.md |

## 11. Self-test & testing

- **`?test=1` self-test** — runs the browser diagnostic suite. Its current counts are command
  output, not a static documentation fact; retain the output with the release evidence. | TASK1,
  TASK3, TASK20, TASK25
- **Scenario suite** — `scripts/scenarios.mjs` (headless Chrome + CDP): 14 real workflows S1–S14
  (npm dev loop, git via lifo-pkg-git, tinbase lifecycle, service enablement, workspace isolation,
  queue serialization, big output, persistence stress, error paths, reboot boundary, python
  workflow, cd-synced install, TS ecosystem, language regression). | TASK19, TASK23, TASK25
- **Language verification** — `scripts/lang-verify.mjs` is the measurement source for the `LV`
  entries in LANGUAGES. | TASK25
- **Bench** — `scripts/bench.mjs`: reproducible headless-Chrome benchmark (boot, command
  round-trip, snapshot, big output) with JSON output for CI. | TASK18
- **CI** — GitHub Actions (`.github/workflows/ci.yml`) runs `check` on push/PR and a scheduled
  `nightly-scenarios` job. A release result must cite the specific workflow run and environment. | TASK20
- **Unit tests** — Vitest (node) covering pure-logic modules with an in-memory mock FS / fake
  IndexedDB; v8 uses aggregate thresholds plus explicit risk-file thresholds for host, terminal,
  and persistence lifecycle paths. | TASK20
- **e2e pipeline** — `npm run test:e2e` builds once, then invokes `verify-deploy`, benchmark,
  scenarios, language verification, instance checks, and the Cordis app contract. Treat its
  output as current evidence rather than inferring pass status from this document. | TASK20, TASK25

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
- **PROTOCOL** — batch file-RPC v2 and interactive-terminal v1 contract: [English](PROTOCOL.md) · [中文](PROTOCOL.zh-CN.md)
- **SDK** — Cordis plugin integration: [English](SDK.md) · [中文](SDK.zh-CN.md)
- **PLUGIN** — third-party Cordis plugin authoring: [English](PLUGIN.md)
- **MIGRATION** — 0.4.0/0.5.0 and 0.6.0 to 0.7.0 guide: [English](MIGRATION.md)
- **cordis-contract** — contract snapshot and runner: [English](cordis-contract.md)
- **AGENTS** — agent & design guidelines: [English](../AGENTS.md) · [中文](../AGENTS.zh-CN.md)
- **CHANGELOG** — change history: [English](../CHANGELOG.md) · [中文](../CHANGELOG.zh-CN.md)
- **CONTRIBUTING** — how to contribute: [English](../CONTRIBUTING.md) · [中文](../CONTRIBUTING.zh-CN.md)
