# WebUnix

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-black.svg)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**A browser-native Linux: a full-screen Unix terminal powered by WebContainer + Lifo, with a unified TerminalExecutor that routes `node|npm|npx` to a real Node.js runtime and everything else to a Lifo Unix userland — sharing one filesystem.**

Open a browser tab, boot into a Linux-like environment, and use Unix tools, Node.js, process management, port forwarding, and a Postgres database (tinbase) without installing anything.

---

## Features

- **Full-screen terminal experience** — Ubuntu-style boot sequence with system self-checks, then an interactive shell (`guest@webunix:~$`).
- **Unified command execution** — one terminal entry point:
  - `node`, `npm`, `npx` and project binaries run on a **real Node.js process** (WebContainer).
  - Everything else (`grep`, `sed`, `awk`, `cat`, `tar`, `curl`, pipes, redirects, ...) runs on **Lifo**, a clean-room TypeScript implementation of Unix.
- **Shared filesystem** — the browser (`wc.fs`) and Lifo commands operate on the *same* files. No bridge code; WebContainer virtualizes `node:fs` for processes, and Lifo consumes it via `NativeFsProvider`.
- **Process management** — `ps` / `kill` over a unified process table (real child processes + tracked state), including background `spawn`.
- **Port management** — services are detected via WebContainer `server-ready` events and listed by `ports` with their preview URLs.
- **Database** — `db start` boots a real Postgres (tinbase, PGlite/WASM engine) inside the container; `db status` / `db stop` manage it.
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

Requirements: a modern Chromium-based browser (Chrome/Edge) with `SharedArrayBuffer` support. No server-side infrastructure needed for local development.

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

Runs the full diagnostics suite (filesystem, routing, process lifecycle, ports) in the terminal, then drops you into the shell.

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

### Host commands (TerminalExecutor, unified routing)

| Command                 | Route   | Description                                   |
| ----------------------- | ------- | --------------------------------------------- |
| `node ...` / `npm ...` / `npx ...` | Node | Real Node.js child process               |
| `grep`, `cat`, `tar`, `curl`, ...   | Lifo | Unix tools, pipes, redirects            |
| `ps`                    | —       | List the unified process table                |
| `kill <pid>`            | —       | Terminate a process (SIGTERM)                 |
| `cwd` / `ping` / `exit` | —       | Protocol commands                              |

## Verified Behavior

Result of the browser runtime verification suite (see `src/tests.ts`): **18 passed / 1 known boundary**.

- Shared filesystem: browser -> Lifo and Lifo -> browser reads/writes work.
- Routing: `node -e "console.log(21*2)"` -> `42` (`runtime=node`); `npm --version` -> real npm version; `grep`/`cat`/`wc` -> `runtime=lifo`.
- Process lifecycle: `spawn` a background service, `ps` shows it, `kill` transitions it to `exited`.
- Port registry: `server-ready` events surface preview URLs.
- Database: tinbase (PGlite/WASM) boots and serves.

## Known Boundaries

These are environmental constraints, not bugs:

- **CORS**: `curl` to sites without CORS headers fails (`exit 7`). Use a CORS-friendly proxy, e.g. `curl https://r.jina.ai/<url>`.
- **Symlinks**: not supported by the Lifo VFS (`ln` reports the limitation).
- **No package manager / native binaries**: there is no `apt`; native executables cannot run. This layer is reserved for a future v86-backed fallback.
- **stdin for interactive processes**: unreliable in the WebContainer environment; the design uses file-based RPC instead.
- **Streaming cross-runtime pipes**: cross-runtime pipes are buffered (fine for agent-style "run then read" workflows).
- **External inbound networking**: services are reachable via virtual preview URLs, not from the public internet.

## Project Structure

```
src/
  main.ts            # entry: xterm terminal, REPL, boot orchestration
  boot.ts            # boot sequence, system info detection, self-checks
  commands.ts        # browser-side commands (help/ports/db/...)
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
