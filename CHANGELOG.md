# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- tinbase startup on WebContainer: requires `--engine wasm --memory` (no native binaries).
- `db start` install step: host-side timeout must be passed via `{ timeout: 120000 }`.

### Known boundaries

- CORS restricts direct `curl` to external sites without CORS headers (use `https://r.jina.ai/<url>`).
- Lifo VFS does not support symlinks.
- No `apt` / native binaries (reserved for a future v86 fallback).
