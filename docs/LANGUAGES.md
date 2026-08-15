# Succinix Language Ecosystem — Verified Support Matrix

> **Authoritative, measurement-based.** Every status below is backed by a reproducible
> measured source — a check id from `scripts/lang-verify.mjs` (`LV·P1` … `LV·R3`), the
> `?test=1` self-test (`ST`), or a scenario in `scripts/scenarios.mjs` (`S11`, `S13`, `S14`).
> Nothing is speculative; run `npm run test:e2e` to reproduce every number.

Status legend:

- ✅ **measured working** — a real browser/container execution returned the expected result
- ⚠️ **partial / probe** — runs with documented caveats, or a feasibility probe recorded an outcome
- ❌ **not available** — confirmed absent (real execution, not assumed)

Measured environment: headless Chrome (CDP) driving a WebContainer; `node` 22.22.3 / `npm`
10.8.2 inside the container (source `LV·N1`); the built-in Python runtime is the resident
**Pyodide 314.0.4** daemon bundling Python **3.14.2** (source `LV·P1`). Version numbers are
**observed values, not gated assertions** — they drift silently when WebContainer upgrades its
bundled Node or the pinned Pyodide asset changes.

---

## 1. Language runtime matrix

| Language | Command | Runtime | Version (measured) | Package install | Measured status | Source |
| -------- | ------- | ------- | ------------------ | --------------- | --------------- | ------ |
| **Python** | `python`, `python3` | built-in resident **Pyodide 314.0.4** daemon (spawned as a node child, instance reused across commands) | 3.14.2 | ✅ **pip** — micropip; pure-Python wheels persist across refresh, compiled wheels re-install after refresh (`LV·P6`) | ✅ | `LV·P1–P9`, `S11`, `ST` |
| **pip** | `pip`, `pip3` | maps to Pyodide micropip (`python -m pip` also works) | micropip 0.11.1 | ✅ install / uninstall / list / show | ✅ | `LV·P6`, `S11`, `ST` |
| **Node.js** | `node` | real Node.js (WebContainer runtime) | 22.22.3 | ✅ npm, local per-project installs | ✅ | `LV·N1–N5`, `S13`, `S14`, `ST` |
| **npm** | `npm` | real npm (ships with node) | 10.8.2 | ✅ local; ❌ global (`/usr/local` read-only → EACCES + hint) | ✅ | `LV·N1`, `LV·N4`, `S14`, `ST` |
| **TypeScript** | `npx tsc`, `tsx`, `vitest` | npm-installed toolchain; node 22 `--experimental-strip-types` | latest via npm | ✅ via npm | ✅ | `LV·N3`, `S13`, `S14` |
| **Ruby** | (none built-in) | `@ruby/wasm-wasi` v2 + `@ruby/head-wasm-wasi` (probe only) | head ruby.wasm | ✅ npm install; ❌ **no gem** | ⚠️ probe — runs, not integrated | `LV·R1` |
| **C** | `gcc` | none | — | — | ❌ confirmed absent | `LV·R2` |
| **Rust** | `rustc`, `cargo` | none | — | — | ❌ confirmed absent | `LV·R2` |
| **Go** | `go` | none | — | — | ❌ confirmed absent | `LV·R2` |
| **WASI** | `node:wasi` | Node.js WASI (preview1) | node 22 | — | ✅ can run precompiled WASI modules | `LV·R3` |

### Python standard-library matrix

Measured by `LV·P5` (a real python script imports each module and reports OK/BAD) and
`LV·P7` / additional probes. `import` is green for all 11; run behavior is split as noted.

| Module | Import | Real behavior |
| ------ | ------ | ------------- |
| `json` | ✅ | works — `json.dumps({'a':1})` → `{"a": 1}` (`LV·P5` import, `LV·P8` behavior) |
| `csv` | ✅ | imports (`LV·P5`) |
| `re` | ✅ | imports (`LV·P5`) |
| `math` | ✅ | imports (`LV·P5`) |
| `os` | ✅ | imports; `os.getcwd()` maps to the session cwd (container root via NODEFS) (`LV·P3`) |
| `sqlite3` | ✅ | works — in-memory DB create/insert/select (`LV·P5`; probe: `count(*)` → `1`) |
| `subprocess` | ✅ import / ❌ run | imports (`LV·P5`); **spawn NOT implemented** — `subprocess.run(...)` → `OSError: [Errno 138] emscripten does not support processes` (Pyodide has no OS process API; `LV·P8`) |
| `collections` | ✅ | imports (`LV·P5`) |
| `datetime` | ✅ | imports (`LV·P5`) |
| `hashlib` | ✅ | imports (`LV·P5`) |
| `urllib` | ✅ | imports (`LV·P5`); actual network requests are subject to the external-net/CORS boundary |

---

## 2. Ecosystem scenario assessment

Replacement degree for real development scenarios, measured end-to-end.

| Scenario | Language | Replacement degree | Evidence |
| -------- | -------- | ------------------ | -------- |
| Std-lib scripting / data processing (JSON/CSV/regex/math/files/sqlite3) | Python | **~85%+** | 11/11 stdlib imports green (`LV·P5`), sqlite3 + json verified live (`LV·P7`), **pip works** (micropip: `pip install pyparsing` → import, `LV·P6`, `S11`) and pure-Python wheels **persist across refresh** (`S11`). Remaining gaps: no REPL, no subprocess, compiled wheels need re-install after refresh. |
| Scientific computing (numpy) | Python | **~80%+** | `pip install numpy` → `import numpy` → `numpy.dot([[1,2],[3,4]],...)` → `[[7, 10], [15, 22]]` (`LV·P9`, `S11`). Compiled `.so` files are not carried by the text snapshot → after refresh numpy needs one `pip install numpy` again (boundary, `S11`). |
| Full TypeScript development loop (install → compile → test → run) | Node/TS | **~80%+** | `npm i -D typescript tsx vitest` → `tsc` → `node dist/*.js` → `vitest run 1 passed` (`LV·N3`, `S13`); `node -e` nested-quote writes survive tokenization and tsc (`LV·N2`, `S14`); npm installs into the session cwd (`LV·N5`, `S14`). |
| Frontend/service runtime (http servers, package scripts) | Node | **~85%+** | Real node spawn + preview URL registration + `ps`/`kill` lifecycle (`S1`, `ST`); `node --version && npm --version` chain works (`LV·N1`, `S14`). |
| Global CLI tools (`npm i -g`) | npm | **❌** | `/usr/local` is read-only; EACCES with an actionable hint (`LV·N4`, `S14`). Install locally instead. |
| Ruby scripting | Ruby | **probe — feasible, not integrated** | `@ruby/wasm-wasi` v2 runs Ruby WASM in-container (`6*7` → `42`, `LV·R1`). Not wired into `lang`/routing (retention); usable today only via a manual node script. |
| Native builds (C/Rust/Go) | C/Rust/Go | **❌** | No compilers (`LV·R2`). Precompiled **WASI** binaries do run via `node:wasi` (`LV·R3`), but there is no in-sandbox toolchain to build them. |

---

## 3. Known boundaries

Measured, environment-level constraints — not bugs.

- **pip persistence is best-effort**: pure-Python wheels (e.g. `pyparsing`) persist across a
  refresh — the site-packages directory is mounted (NODEFS) to `/.pyodide/site-packages`, which
  the text snapshot carries. **Compiled wheels (e.g. `numpy`) need one `pip install <pkg>` after a
  refresh**: their `.so` files are binary, the snapshot is text-only, so the incomplete package is
  dropped at daemon start to avoid a broken `import` (documented boundary, `S11`).
- **`python -m <module>`**: only `python -m pip ...` is special-cased to micropip. Other modules
  run via `runpy.run_module` (`LV·P6`).
- **`subprocess`**: imports but cannot spawn — Pyodide raises
  `OSError: [Errno 138] emscripten does not support processes` (`LV·P8`).
- **Python REPL**: not implemented; interactive stdin is unreliable in WebContainer. Use
  `python -c "<code>"` / `python <script.py>` / `python -m pip <cmd>` (AGENTS.md boundary).
- **First `python` command is slow**: the ~13 MB Pyodide runtime (wasm + stdlib zip) is lazily
  injected on first use, and the resident daemon does a one-time `loadPyodide`; subsequent
  commands reuse the instance (`LV·P1` first-run timing, `ST`).
- **npm global installs**: `/usr/local` is read-only for the guest. npm fails with
  `EACCES` and an appended hint line (`hint: /usr/local is read-only for guest.
  Install locally: npm i <pkg> ...`) (`LV·N4`, `S14`). Permission semantics unchanged.
- **No C/Rust/Go compilers**: `which gcc/rustc/go` all report not found (`LV·R2`).
- **WASI**: precompiled WASI modules run under `node:wasi` (`LV·R3`), but building them
  requires an external toolchain; the sandbox ships none.
- **Ruby**: probe only. The v2 `@ruby/wasm-wasi` API (`@ruby/wasm-wasi/dist/node`) works,
  but Ruby is not a routed/built-in runtime and has no gem installer (`LV·R1`).
- **External network**: `urllib` / `curl` to CORS-less hosts fail; use a CORS-friendly
  proxy (e.g. `https://r.jina.ai/<url>`) (AGENTS.md boundary; `ST`).
- **`/workspace` path mapping**: Lifo's `/workspace` is a VFS view of the browser-FS root;
  real node/python children see the mapped real path. Shell operations should use
  `/workspace/...`, browser-FS reads use `/...` (`S12`, `S13`, `LV·N5`).

---

## 4. How to reproduce

```bash
npm run test:e2e                     # build once, then: verify-deploy → bench → scenarios → lang-verify → instance-demo → instance-routing → cordis-app
node scripts/lang-verify.mjs         # language ecosystem verification (P1–P9, N1–N5, R1–R3)
node scripts/scenarios.mjs --only S11 # python workflow + pip + persistence, or full S1–S14
# self-test: open <deploy>/?test=1  → "7? passed, 0 failed, ? skipped" (gate >= 71)
```

These files are the single source of truth for this matrix — any change to the support
matrix must come from an updated measurement in `lang-verify.mjs`, the self-test, or a
scenario, never from assumption.
