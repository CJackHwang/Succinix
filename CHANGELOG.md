# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

- **The `ctx.succinix` single-key service surface is removed.** The engine
  now provides the dsh 0.1.0-rc.6 service keys `ctx.fs`, `ctx.sandbox`,
  `ctx.terminals`, and `ctx.sessionPersistence`; the legacy key is not
  retained or deprecated.
- **The Cordis baseline is `@deepseek-ai/cordis@4.0.1`.**
- **`ctx.succinixState` / `ctx.succinixPlugins` command-context fields are
  renamed** to `succinixState` / `succinixPlugins` without the `ctx.` service
  prefix.
- **`ctx.fs` follows the dsh error and identity contracts:** 12 primitives,
  13 error codes, `sandboxMode`, `sandboxPolicy`, opaque `targetKey`,
  LF-normalized outcomes, and bounded `readBytes`.
- **`ctx.sandbox.confine` is fail-closed:** it accepts only `read-only` and
  `workspace-write`; real `node|npm|npx` subprocesses throw
  `SANDBOX_UNAVAILABLE` in confined mode.
- **`ctx.terminals` is an owner-scoped registry** with a fixed signal
  whitelist, one in-flight send per session, and idempotent quiescent `kill`.
- **`ctx.sessionPersistence` is an event-sourced JSONL mirror** with
  contiguous seq, torn-tail repair, raw artifacts, and opaque revisions.

### Added

- Vendored dsh 0.1.0-rc.6 contract snapshots under
  `docs/contracts/dsh-0.1.0-rc.6/`.
- `scripts/check-dsh-shapes.mjs` and `scripts/check-dsh-keys.mjs`, wired into
  `npm run check`.
- Unit and browser e2e coverage for the four dsh services, including the
  external `examples/cordis-app` contract.

## [0.5.0] — 2026-08-13

### Breaking

- **`@succinix/engine` is now a Cordis plugin (single-track).** The root
  export is `{ name: 'succinix', apply, Config }`; there is no standalone SDK
  API line and no second `plugin-*` package.
- **Exports changed.** `./terminal` and `./instance` subpaths are removed;
  `@succinix/engine` direct functions (`createTerminalExecutor`,
  `createSuccinixInstance`) are no longer the public entry. The remaining
  subpath exports are `./host.js`, `./lifo-core.js`, `./assets/*`, and
  `./package.json`.
- **SDK direct calls become Cordis services.** `createTerminalExecutor()`
  maps to `ctx.succinix.executor`, `@succinix/engine/terminal` maps to
  `ctx.succinix.terminal.create`, and `createSuccinixInstance` /
  `@succinix/engine/instance` map to `ctx.succinix.ensureInstance`.
- **Lifecycle ownership moved into the plugin.** The page-level HostManager
  is a singleton that survives fiber reload; `dispose()` is soft by default
  and `shutdown()` is the hard teardown.
- **Configuration style changed.** `SuccinixConfig` is serializable and
  synchronously validated; runtime callbacks (`onServerReady`,
  `onServerClosed`, `onCommand`) move to event subscriptions or service
  arguments.
- **`pagePorts` is no longer public.** The canonical port surface is
  `ctx.succinix.ports`.

### Added

- Cordis plugin entry, `ctx.succinix` service surface, typed `succinix/*`
  events, capability registry, page-level HostManager, asset SHA-256
  integrity, and `internal` / `external` container modes.
- `docs/MIGRATION.md`, `docs/PLUGIN.md`, and `docs/cordis-contract.md`; the
  SDK docs were rewritten for the plugin form.
- `examples/cordis-app/` external demo and
  `scripts/cordis-app-e2e.mjs` browser contract gate.

### Changed

- The Succinix app is now a Cordis host that consumes the engine plugin.
- `docs/PLAN-cordis.md` is archived as the historical execution record.
- `ctx.succinix.flush()` flushes every live instance for best-effort page
  lifecycle handling; `persist.force` and shutdown flush now emit
  `succinix/workspace` events.
- Python runtime injection honors `pythonAssetsUrl` through
  `ensurePythonRuntime(wc, assetsBase)` and the plugin executor path.

### Fixed

- `workspace` now fails fast with `state.lastError` before the default
  instance exists, matching the other default-instance services.
- Service/db stop waits for the child process to exit before reporting
  success; host `kill` supports optional `forceAfterMs` with SIGKILL
  escalation.
- `configRevision` stays monotonic across `fiber.update`, and restart-required
  updates shut the host down before the fiber reapplies.

> Release note: this entry documents the release-ready package. Actual npm
> publish and deprecation of `0.4.0` / `0.1.x` are executed by the release
> owner when explicitly requested.

## [0.4.0] — 2026-08-10

### Added

- **Terminal SDK (E1–E4)** — `SuccinixTerminalSession`, a UI-free terminal interaction core
  (history, Tab completion, real Ctrl+C interrupt, command queue, cwd-following prompt) over the
  narrow `TerminalRpc` / `TerminalOutput` contracts; `createTerminalBoot` parameterizes the boot
  flow (steps / retry / testMode) with `BootUI` progress markers; the standalone app was rewritten
  as a thin assembly layer over the SDK with no behavior change. New package export
  `@succinix/engine/terminal` (self-contained, no `node:` references).
- **Multi-instance (M1–M5)** — `@succinix/engine/instance` exports
  `createSuccinixInstance({ wc, instanceId, ... })` aggregating executor + terminal session +
  per-instance snapshot persistence, services and port views. Instance context is an **additive**
  protocol field (`instanceId`): state files move under `/workspace/.succinix-<id>`, IndexedDB
  snapshots split per-instance keys, `ps` filters per instance, `interrupt` keys per instance, and
  `?instance=<id>` starts the standalone app as a named instance (dual-tab demo, e2e verified).
- **Multi-user semantics (U1)** — `userId` and `instanceId` are the same field; `?user=<id>`
  (alias of `?instance=<id>`) seeds a per-user home (`/workspace/users/<id>`): the session starts
  in the home (prompt `~`, node/python spawns there), `whoami`/prompt show the user, and state,
  snapshots and process views are per-user. Host-side `kill` authorization rejects cross-instance
  kills (`permission denied: process <pid> is not owned by instance '<id>'`) and `system`
  processes for non-default instances. Documented as **organizational isolation, not a security
  boundary** (AGENTS.md / SDK.md / PROTOCOL.md).

### Changed

- `src/main.ts` and `src/boot.ts` now assemble the app over the terminal SDK and the instance
  factory; boot steps / demo paths share one implementation (`runApplicationBootSteps`).
- `?test=1` self-test suite grew to **76 passed, 0 failed, 5 skipped**; Vitest suite grew to
  **320 tests** across 23 files (instance protocol/paths, multi-user kill authorization, user
  home seeding, host routing).
- `scripts/instance-demo.mjs` now covers both dual-tab `?instance=` and dual-user `?user=`
  isolation (27/27 checks).

### Fixed

- TypeScript error in the U1 demo wiring (unused import / option type) caught by the tsc gate
  before commit.

### Performance (measured 2026-08-10, this machine)

- `public/host.js` grew from ~5 KB (0.3.0) to **15,037 B** — per-instance/per-user routing
  (cwd/env/state maps, `ps` filtering, `kill` authorization) lives in the host daemon;
  `public/lifo-core.js` unchanged at **1,066,097 B** (lazy-loaded on first Lifo command).
- `scripts/bench.mjs`: boot overlay → prompt **~6.1 s** (dominated by `WebContainer.boot`,
  5.35 s — environment-dependent), command round-trip **Lifo p50 ≈ 79 ms / Node p50 ≈ 79 ms**
  (0.3.0-era baseline ~80 ms — no regression), snapshot N=200 **13 ms**, N=1000 **193 ms**,
  `seq 1 5000` render **79 ms**.

## [0.3.0] — 2026-08-10

### Changed

- **TODO-optimizations: full 19-item architecture/code-quality batch** —
  - **P0**: auto-snapshot adds a 30 s **maximum-age force** (`persist.isAgeForced` + `AUTO_SNAPSHOT_FORCE_INTERVAL_MS`) bounding the equal-length-edit loss window; the host now **deletes `/cmd.json`** after processing a request so a stale command is never executed by a freshly respawned host.
  - **P1**: the `createTerminalExecutor()` facade gains `pingDirect()` + `respawn()` (single-host invariant) and `boot` accepts `EngineBootHooks`; the README documents the "two execution surfaces, one host" split. `host.ts` pure logic (route classification / path mapping / output cap / EACCES hint / pid parsing) extracted to `src/engine/host-route.ts` (unit-tested, in the coverage gate). Process-ownership `scope` is documented as **heuristic, not a security boundary**.
  - **P2**: shared `src/theme.ts` (ANSI colors), `src/util.ts` (`sleep`/`ensureParentDir`), `src/engine/sleep.ts` (engine self-contained sleep), `forcePersist` consolidated in `persist.ts` (tag param); version injected at build time as `__SUCCINIX_VERSION__` (`src/version.ts`, single source = root `package.json`); the three host spawn sites merged via `attachOutputCollector` + `spawnTracked`; `dbStart` failure blocks consolidated into one `fail()`; `execute`/`scenarioRun` share `callHostRpc`.
  - **P3**: `commands.ts` pure functions (21 cases) and `TerminalClient` (20 cases: serial queue / read-only retry / `pingDirect` channel logic / `interruptDirect`) now unit-tested; `client.ts` + `host-route.ts` added to the coverage gate (~94.5% lines). The facade has 14 cases (`tests/engine-facade.test.ts`). `commands.ts` stays out of the gate by scope decision (would drag the aggregate below 70%).
  - **P4**: auto-snapshot idles with exponential backoff (2.5 s → 5/10/15 s, reset on real change); `SaveResult.reason` added. Log appendFile O(n) read-modify-write recorded as backlog.
  - **P5**: **Ctrl+C interrupts a running command and clears the queue** (`interrupt` protocol command + `interruptDirect` bypassing the queue), **Up/Down command history** + **Tab completion** (built-ins + file paths), unknown escape sequences dropped instead of garbling the terminal.
  - **P6**: CSP evaluation recorded as deferred (WebContainer internals need blob workers / wasm-unsafe-eval / npm-connect, not shipped unverified); `?test=1`/`?bench=1`/`?scenario=1` documented as developer-only test hooks.

- **Process ownership annotation (process isolation for host projects)** — `ps()` responses now carry a `scope` field (`system` / `container` / `unknown`) plus an optional `containerId`, derived from the process launch cwd (`cd /workspace/c-<id>` prefix). Protocol-compatible extension: existing fields unchanged, new fields additive. Host projects (SunamAI) use it to filter processes per container and block cross-container kills.

- **Boot screen simplified (no splash overlay, boot log streams into the terminal)** — removed the DOM splash overlay (ASCII-art title + system-info grid); boot logs (`[  OK  ]` lines) are written straight to xterm, the motd/prompt follow directly after the self-test without clearing the screen (scrollback shows the full boot log). Environment-error page stays DOM. `?test=1` / `?bench=1` / `?scenario=1` modes unaffected; `verify-deploy.mjs` reads `__succinixResult`.

- **Brand migration (TASK26): the project is now Succinix (SuccinixOS)** — unified rename with zero functional change and no old-name compatibility layer.
  - Identity: package name `succinix`, `<title>` / boot-version / env-error page, boot banner (`Succinix 0.2.0 ...`), boot-splash ASCII art (SUCCINIX), terminal prompt `guest@succinix:~$`, `uname` identity (`Succinix 0.2.0 ...`, hostname `succinix`), help / reboot / self-test strings.
  - State files `/etc/succinix.*` (`env` / `settings` / `services` / `autostart` / `motd` / `cwd` / `engine.json`), log `/var/log/succinix.log`, python runtime assets `/usr/lib/succinix`.
  - Persistence: IndexedDB database `succinix-persist`; window hooks `__succinixBench` / `__succinixScenario`; dev-tool temp-dir prefixes `succinix-*`.
  - Ecosystem naming (`docs/SDK.md`): `@succinix/engine`, `@succinix/sandbox-page`, `create-succinix-app`.
  - `docs/tasks/*` historical archive intentionally unchanged; version stays **0.2.0**.

- **Built-in Python switched from the stdlib-only python-wasm runtime to a resident Pyodide daemon (TASK27)** — the built-in `python` / `python3` now run on **Pyodide 314.0.4** (bundled **Python 3.14.2**) with **`pip` / third-party package support via micropip**:
  - Runtime: `src/engine/python-daemon.ts` is a long-lived node process spawned by the host on first use (`src/engine/python-daemon-client.ts`); it `loadPyodide`s once and reuses the instance across commands — Python state (imported modules, pip-installed packages) accumulates in the session, exactly like the Lifo kernel. Command protocol / file RPC / shell-fusion routing are unchanged (pure python/pip commands route to the daemon; commands with shell metacharacters fall back to the Lifo shell and forward each python/pip segment to the same daemon).
  - Assets: `scripts/build-host.mjs` downloads the **Pyodide 314.0.4 full** release from the jsdelivr CDN to `public/pyodide/` (pyodide.mjs + pyodide.asm.mjs + pyodide.asm.wasm + python_stdlib.zip + pyodide-lock.json, version-pinned) and bundles the daemon; the old python-wasm assets (python.wasm / kernel.wasm / python-stdlib.zip / termcap) and their lazy-injection logic were removed (`src/engine/python-assets.ts` now injects the Pyodide set into `/usr/lib/succinix/python/`).
  - **pip persistence (best-effort, honest boundary)**: the Pyodide site-packages directory is NODEFS-mounted to `/.pyodide/site-packages` (inside the workspace snapshot). **Pure-Python wheels (e.g. `pyparsing`) persist across a refresh** — verified: `pip install pyparsing` → reload → `import pyparsing` works with no network. **Compiled wheels (e.g. `numpy`) need one `pip install <pkg>` after a refresh**: their `.so` files are binary and the snapshot is text-only, so an incomplete package is dropped at daemon start to avoid a broken `import` (documented boundary in `docs/LANGUAGES.md`). The manifest `/.pyodide/installed.json` records pip installs.
  - Behavior: `python -c` / `python <script.py>` / `python -m <module>` semantics preserved (relative file ops map to the container root via a NODEFS cwd mount); `python -m pip install <pkg>` and the bare `pip`/`pip3` commands map to micropip (install / uninstall / list / show / --version). `subprocess` imports but `subprocess.run` raises `OSError: [Errno 138] emscripten does not support processes` (Pyodide has no OS process API — re-measured, was `NOT IMPLEMENTED` under python-wasm).
  - Why: the TASK23 premise that Pyodide 314 does not run on WebContainer's node 22 was **retested and overturned** in 2026-08 — `validate` + `instantiate` + `loadPyodide` + `micropip` all work on the container's node 22.22.3, so the user-requested stack switch to a pip-capable Python was implemented.
  - Verification: `scripts/lang-verify.mjs` LV·P1–P9 and scenario S11 re-measured for Pyodide (3.14.2 version, pip install pyparsing, numpy install + matmul `[[7,10],[15,22]]`, refresh persistence + compiled-package boundary); self-test python assertions updated (version, `python -m pip --version` works, pip install pyparsing + import).

### Added

- **`pip` / `pip3` commands** (host routing + Lifo-shell forwarding) and the `python -m pip` subcommands (install / uninstall / list / show / --version).
- **`public/pyodide/PYODIDE_VERSION`** build artifact (pins 314.0.4) and the `.pyodide/` daemon persistence layout (site-packages + `installed.json` manifest).

- TASK25 language-ecosystem verification (real browser, zero new deps):
  - **`scripts/lang-verify.mjs`** — CDP-driven multi-language verification (28 checks, ids `P1–P8` / `N1–N5` / `R1–R3`): python version/`-c`/script/pipes, an 11-module stdlib import matrix, `json.dumps`/`subprocess.run` behavior probes, pip error clarity, shared-FS read/write across python/node/lifo; the 5 TS/Node user-measured pits (chain, nested-quote write, full TS toolchain, EACCES hint, cwd-synced install); Ruby `@ruby/wasm-wasi` v2 probe (**runs**: `6*7` → 42), absent C/Rust/Go compilers, and a `node:wasi` minimal-wasm execution. Wired into `npm run test:e2e` (after scenarios).
  - **`docs/LANGUAGES.md` + `docs/LANGUAGES.zh-CN.md`** — authoritative, measurement-backed language support matrix; every status cites its measured source (`LV·P1`…`LV·R3`, `ST`, `S13`/`S14`). README (+ zh) gained a Languages section and links.
  - **Self-test additions (gate 71 → 75)**: python extended stdlib (subprocess/collections/datetime/hashlib/urllib), python shared-FS write/read, `python -m pip` clear error, and the `npm i -g` EACCES hint line (network-unreachable falls back to a known-boundary skip).
  - **Scenario S14** (language regression): the 5 user-measured pits locked against regression — `node && npm` chain, `node -e` nested-quote write preserved through `tsc`, `npm i -g` EACCES + hint, cwd-synced npm install (packaged into the project dir), python true pipes. Now 14 scenarios.
  - **`python -m` clear error** (`src/engine/python-runtime.ts`): `python -m pip ...` reports `pip is not available in this embedded runtime` (previously misread as a script file); `python -m <module>` is explicitly rejected.

### Fixed

- **`cd /` returns to the workspace root (`~`)** — the session-cwd sync only recognized `/workspace`-prefixed paths, so `cd /` (Lifo VFS root) left the session cwd unchanged and the prompt/pwd/node children stayed at the old directory ("can't get back to root"). The Lifo root is now mapped to the workspace root (`lifoCwdToSessionCwd`: `/` → `/workspace`, `/workspace/...` as-is, Lifo-private paths → no sync; unit-tested). Refresh keeps the persisted cwd (by design); `cd /` is the one-shot way back to `~`.
- **Prompt follows the session cwd (cd now updates the prompt)** — the REPL prompt was hardcoded `guest@succinix:~$` and never reflected `cd`. The browser now tracks the session cwd (initialized from the host `cwd` protocol after boot, so a persisted `/etc/succinix.cwd` survives a refresh; updated from the `cwd` field on a successful `cd` run) and renders the directory: `/workspace` → `~`, `/workspace/proj` → `~/proj` (`sessionCwdPromptLabel`, unit-tested). `cd /workspace/proj` now turns the prompt into `guest@succinix:~/proj$`.
- **P0-1 follow-up: the auto-snapshot 30 s age-force never re-armed after a snapshot restore** — `lastFullSaveAt` started at 0 on a fresh page and, with a restored snapshot that kept deduping (idle), never updated, so `isAgeForced` stayed false for the whole session and an equal-length shell edit after a refresh had an *unbounded* loss window. `loadSnapshot` now re-arms the clock to `Date.now()` (regression test seeds a snapshot into IndexedDB and asserts `reason=age` fires after the interval).
- **P0-2 follow-up: the post-request `/cmd.json` delete could swallow a direct probe** — the `finally` deleted whatever was in the file; a watchdog `pingDirect` / Ctrl+C `interruptDirect` written (queue-bypassing) while the host was busy on a long Lifo/Python command was deleted instead of processed, so the watchdog could count a false failure (2 ⇒ spurious host restart). The delete now only fires when the file still holds the just-processed request id (`shouldRemoveCmdFile`, unit-tested); a newer out-of-band request is left for the next poll.
- TASK24 复审（re-review fixes; self-test gate 67 → **71**）: four new self-test checks —
  `cwd persisted to /etc/succinix.cwd (browser view)` (proves the session cwd is written to the
  browser-visible path, i.e. survives a snapshot + refresh), `env merged into node child
  (process.env)` (proves `/etc/succinix.env` merging actually reaches child processes),
  `python pipe filters empty (grep 2)` and `python pipe keeps match (grep 42)`
  (prove python pipelines are real). Scenario S11's pipeline check upgraded to real-pipe assertions
  (grep hit kept, grep miss → empty).
- TASK24 shell fusion fixes (three real-browser TS-ecosystem pitfalls + TASK23 leftover):
  - **Node-prefix commands with shell metacharacters now run through the Lifo shell** (pipes/chains/redirects parsed there), and each `node`/`npm`/`npx` segment in the chain is forwarded back to the **real binary** from the Lifo shell (new `registerRealBinaryCommands` in `src/engine/host.ts` overrides the in-browser JS-interpreter shims). `node --version && npm --version` → both real versions; `node -e "console.log(21*2)" | grep 42` → `42` (`runtime=lifo`). Pure node commands (no metachars) are unchanged (direct spawn).
  - **Tokenizer escape-quote fix** (shared `src/engine/tokenize.ts`, used by host + browser self-check): `\"` inside quotes → literal `"`, `\\` → `\`, `\'` in single quotes → `'`, unclosed quotes throw `unterminated quote in command` (no more silent truncation). `node -e "require('fs').writeFileSync('a.ts','import {x} from \"./m\"')"` now writes intact quotes.
  - **EACCES actionable hint**: `npm i -g` hitting read-only `/usr/local` appends `hint: /usr/local is read-only for guest. Install locally: npm i <pkg>  (or set a user prefix: npm config set prefix ~/.npm-global)` to the error output (permission semantics unchanged), in both the direct-spawn path and the Lifo-shell forwarding path.
  - Self-test Shell checks (gate 65 → **67**): `tokenize escape quotes`, `node pipe chain` (`... | grep 42`, runtime=lifo), `node && chain` (two version lines). Scenario S13 (TS ecosystem workflow: `npm i -D typescript tsx vitest` → `npx tsc` → `node dist/greet.js` → `npx vitest run` 1 passed) — now 13 scenarios.

### Fixed

- **Session cwd persistence double-root** (TASK24 复审): `CWD_FILE` was the node virtual system root `/etc/succinix.cwd` (read-only) — `cd` never survived a refresh. Now `${process.cwd()}/etc/succinix.cwd` (matches where the browser snapshot stores `/etc/succinix.cwd`), the parent dir is created before write, and the restore validates the mapped real directory exists (`/workspace/...` → `process.cwd()/...`).
- **`/etc` env + engine-config double-root** (TASK24 复审): `ENV_FILE` (`/etc/succinix.env`) and the engine-config read (`/etc/succinix.engine.json`) were also at the node virtual root → `env FOO=bar` never reached node/python children and the `resultTtlMs` override never applied. Both now read `${process.cwd()}/etc/...`. Self-test proves it: after `setEnvVar`, a `node -e "console.log(process.env.TEST_VAR)"` child sees the value.
- **Python fake pipes** (TASK24 复审): python commands containing shell metacharacters silently swallowed the pipe/redirect segments (`python -c "print(1)" | grep 2` printed `1` instead of the empty result). Python commands with shell metachars now run through the Lifo shell (like node), each python segment forwarded to the real runtime (`node python-runtime.js`). `python -c "print(1)" | grep 2` → empty; `python -c "print(42)" | grep 42` → `42` (runtime=lifo).
- **Tokenizer fd redirect forms** (TASK24 复审): `hasShellMetaToken` now flags glued `1>` / `1>>` / `2>>` / `&>` / `&>>` forms (previously only `>` / `>>` / `<` / `2>`).
- **Python asset path double-root** (TASK23 leftover, self-test `timeout: run`): the browser `wc.fs` root `/` maps to the host process cwd, but the host checked/loaded `PYTHON_RUNTIME_JS` at the node virtual system root `/usr/lib/...` → always "assets not injected yet" and the self-test hung on `cd /workspace` → node spawn. The python runtime path is now `${process.cwd()}/usr/lib/succinix/python/python-runtime.js` (matching where `python-assets.ts` injects), and absolute script paths (`python /script.py`) are resolved against the browser root.
- **Node/python spawn after `cd /workspace` hung** (same self-test `timeout: run` root cause, surfaced by the python-path investigation): `/workspace` is a Lifo VFS mount that has no real container path (root is read-only), so `spawn(node, { cwd: '/workspace' })` never resolves. The host now maps `/workspace/...` → `process.cwd()/...` (`spawnCwd()`) when spawning real node/python/npm children; `pwd`/`cwd` still report the Lifo view `/workspace/...`.

- TASK23 built-in language runtime system:
  - **Python runtime (system asset, 装不坏)**: `python` / `python3` run a bundled python-wasm 0.28 runtime (Python 3.11, stdlib incl. json/csv/re/math/os/sqlite3) as a real Node child process. `scripts/build-host.mjs` emits `public/python/python-runtime.js` (esbuild bundle, CommonJS so `__dirname` resolves the wasm assets) + `python.wasm`/`python-stdlib.zip`/`kernel.wasm`/`termcap`. It is lazily injected into the container on first use (`ensurePythonRuntime` in `src/engine/python-assets.ts`), never depends on a user `npm install`, and a load failure returns a clear `python runtime failed to load: ...` error without crashing the system. Interactive REPL and `pip` are intentionally not supported (documented).
  - **Session cwd sync (融合基石)**: the host maintains a session cwd (initial `process.cwd()`, persisted to `/etc/succinix.cwd` and restored on host start). A successful Lifo `cd` under the `/workspace` mount syncs the session cwd (the `run` result carries a `cwd` field); node/npm/npx **and** python child processes spawn with `cwd = session cwd` (previously `process.cwd()` fixed — `cd /ws/proj && npm install` used to install into the container root). `cd` to a missing directory keeps the session cwd unchanged. New `setCwd <dir>` protocol command for explicit sync. Browser `pwd` now shows the session cwd; the Lifo sandbox initial cwd is the `/workspace` mount so boot `pwd` matches.
  - **`lang` command**: lists built-in language runtimes and versions (`lang` table; `lang python` → `Python 3.11.1 (python-wasm 0.28)`; `lang node` queries the live node version; `lang typescript` notes `node --experimental-strip-types`).
  - Self-test additions (gate 57 → **59**): `python -c` real execution, python stdlib imports, `python3 --version`, `lang list` / `lang python` via dispatch, cd-syncs-session-cwd (node child cwd follows), failed-cd keeps session cwd. Measured **65 passed, 0 failed, 5 skipped**.
  - Scenario suite S11 (python script workflow: `-c`, script file, `python3` stdlib, pipeline `python | grep`) and S12 (cd + `npm install` lands in the session cwd; failed cd keeps node cwd) — now 12 scenarios.
  - **Fixed dev port 7892**: `scripts/start-dev.mjs` (checks whether 7892 is occupied and kills the owning PID before starting Vite), `package.json` `dev` → `node scripts/start-dev.mjs`, and `vite.config.ts` `server.strictPort: true` to prevent port drift.
  - Snapshot excludes `/usr/lib/succinix` (the ~13 MB python runtime system assets — re-injected on first use, not user data).

- TASK20 CI & standard test pipeline:
  - ESLint flat config (`eslint.config.js`) — `@eslint/js` + `typescript-eslint` recommended + project rules (`no-explicit-any` error, no leftover `console.log` warn with host-side exemption, no unused vars/imports); `npm run lint` gate is 0 errors.
  - Vitest unit-test suite (`tests/`, `vitest.config.ts`) covering the pure-logic modules `src/log.ts`, `persist.ts`, `services.ts`, `pkg.ts`, `motd.ts`, `config.ts` with an in-memory mock FS / fake IndexedDB / scriptable terminal client; v8 coverage gate **≥70%** on those core files (measured 90.62% stmts / 74% branches / 92.8% funcs / 93.46% lines).
  - GitHub Actions CI (`.github/workflows/ci.yml`): `check` job (lint → typecheck → unit tests + coverage → build → `verify-deploy` headless self-test) on push/PR, plus a scheduled `nightly-scenarios` job; CI badge added to the README.
  - `npm run test:e2e` (`scripts/run-e2e.mjs`): builds once, then runs `verify-deploy` → `bench` → `scenarios` sequentially — reusing the existing zero-dependency CDP scripts (no Playwright).
  - Optional zero-dependency pre-commit (`npm run setup:hooks` writes `.git/hooks/pre-commit` → `scripts/pre-commit.sh`: tsc + eslint on changed files only), documented in the README.
- TypeScript toolchain pinned to `~6.0.3` (dev-only): the `typescript-eslint` parser needs the classic compiler API that TypeScript 7 removed, so the dev typechecker stays on the 6.x line (runtime is unaffected).

### Changed

- `verify-deploy.mjs` self-test gate raised from `>=51` to `>=57` passed (matches the TASK19 regression additions).
- S6 scenario renamed to "queue serialization correctness" — it exercises the single-slot `/cmd.json` request queue, not true concurrency (honest naming).
- New npm scripts: `typecheck`, `lint`, `test`, `test:coverage`, `test:e2e`, `setup:hooks`.

### Fixed

- N1: `ensureNpxPackage` (services) and `dbStart` (commands) probed `node_modules/<pkg>` relative to the Lifo VFS root and always reported missing → now probe the absolute `/workspace/node_modules/<pkg>`; the redundant `npm install` + fake WARN is gone.
- N2: the persist dedup signature now includes the empty-directory list — a bare `mkdir` + refresh (an empty-dirs-only change) previously skipped the IDB write and lost the directory.
- N4: the self-test `spawn('npx definitely-not-exist-xyz')` is wrapped in try/catch with a shorter 2 s RPC timeout — offline / registry-hang no longer crashes the whole self-test; it degrades to a documented skip instead.

### Added

- TASK19 scenario suite: `scripts/scenarios.mjs` — a headless-Chrome/CDP driven real-workflow test suite (zero new deps, mirrors `verify-deploy.mjs`/`bench.mjs`) running 10 real scenarios against the real browser+container: S1 npm project dev loop (real HTTP 200 to the preview port), S2 git operations (`pkg install lifo-pkg-git` → init/add/commit/log with a real commit hash), S3 database full lifecycle (create table/insert/read via tinbase `/admin/v1/sql` + `/rest/v1`, data persists across `db stop`/`db start`), S4 service autostart (`service enable tinbase` survives a refresh and boots `running`; disable stops it), S5 multi-workspace isolation (files isolated per workspace, state retained after refresh), S6 concurrency stress (3 parallel long commands — per-id results not interleaved), S7 big output (`seq 1 10000` complete, 2 MB node output capped at 1 MB, no OOM), S8 persistence stress (300 files survive `snapshot now` + refresh, sampled content verified), S9 error paths (unknown command / missing dir / CORS curl all error cleanly in English), S10 environment boundary (`reboot` keeps files and a clean process table). `?scenario=1` exposes `window.__succinixScenario` (a `run()` that mirrors the real terminal dispatch path + `client`/`wc`/`ports`/`saveSnapshot`) for the driver.
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
- System configuration: `env` manages persistent environment variables (`/etc/succinix.env`, merged into real Node child processes at spawn time) and `settings` manages persistent system settings (`/etc/succinix.settings`: tinbase `preview-port` default 3001, `default-workspace` used at boot, `font-size` applied live to the terminal).
- Service management: `service` command family (`list`/`start`/`stop`/`status`/`enable`/`disable`) over the existing `spawn`/`ps`/`kill` + port registry, with declarative service definitions (`/etc/succinix.services`, `name|command|port`, `${PORT}` placeholder resolved from `preview-port`) and boot autostart (`/etc/succinix.autostart`, declarative restart at boot — not a daemon, no crash self-healing).
- Logging system (journald-style): persistent log at `/var/log/succinix.log` (container FS, rides snapshots; auto-truncates to a ~200 KB tail) capturing boot events (`BOOT`), command executions (`INFO` — `cmd: <command> exit=<code> runtime=<node|lifo|browser|protocol>`), service events (`INFO`/`WARN`), snapshot events (`INFO`) and errors (`ERROR`); `log` command family (`log` last 20, `log -n <count>`, `log boot`, `log clear`). Interactive `log -f` is deferred (POC).
- Virtual network view: `netstat` lists the virtual listening ports (port registry rendered as `Proto  Local Address  State`, `tcp 127.0.0.1:<port> LISTEN`; `netstat -p` adds the associated process — matched by port number in the process command, `-` when unmatched) and `ip addr` shows the browser's virtual network identity (`lo: virtual loopback`, `eth0: <preview-domain> (virtual)`). Everything is honestly labeled `virtual`; no fabricated interfaces, IPs, or connections.
- System information & login banner: `uname` reports the honest browser-native system identity — summary line `Succinix 0.2.0 js-runtime+webcontainer <api-version> <arch>` (kernel identified as `js-runtime+webcontainer`, never impersonating a Linux kernel), `-a` all fields with hostname/OS, `-r` the `@webcontainer/api` runtime version, `-m` the UA-derived architecture (`unknown` when absent) — and `motd` views/edits the persisted login banner at `/etc/succinix.motd` (`motd <text>` sets it, `motd reset` restores the default welcome line, printed at every boot).
- Package management: `pkg` command family (`list`/`search`/`install`/`remove`/`info`) unifying the two real channels — **lifo** (`lifo list`/`search`/`install`/`remove`, Lifo extension packages like `lifo-pkg-git`) and **npm** (real Node npm). Source auto-detection: `lifo-pkg-<name>` on npm → lifo, else npm; lifo wins on a name conflict. `pkg list` merges both channels with a `SOURCE` column, `pkg search` merges both searches, `pkg install`/`remove` echo the real command output. The npm list is read from `node_modules` top-level directories (top-level direct-install simplification — includes container preinstalled runtime deps, no dependency-tree parse).

### Changed

- Self-test results now reach the terminal: after the boot overlay fades, `?test=1` prints `Self-test result: N passed, M failed, K skipped` (plus the dark-red failure list when any test failed) into the shell, so results stay visible after the splash is gone.
- host.js is esbuild-minified (`minify: true`): 1,965,361 B → 1,070,913 B (−45.5%). Verified by a full `?test=1` pass against the minified bundle; the `keepNames: true` variant (1,106,353 B, −43.7%) was evaluated and not needed.
- RPC client robustness: all requests are serialized over the single-slot `/cmd.json` channel (fixes the pkg search parallel-channel race), read-only commands (`ping`/`ps`/`cwd`) retry once on transport failure, and a browser watchdog re-injects + respawns `host.js` after 2 consecutive failed pings (fresh process table, WARN log).
- Snapshot signature no longer counts `/var/log/succinix.log` (the log still rides snapshots; only the change-detection signature excludes it), so per-command log growth no longer forces a full snapshot rewrite.
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
- No `apt` / native binaries (physically impossible in the sandbox; Succinix is a browser-native Linux).
