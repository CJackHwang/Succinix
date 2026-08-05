# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- TASK19 scenario suite: `scripts/scenarios.mjs` — a headless-Chrome/CDP driven real-workflow test suite (zero new deps, mirrors `verify-deploy.mjs`/`bench.mjs`) running 10 real scenarios against the real browser+container: S1 npm project dev loop (real HTTP 200 to the preview port), S2 git operations (`pkg install lifo-pkg-git` → init/add/commit/log with a real commit hash), S3 database full lifecycle (create table/insert/read via tinbase `/admin/v1/sql` + `/rest/v1`, data persists across `db stop`/`db start`), S4 service autostart (`service enable tinbase` survives a refresh and boots `running`; disable stops it), S5 multi-workspace isolation (files isolated per workspace, state retained after refresh), S6 concurrency stress (3 parallel long commands — per-id results not interleaved), S7 big output (`seq 1 10000` complete, 2 MB node output capped at 1 MB, no OOM), S8 persistence stress (300 files survive `snapshot now` + refresh, sampled content verified), S9 error paths (unknown command / missing dir / CORS curl all error cleanly in English), S10 environment boundary (`reboot` keeps files and a clean process table). `?scenario=1` exposes `window.__webunixScenario` (a `run()` that mirrors the real terminal dispatch path + `client`/`wc`/`ports`/`saveSnapshot`) for the driver.
- `respawnWithKillFirst` (new `src/host-restart.ts`): the kill-old-host-before-spawn invariant extracted into a testable helper; `main.ts` `restartHost` uses it and the self-test asserts the ordering directly.
- Self-test regressions (now 57 passed): `spawn npx definitely-not-exist-xyz` must return `ok:false` (not falsely report a running process), and the dual-host invariant (kill before spawn).

### Changed

- `?scenario=1` driver mode in `main.ts`: exposes the scenario handle only in scenario mode, mirroring `execute()`'s dispatch (browser-side intercept → host RPC) with structured output capture.
- `startService` now runs `npm install <pkg>` first when a service command is `npx <pkg> ...` and `<pkg>` isn't installed — node_modules doesn't ride snapshots, so autostart after a refresh used to race npx's on-the-fly download against the 30 s port-wait (flaky).
- tinbase persistence messaging is now honest: `db start` reports data persists across `db restart` in-session and that a browser refresh recreates the WASM store (binary db files aren't snapshotted); README Persistence section updated to match.

### Fixed

- spawn failure race (TASK19): `dispatchSpawn` now uses a startup-confirmation window — a spawned node/npm/npx process that exits non-zero within 2 s is reported `ok:false` (e.g. `npx definitely-not-exist-xyz`, a node script with a syntax error), instead of the browser reading `ok:true` + pid and the later failure being invisible. Measured npx 404 failure ~0.3–0.8 s, comfortably inside the window; healthy background services (tinbase, http servers) exceed it with no caller-visible change.
- Empty directories are now persisted: `collectDir` records empty dirs and `loadSnapshot` recreates them, so the default `main` workspace (an empty dir) no longer vanishes after switching to another workspace and refreshing.
- Snapshot now excludes the whole `.tinbase` tree: the PGlite WASM database (`/admin` .tinbase/db`) is binary, and a text-only partial restore corrupted it — after a refresh tinbase would crash on startup. Excluding it lets the service start a fresh store reliably (data is lost on refresh, honestly documented).

### Added

- Vercel deployment adaptation: root `vercel.json` serving `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless` on every path (`/(.*)` — including `assets/*` and `host.js`) with `framework: vite`, `buildCommand: npm run build`, `outputDirectory: dist`; `scripts/verify-deploy.mjs` — a local deploy-readiness gate (build → `vite preview` → COOP/COEP header assertion on `/`, `/host.js` and the JS bundle → `?test=1` self-test in headless Chrome, gate `>=51 passed` and `0 failed`); README **Deployment (Vercel)** section (one-click dashboard import, `vercel deploy` CLI, custom-domain hint, COOP/COEP rationale, per-origin IndexedDB data scoping) plus a Known Boundaries entry (deployment hosts must support custom response headers).

### Changed

- Performance: `scripts/bench.mjs` — a reproducible headless-Chrome benchmark (boot, Lifo/Node command round-trip, snapshot N=200/1000, xterm big output) that outputs JSON for CI reuse; measured boot ~3.8s → ~2.5–2.9s (−25–35%) and command round-trip ~156 ms → ~80 ms (−48%). Optimizations: host.js split into a lightweight daemon (`public/host.js`, 5 KB) plus a lazily-loaded Lifo kernel (`public/lifo-core.js`, ~1 MB) so host startup no longer parses the full bundle; host poll interval 120→50 ms; browser RPC poll 150 ms fixed → 25 ms adaptive (exponential backoff to 150 ms for long commands); boot overlay fade 400→200 ms; boot ping readiness retry 300→100 ms; `?bench=1` exposes internal handles for measurement only.
- Single-command output is capped at ~1 MB (tail kept) to bound container memory and result-file size; large dumps are truncated.
- Boot log honesty: Lifo kernel is lazily loaded and warmed in the background, so the boot line reads "Starting Lifo kernel" (not "Started") until the first Lifo command confirms readiness.

### Fixed

- Host restart double-host race: respawning `host.js` now kills the previous host process first (via the retained `WebContainerProcess` handle), preventing two hosts polling `/cmd.json` simultaneously.
- `spawn` failure race: `dispatchSpawn` deferred the `ok:true` write by one tick so a synchronous spawn error (ENOENT) surfaces to the browser as `ok:false` instead of being overwritten after the browser already read success; failed spawns are also marked `exited` in the process table (the `close` event never fires for a failed spawn).
- M1 residual: `findServiceProcess` now renders its matching needle with the service's recorded start port (from `activePorts`) instead of the current `preview-port`, so changing `preview-port` while a service runs no longer misreports it as stopped.
- `boot-ui.ts` marker mapping: the `[preview]` marker's implicit `'ok'` fall-through is now an explicit marker→kind lookup table (removes the redundant hidden branch).
- Host restarts now kill the previous host process first (single-host invariant); spawn failures report `ok:false` promptly instead of being masked.

## [0.2.0] — 2026-08-05

### Added

- Production-grade interface: English UI, dark-amber theme, JetBrains Mono, system self-check format, AGENTS.md design rules.
- Memory management: `free`/`top` memory overview (honest sandbox estimates), `reboot` (browser reload, persisted data survives), `shutdown`, and `cache`/`cache clear` (rebuildable caches only — never `/workspace`).
- Workspace split: multiple isolated workspaces (`/ws/<name>`) managed by the `workspace` command family (`create`/`switch`/`rm`); current workspace recorded in `/ws/.current` and persisted across refreshes; default `main` workspace initialized on first boot.
- System configuration: `env` manages persistent environment variables (`/etc/webunix.env`, merged into real Node child processes at spawn time) and `settings` manages persistent system settings (`/etc/webunix.settings`: tinbase `preview-port` default 3001, `default-workspace` used at boot, `font-size` applied live to the terminal).
- Service management: `service` command family (`list`/`start`/`stop`/`status`/`enable`/`disable`) over the existing `spawn`/`ps`/`kill` + port registry, with declarative service definitions (`/etc/webunix.services`, `name|command|port`, `${PORT}` placeholder resolved from `preview-port`) and boot autostart (`/etc/webunix.autostart`, declarative restart at boot — not a daemon, no crash self-healing).
- Logging system (journald-style): persistent log at `/var/log/webunix.log` (container FS, rides snapshots; auto-truncates to a ~200 KB tail) capturing boot events (`BOOT`), command executions (`INFO` — `cmd: <command> exit=<code> runtime=<node|lifo|browser|protocol>`), service events (`INFO`/`WARN`), snapshot events (`INFO`) and errors (`ERROR`); `log` command family (`log` last 20, `log -n <count>`, `log boot`, `log clear`). Interactive `log -f` is deferred (POC).
- Virtual network view: `netstat` lists the virtual listening ports (port registry rendered as `Proto  Local Address  State`, `tcp 127.0.0.1:<port> LISTEN`; `netstat -p` adds the associated process — matched by port number in the process command, `-` when unmatched) and `ip addr` shows the browser's virtual network identity (`lo: virtual loopback`, `eth0: <preview-domain> (virtual)`). Everything is honestly labeled `virtual`; no fabricated interfaces, IPs, or connections.
- System information & login banner: `uname` reports the honest browser-native system identity — summary line `WebUnix 0.2.0 js-runtime+webcontainer <api-version> <arch>` (kernel identified as `js-runtime+webcontainer`, never impersonating a Linux kernel), `-a` all fields with hostname/OS, `-r` the `@webcontainer/api` runtime version, `-m` the UA-derived architecture (`unknown` when absent) — and `motd` views/edits the persisted login banner at `/etc/webunix.motd` (`motd <text>` sets it, `motd reset` restores the default welcome line, printed at every boot).
- Package management: `pkg` command family (`list`/`search`/`install`/`remove`/`info`) unifying the two real channels — **lifo** (`lifo list`/`search`/`install`/`remove`, Lifo extension packages like `lifo-pkg-git`) and **npm** (real Node npm). Source auto-detection: `lifo-pkg-<name>` on npm → lifo, else npm; lifo wins on a name conflict. `pkg list` merges both channels with a `SOURCE` column, `pkg search` merges both searches, `pkg install`/`remove` echo the real command output. The npm list is read from `node_modules` top-level directories (top-level direct-install simplification — includes container preinstalled runtime deps, no dependency-tree parse).

### Changed

- Self-test results now reach the terminal: after the boot overlay fades, `?test=1` prints `Self-test result: N passed, M failed, K skipped` (plus the dark-red failure list when any test failed) into the shell, so results stay visible after the splash is gone.
- host.js is esbuild-minified (`minify: true`): 1,965,361 B → 1,070,913 B (−45.5%). Verified by a full `?test=1` pass against the minified bundle; the `keepNames: true` variant (1,106,353 B, −43.7%) was evaluated and not needed.
- RPC client robustness: all requests are serialized over the single-slot `/cmd.json` channel (fixes the pkg search parallel-channel race), read-only commands (`ping`/`ps`/`cwd`) retry once on transport failure, and a browser watchdog re-injects + respawns `host.js` after 2 consecutive failed pings (fresh process table, WARN log).
- Snapshot signature no longer counts `/var/log/webunix.log` (the log still rides snapshots; only the change-detection signature excludes it), so per-command log growth no longer forces a full snapshot rewrite.
- Port↔process matching in `netstat -p` is now structured (`--port N` / `listen(N)` / word-boundary token) instead of substring — `3001` no longer associates with ports `300`/`30010`; `processLabel` skips leading `npx`/`node` flags (`npx --yes X` → `X`).
- Boot order: `loadSnapshot` now runs before `initLogger`, eliminating the log-write race during restore (pre-restore boot events are not persisted — accepted).
- `uname -r` runtime version is now injected at build time: Vite `define` reads the installed `@webcontainer/api` version from `node_modules` (replacing the hardcoded `1.6.4`), so `uname` follows dependency upgrades and never reports stale data.
- Self-test coverage: added dispatch-path assertions for `uname -r` / `uname -m` (through the command router, not the builders directly), verifying the flag-parsing chain end to end.

### Fixed

- pkg search single-slot race: parallel `lifoSearch`/`npmSearch` overwrote `/cmd.json`, dropping one channel — now serialized via the client request queue.
- Package name validation: `pkg install/remove/info` reject empty names, whitespace, and leading `-` (valid: `@scope/name` or `[a-zA-Z0-9-_.]+`); command arguments are double-quoted; `pkg install --help` no longer returns a false success.
- `detectSource` network-fallback is now surfaced: when the lifo registry is unreachable and npm is used, the message appends `(lifo unavailable — fell back to npm)` instead of silently switching.
- Polling `ps` no longer floods the journal: pure `ps` protocol queries skip the command log; `kill` is still recorded.

## [0.1.0] — 2026-08-05

### Added

- POC: Lifo running inside WebContainer sharing the container filesystem (no bridge code).
- TerminalExecutor v1: unified command routing (`node|npm|npx` -> real Node.js child process; everything else -> Lifo), unified process table with `ps`/`kill`, background `spawn`.
- File-based RPC protocol (`/cmd.json` -> `/result-<id>.json`), per-request result files to avoid write races.
- Product shell: full-screen black terminal, Ubuntu-style boot sequence with browser-detected system info, interactive shell prompt.
- Port management: `server-ready` registry and `ports` command.
- Database: `db start|status|stop` for tinbase (PGlite/WASM engine).
- Self-test suite accessible via `?test=1`.
- Persistence layer: workspace snapshotted to IndexedDB (auto-save every ~2.5s + `pagehide` fallback), restored on boot; `snapshot` command; tinbase data persists with the workspace.
- Open-source scaffolding: README, CONTRIBUTING, MIT license.

### Fixed

- Result overwrite race in the file-RPC channel (asynchronous `close` writes could clobber newer responses) — fixed with per-request result files.
- tinbase startup on WebContainer: requires `--engine wasm` (no native binaries).
- `db start` install step: host-side timeout must be passed via `{ timeout: 120000 }`.

### Known boundaries

- CORS restricts direct `curl` to external sites without CORS headers (use `https://r.jina.ai/<url>`).
- Lifo VFS does not support symlinks.
- No `apt` / native binaries (reserved for a future v86 fallback).
