# WebUnix

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-black.svg)](package.json)
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
- **Persistence** — the workspace (files + database data) is snapshotted to IndexedDB and restored on boot; refresh never loses data. `snapshot` command for status / manual save / reset. Snapshots are text-focused: binary/unreadable files are skipped (counted and reported in the save log), and a snapshot whose collected size exceeds ~50 MB is skipped with a warning rather than written (`snapshot now` reports `skipped (over 50MB limit)`).
- **Memory management** — `free` / `top` give a memory overview (device + JS heap; sandbox estimates are honestly labeled), `reboot` restarts the system with a browser reload (persisted data survives), `shutdown` powers off, and `cache` / `cache clear` report and clean rebuildable caches without touching `/workspace`.
- **Workspace split** — `workspace` manages multiple isolated workspaces: each lives in its own `/ws/<name>` directory with its own files and state; `create` / `switch` / `rm` manage them, and the current workspace is recorded in `/ws/.current` (persists across refreshes). The default `main` workspace is initialized on first boot.
- **System configuration** — `env` manages persistent environment variables (`/etc/webunix.env`, merged into real Node child processes at spawn time) and `settings` manages persistent system settings (`/etc/webunix.settings`): the tinbase port (`preview-port`, default 3001), the initial workspace (`default-workspace`, default `main`), and the terminal font size (`font-size`, applied live). Both files ride the snapshot so they survive refreshes.
- **Service management** — `service` manages named background services declaratively on top of `spawn`/`ps`/`kill` and the port registry: definitions live in `/etc/webunix.services` (`name|command|port`, `#` comments, `${PORT}` placeholder resolved from `preview-port`), with `start`/`stop`/`status`/`enable`/`disable`. `enable` records the service in `/etc/webunix.autostart` and boot pulls it up declaratively — a declarative restart, not a daemon (no crash self-healing).
- **System log (journald-style)** — a persistent log written to `/var/log/webunix.log` on the container FS (rides the snapshot, so it survives refreshes), formatted `2026-08-05T04:00:00Z [level] message`. It captures boot events (`BOOT`), command executions (`INFO` with `cmd`/`exit`/`runtime`), service events (`INFO`/`WARN`), snapshot events (`INFO`) and errors (`ERROR`). `log` reads it (`log` last 20, `log -n <count>`, `log boot` BOOT-only, `log clear`); the file auto-truncates to a ~200 KB tail when oversized. Interactive `log -f` (tail -f) is intentionally not implemented (POC).
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
```

### Self-test mode

```bash
# open http://localhost:7892/?test=1
```

Runs the full diagnostics suite (filesystem, routing, process lifecycle, ports) inside the centered boot-splash overlay, then drops you into the shell.

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

### Host commands (TerminalExecutor, unified routing)

| Command                 | Route   | Description                                   |
| ----------------------- | ------- | --------------------------------------------- |
| `node ...` / `npm ...` / `npx ...` | Node | Real Node.js child process               |
| `grep`, `cat`, `tar`, `curl`, ...   | Lifo | Unix tools, pipes, redirects            |
| `ps`                    | —       | List the unified process table                |
| `kill <pid>`            | —       | Terminate a process (SIGTERM)                 |
| `cwd` / `ping` / `exit` | —       | Protocol commands                              |

## Verified Behavior

Result of the browser runtime verification suite (see `src/tests.ts`): the full diagnostics pass, now including the system-config lifecycle (`env` set/get/delete and `settings` write/reset).

- Shared filesystem: browser -> Lifo and Lifo -> browser reads/writes work.
- Routing: `node -e "console.log(21*2)"` -> `42` (`runtime=node`); `npm --version` -> real npm version; `grep`/`cat`/`wc` -> `runtime=lifo`.
- Process lifecycle: `spawn` a background service, `ps` shows it, `kill` transitions it to `exited`.
- Port registry: `server-ready` events surface preview URLs.
- Database: tinbase (PGlite/WASM) boots and serves.
- Memory: device memory / JS heap stats reported by the browser (`free` can render).
- Config: `env` set/get/delete lifecycle and `settings` write/reset persist to `/etc/webunix.*`.
- Services: `service` lists the built-in tinbase definition; a temporary echo server can be started, observed `running` (process table + port registry), stopped, and removed with zero residue; `service enable`/`disable` write and remove the `/etc/webunix.autostart` file (deduped).
- Logs: command executions are recorded with `exit`/`runtime`, boot events are recorded as `BOOT` entries, and `log clear` empties the log file (asserted by the self-test suite).

## Known Boundaries

These are environmental constraints, not bugs:

- **CORS**: `curl` to sites without CORS headers fails (`exit 7`). Use a CORS-friendly proxy, e.g. `curl https://r.jina.ai/<url>`.
- **Symlinks**: not supported by the Lifo VFS (`ln` reports the limitation).
- **No package manager / native binaries**: there is no `apt`; native executables cannot run. This layer is reserved for a future v86-backed fallback.
- **stdin for interactive processes**: unreliable in the WebContainer environment; the design uses file-based RPC instead.
- **Streaming cross-runtime pipes**: cross-runtime pipes are buffered (fine for agent-style "run then read" workflows).
- **Declarative autostart (not a daemon)**: `service enable` only records the service for a boot-time restart. There is no crash detection or self-healing — if a service exits after boot, restart it manually (`service start <name>`).
- **`log -f` (tail -f) not implemented**: interactive streaming output is deferred (POC; interactive stdin is unreliable in WebContainer). Use `log` / `log -n <count>` instead. `log clear` wipes `/var/log/webunix.log` and is therefore not itself recorded in the log.
- **External inbound networking**: services are reachable via virtual preview URLs, not from the public internet.
- **Services claim processes by command string**: `service stop` (and `db stop`) locate a service by matching its rendered command against the process table, not by PID lineage. A manually started process running the same command may be matched and killed. `service start` likewise reports "already running" if a process with that command is found.
- **Built-in tinbase service needs one install step**: the preset `service` definition (`tinbase`) runs `npx tinbase start --port ${PORT} --engine wasm`, which requires tinbase to be installed in the container. Run `db start` once first to complete the in-container install before using `service start tinbase`.

## Project Structure

```
src/
  main.ts            # entry: xterm terminal, REPL, boot orchestration
  boot.ts            # boot sequence, system info detection, env pre-check
  boot-ui.ts         # centered DOM boot overlay renderer (splash/logs/env-fail page)
  commands.ts        # browser-side commands (help/ports/db/free/top/cache/workspace/env/settings/service/log/...)
  config.ts          # system configuration: /etc/webunix.env + /etc/webunix.settings I/O & defaults
  services.ts        # service management: /etc/webunix.services + /etc/webunix.autostart I/O, status/start/stop
  log.ts             # journald-style system log: /var/log/webunix.log append/read/clear/BOOT-filter
  terminal-client.ts # file-RPC client (single terminal() entry)
  tests.ts           # self-test suite (?test=1)
  host.ts            # TerminalExecutor daemon (runs inside WebContainer)
  host-procs.ts      # unified process registry
scripts/
  build-host.mjs     # esbuild bundle of the in-container host
public/host.js       # built host bundle (gitignored, generated)
```

## Roadmap

- [x] POC: Lifo inside WebContainer with shared filesystem
- [x] TerminalExecutor v1: unified routing + process table
- [x] Product shell: full-screen terminal, boot sequence, ports, tinbase
- [x] Production-grade interface: English UI, dark-amber theme, JetBrains Mono, system self-checks
- [x] Boot splash: centered DOM overlay, responsive layout, graceful environment-exit
- [x] Persistence layer: files/state persisted to IndexedDB, restored on boot (no data loss on refresh)
- [x] Memory management: `free`/`top`-style commands, cache cleanup, reboot to reclaim memory
- [x] Workspace split: multiple virtual directories with isolated state (like Sunam workspaces)
- [ ] SunamAI integration: replace `shell_run` engine with TerminalExecutor
- [ ] Optional: WebSocket tunnel for external access, v86 fallback layer

## License

MIT © 2026 [CJackHwang](https://github.com/CJackHwang). See [LICENSE](LICENSE).

## Acknowledgements

- [Lifo](https://github.com/lifo-sh) — the TypeScript Unix userland (MIT).
- [WebContainers](https://webcontainers.io) by StackBlitz — Node.js runtime in the browser.
- [xterm.js](https://xtermjs.org/) — terminal emulation (MIT).
- [tinbase](https://github.com/tinbase/tinbase) — browser Postgres (PGlite/WASM).
- [Vite](https://vitejs.dev/) — build tooling (MIT).
