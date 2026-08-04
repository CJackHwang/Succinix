# WebUnix — Agent & Design Guidelines

Design rules for anyone (human or AI agent) modifying this project. English text is normative; Chinese is explanatory.

## Design Spec

- **UI language: English only.** Every character rendered to the user (splash, system info, help, command output, errors, self-test, port/db info) must be English. Code comments may stay Chinese (developer docs), but never terminal-facing strings.
- **No emoji.** Emoji and pictorial glyphs are banned everywhere in the UI (`✅❌🎉🚀🔥…`). Use ASCII status markers only: `[  OK  ]` / `[ FAIL ]` / `[SKIP]`. Replace the unicode ellipsis `…` with `...` in user-facing text.
- **Theme: dark amber (no green).** `background: #0a0a0a`, foreground warm white `#d6cfc4`, cursor/accent dark orange `#c2702a`, selection `#3a2a1a`. ANSI palette is a muted warm set: red `#c0543a`, yellow/gold `#c98a2e`, green dark olive `#7a8a5a`, dim gray `#6b6560`, bright variants one step lighter. The `[  OK  ]` marker and ASCII-art splash use amber (`\x1b[33m`), not green. Never introduce a `GREEN` emphasis constant.
- **Font: JetBrains Mono.** Fonts are bundled locally via `@fontsource/jetbrains-mono` (no CDN). xterm `fontFamily`: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.
- **Professional and restrained; not toy-like.** Follow Linux conventions: prompt `guest@webunix:~$ `, `bash: xxx: command not found`-style errors, gray `[exit N]` markers, `PID  STATUS  COMMAND` ps table, English `unknown command: xxx`.

## Technical Constraints (do not change)

- **File RPC channel:** `/cmd.json` → `/result-<id>.json`, one independent result file per request. Do not revert to a single shared result file.
- **Unified routing:** commands starting with `node|npm|npx` go to a real Node child process; everything else goes to the Lifo sandbox. Do not change this split.
- **Dev server:** Vite on port `7892` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` (WebContainer requires cross-origin isolation).
- **tinbase:** must start with `--engine wasm --memory`; the in-browser install timeout is host-side `{ timeout: 120000 }`, client wait `150000`.
- **`scripts/build-host.mjs`:** `@lifo-sh/ui` stays external. Rebuild `public/host.js` with `node scripts/build-host.mjs` after touching `src/host.ts` or `src/host-procs.ts`.

## Quality Gates (must all pass before finishing)

- `npx tsc -p tsconfig.json --noEmit` → 0 errors
- `node scripts/build-host.mjs` → succeeds
- `npm run build` → succeeds
- Dev server starts at `localhost:7892` with COOP/COEP headers
- Static self-check: `grep -n '✅\|❌\|🎉\|GREEN' src/ index.html` → no matches
