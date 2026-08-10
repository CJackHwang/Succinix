# Contributing to Succinix

Thanks for your interest in contributing. This project aims for a professional, production-grade browser-native Linux environment. Please read [AGENTS.md](AGENTS.md) first — it codifies the design rules every contribution must follow.

## Development Setup

Requirements: Node.js 20+, npm.

```bash
npm install
npm run dev          # start the dev server on http://localhost:7892
```

The dev server is configured with the `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers that WebContainers require. Do not change the port or remove these headers.

## Project Layout

```
src/
  main.ts            # entry: xterm terminal, REPL, boot orchestration (assembly layer)
  boot.ts            # boot sequence, system info, self-checks (demo ?instance=/?user= paths)
  commands.ts        # browser-side commands (help/ports/db/...)
  tests.ts           # self-test suite (?test=1)
  engine/            # TerminalExecutor engine (decoupled, reusable — see README Ecosystem)
    index.ts         # public API: createTerminalExecutor / bootEngineHost / waitForHostReady + types
    client.ts        # file-RPC client, TerminalClient (was terminal-client.ts)
    host.ts          # TerminalExecutor daemon, runs inside WebContainer
    host-route.ts    # host pure logic: routing / path mapping / per-instance filtering + kill authorization
    host-procs.ts    # unified process registry
  terminal/          # terminal SDK (UI-free session + parameterized boot; packaged as @succinix/engine/terminal)
  instance/          # instance factory (createSuccinixInstance; packaged as @succinix/engine/instance)
scripts/build-host.mjs
```

## Design & Coding Standards

See [AGENTS.md](AGENTS.md) for the full rules. Highlights:

- **UI language**: all user-facing output is English.
- **No emoji**: never use emoji or pictographic symbols in UI text, output, or comments that render in the terminal. Use ASCII status markers (`[  OK  ]`, `[FAIL]`, `[SKIP]`).
- **Theme**: dark-amber palette, no green accents. See AGENTS.md for exact color values.
- **Font**: JetBrains Mono (bundled via `@fontsource/jetbrains-mono`, no CDN).
- **Code comments**: Chinese is fine for developer-facing comments; identifiers are English.
- **TypeScript**: strict mode is required.
- **Production feel**: restrained, professional. No toy-like styling.

## Protocol & Architecture Constraints

These invariants must not be broken:

- **File RPC**: `/cmd.json` -> `/result-<id>.json`. Each request gets its own result file. Never revert to a single shared result file (it caused a lost-response race, see commit history).
- **Routing**: commands starting with `node`, `npm`, or `npx` go to a real Node.js child process; everything else goes to the Lifo sandbox.
- **Unified filesystem**: the browser `wc.fs`, Node child processes, and Lifo all share one filesystem via WebContainer's virtualized `node:fs`. Do not introduce a filesystem bridge.
- **Database**: tinbase must be started with `--engine wasm` (no `--memory` — data persists in the workspace snapshot); installation timeouts must pass the host-side `{ timeout: 120000 }` option (client wait 150000).
- **Multi-instance / multi-user**: organizational isolation only — per-instance/per-user state, snapshots and process views; never a security boundary. Do not add a login ritual or fake permission bits.

## Quality Gates

All of the following must pass before a pull request is merged:

```bash
npx tsc -p tsconfig.json --noEmit   # 0 errors
node scripts/build-host.mjs         # host bundle builds
npm run build                       # production build succeeds
```

Runtime verification (manual, in a browser):

1. `npm run dev` and open `http://localhost:7892`.
2. Confirm the boot sequence and self-checks complete, then the prompt appears.
3. Run the full self-test suite via `http://localhost:7892/?test=1`.
4. Spot-check a real Node command (`node -e "console.log(1+1)"`) and a Lifo command (`grep` on a file) in the terminal.
5. Ensure no emoji appear anywhere in the UI output.

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add port forwarding registry
fix(host): avoid result overwrite race
docs: update architecture diagram
refactor(tests): adopt self-test format
chore: bump dependencies
```

Keep commits focused and atomic. Reference the relevant TASK file when applicable.

## Pull Request Process

1. Create a feature branch from `main` (`git checkout -b feat/your-change`).
2. Implement with tests where applicable; run the quality gates above.
3. Push and open a pull request describing the change, why it matters, and how you verified it.
4. Keep the diff reviewable — split large changes into multiple PRs.
5. A maintainer will review; address feedback and re-run the gates.

## Questions

Open an issue for bugs and feature requests. For design questions, refer to [AGENTS.md](AGENTS.md) and the [README](README.md) architecture section.
