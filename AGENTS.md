# Succinix — Agent & Design Guidelines

Design rules for anyone (human or AI agent) modifying this project. English text is normative; Chinese is explanatory.

## Design Spec

- **UI language: English only.** Every character rendered to the user (splash, system info, help, command output, errors, self-test, port/db info) must be English. Code comments may stay Chinese (developer docs), but never terminal-facing strings.
- **No emoji.** Emoji and pictorial glyphs are banned everywhere in the UI (`✅❌🎉🚀🔥…`). Use ASCII status markers only: `[  OK  ]` / `[ FAIL ]` / `[SKIP]`. Replace the unicode ellipsis `…` with `...` in user-facing text. **Scope: terminal/UI text and code output** — documentation (`docs/*.md`) may use status glyphs (`✅`/`⚠️`/`❌`) in tables where they aid readability; the static self-check below scans `src/` and `index.html` only.
- **Theme: dark amber (no green).** `background: #0a0a0a`, foreground warm white `#d6cfc4`, cursor/accent dark orange `#c2702a`, selection `#3a2a1a`. ANSI palette is a muted warm set: red `#c0543a`, yellow/gold `#c98a2e`, green dark olive `#7a8a5a`, dim gray `#6b6560`, bright variants one step lighter. The `[  OK  ]` marker and ASCII-art splash use amber (`\x1b[33m`), not green. Never introduce a `GREEN` emphasis constant.
- **Font: JetBrains Mono.** Fonts are bundled locally via `@fontsource/jetbrains-mono` (no CDN). xterm `fontFamily`: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.
- **Professional and restrained; not toy-like.** Follow Linux conventions: prompt `guest@succinix:~$ `, `bash: xxx: command not found`-style errors, gray `[exit N]` markers, `PID  STATUS  COMMAND` ps table, English `unknown command: xxx`.

## Technical Constraints (do not change)

- **File RPC channel:** `/cmd.json` → `/result-<id>.json`, one independent result file per request. Do not revert to a single shared result file.
- **Unified routing:** commands starting with `node|npm|npx` go to a real Node child process; everything else goes to the Lifo sandbox. Do not change this split.
- **Dev server:** Vite on port `7892` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` (WebContainer requires cross-origin isolation).
- **tinbase:** must start with `--engine wasm`（no `--memory` — data persists in the workspace snapshot; the in-browser install timeout is host-side `{ timeout: 120000 }`, client wait `150000`).
- **`scripts/build-host.mjs`:** `@lifo-sh/ui` stays external. Produces two in-container bundles: `public/host.js` (lightweight host daemon — RPC loop, process table, node subprocesses) and `public/lifo-core.js` (the ~1 MB `@lifo-sh/core` kernel, loaded lazily via `import('./lifo-core.js')` on first Lifo command). Rebuild with `node scripts/build-host.mjs` after touching files under `src/engine/host/`, `src/engine/host-procs.ts`, or `src/engine/lifo-core.ts`.

## Cordis Single-Track (0.5.0+)

- `@succinix/engine@0.5.0` is a Cordis plugin; the root export is
  `{ name: 'succinix', apply, Config }`. There is no separate SDK API line and
  no `plugin-*` second package.
- Consumers must declare `inject: ['succinix']` or use `ctx.get('succinix', false)`;
  do not rely on implicit globals or top-level `ctx.mixin`.
- All services are exposed under `ctx.succinix` (`state/container/executor/terminal/snapshot/persist/workspace/ports/services/capabilities/instance`). See `docs/PLAN-cordis.md` §2.2 for the contract.
- Only `src/plugin/` may import `cordis`; `src/engine`, `src/terminal`,
  `src/instance`, `src/persist`, and `src/services` must stay Cordis-free.
- `./terminal` and `./instance` are no longer package exports; use
  `ctx.succinix.terminal.create` / `ctx.succinix.ensureInstance`.
- The page-level HostManager is a module singleton; fiber reload must not
  restart the host. `shutdown()` or page unload is the only hard host teardown.
- Rebuild the engine package with `node scripts/build-engine-package.mjs` after
  touching `src/plugin/`; it regenerates `assets/sha256.json` and validates the
  exports snapshot.

## Explicitly Not Implemented (do not force)

Browser-environment limits are accepted as-is. Do not build simulations with no real value; if a capability cannot genuinely work, it is omitted or clearly degraded:

- **Multi-user / login / permission isolation.** Organizational isolation only (available in embed mode): directories, state, and process views are partitioned per instance/user (`?instance=<id>` / `?user=<id>`); this is **not a security boundary** — there is no real kernel or permission bits. A login ritual without real isolation still has no value; `guest` remains the only user of the standalone app, and permission-bit / `chmod` semantics stay out.
- **Permission-bit management (`chmod` semantics).** Simulated modes add no value; do not fake them.
- **Real kernel / apt / native binaries.** Physically impossible in the sandbox. Succinix is a browser-native Linux (JS runtime + Lifo userland).
- **Inbound external networking.** Ports are virtual previews; tunnels are outbound bridges, not real inbound.
- **Direct external `curl` without CORS.** Use `https://r.jina.ai/<url>`-style proxies.
- **Interactive stdin (REPL-style processes).** Unreliable in WebContainer (verified); file-based RPC replaces it.
- **symlinks / hard links.** Not supported by the Lifo VFS.
- **Firefox / Safari / mobile.** WebContainers does not support them; the environment-check error page explains requirements instead.
- **Precise OS-level memory/CPU stats.** Only estimates are available; always mark with `~` and an `(estimated ...)` footnote. Never present estimates as exact.

## Quality Gates (must all pass before finishing)

- `npx tsc -p tsconfig.json --noEmit` → 0 errors
- `node scripts/build-host.mjs` → succeeds
- `npm run build` → succeeds
- `npm run check:plugin-boundaries` → core dirs have no `cordis` imports and
  every `src/plugin/` file carries an invariant marker
- `npm run check:engine-package` → builds the package, writes
  `assets/sha256.json`, validates exports, and runs `npm pack --dry-run`
- Dev server starts at `localhost:7892` with COOP/COEP headers
- Static self-check: `grep -n '✅\|❌\|🎉\|GREEN' src/ index.html` → no matches
