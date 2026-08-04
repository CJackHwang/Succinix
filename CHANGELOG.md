# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Production-grade interface: English UI, dark-amber theme, JetBrains Mono, system self-check format, AGENTS.md design rules.

## [0.1.0] — 2026-08-05

### Added

- POC: Lifo running inside WebContainer sharing the container filesystem (no bridge code).
- TerminalExecutor v1: unified command routing (`node|npm|npx` -> real Node.js child process; everything else -> Lifo), unified process table with `ps`/`kill`, background `spawn`.
- File-based RPC protocol (`/cmd.json` -> `/result-<id>.json`), per-request result files to avoid write races.
- Product shell: full-screen black terminal, Ubuntu-style boot sequence with browser-detected system info, interactive shell prompt.
- Port management: `server-ready` registry and `ports` command.
- Database: `db start|status|stop` for tinbase (PGlite/WASM engine).
- Self-test suite accessible via `?test=1`.
- Open-source scaffolding: README, CONTRIBUTING, MIT license.

### Fixed

- Result overwrite race in the file-RPC channel (asynchronous `close` writes could clobber newer responses) — fixed with per-request result files.
- tinbase startup on WebContainer: requires `--engine wasm --memory` (no native binaries).
- `db start` install step: host-side timeout must be passed via `{ timeout: 120000 }`.

### Known boundaries

- CORS restricts direct `curl` to external sites without CORS headers (use `https://r.jina.ai/<url>`).
- Lifo VFS does not support symlinks.
- No `apt` / native binaries (reserved for a future v86 fallback).
