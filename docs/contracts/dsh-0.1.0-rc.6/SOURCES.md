# dsh 0.1.0-rc.6 Contract Snapshot

This directory vendors the official service-definition type surface consumed by
Succinix 0.6.0. It is the immutable baseline for the dsh-native migration; do
not overwrite it in place when a newer dsh release appears. Create a new
versioned directory instead.

## Packages

| Package | Version | Tarball SHA-256 | npm integrity (SHA-512, base64) |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-fs` | `0.1.0-rc.6` | `05e417749b3223b99853e20d0fe17878d015620450d50b784d8342ba50c3d83b` | `OTkwb4QsZgmjtA/8ZEPh1FapmrBr3N989/G4Wmo1JkAvKbMxkYty6LxjckOawTTz7GJTfUoZCrw9uopDfIMMNw==` |
| `@deepseek-ai/dsh-sandbox` | `0.1.0-rc.6` | `1c145d643317410c9671f499ddc0d150287d5d1997b88b83838277a398f1e35c` | `SLZjuivQQKHTx4H7xlsjraEGGMIEA8BYOwvlm/9uZBrBrlttMU+d8Ne6QYpDcOwIEubL8mvrWRg8j3rtY3lVyA==` |
| `@deepseek-ai/dsh-terminal` | `0.1.0-rc.6` | `34ee32b4e38aa0c67ed8546abbd6c39782410a7b6021930073ad81ba3b7bc1a3` | `riHLAQhXJJ2TT9XrDWGMgJf21RBqQgSZdEVvG4+xGEf9NZWcoszxdp+KW7rpwfrKuuD70p8RHCPGW4gCQPA+/A==` |
| `@deepseek-ai/dsh-session-persistence` | `0.1.0-rc.6` | `f7cac1268c69575b107d7900c7203ca300b439f713a6b5ac9469401f8eadff89` | `AbNBe+IYCbZqSHqOACVdj8QTynm2HZ0cThrEuI6nGMtlWLYLx6lzZ1rgO/56Av9mIScjyTBGJAIKhEYaMTBG9g==` |

The tarballs were resolved from the npm registry on 2026-08-14. If a local
`/tmp/dsh-cores` copy is missing, re-fetch the exact versions above and verify
the SHA-256 checksum before committing new copies.

## Copied Files

- `dsh-fs/`: `index.d.ts`, `types.d.ts`, `invariant.d.ts`, `README.md`, `LICENSE`
- `dsh-sandbox/`: `index.d.ts`, `escalation.d.ts`, `roots.d.ts`, `invariant.d.ts`, `README.md`, `LICENSE`
- `dsh-terminal/`: `index.d.ts`, `types.d.ts`, `invariant.d.ts`, `README.md`, `LICENSE`
- `dsh-session-persistence/`: `index.d.ts`, `coordinator.d.ts`, `revision.d.ts`, `write-behind.d.ts`, `preparations.d.ts`, `invariant.d.ts`, `README.md`, `LICENSE`
- `dependencies/dsh-agent/`: `index.d.ts`, `runtime-types.d.ts`, `types.d.ts`
- `dependencies/dsh-session/`: `index.d.ts`, `types.d.ts`, `preparation.d.ts`, `json.d.ts`, `known-event-types.d.ts`, `request-header.d.ts`, `surface.d.ts`
- `dependencies/dsh-llm/`: `error.d.ts`, `brand.d.ts`

## Peer Graph

All four service packages peer on `@deepseek-ai/cordis@^4.0.1`. The full peer
graph from the vendored `package.json` manifests is:

| Package | Peer dependencies |
| --- | --- |
| `dsh-fs` | `@deepseek-ai/dsh-brand`, `@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-sandbox`, `@deepseek-ai/cordis` |
| `dsh-sandbox` | `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-invariants`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-session` |
| `dsh-terminal` | `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-brand`, `@deepseek-ai/dsh-invariants`, `@deepseek-ai/cordis` |
| `dsh-session-persistence` | `@deepseek-ai/dsh-brand`, `@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-timeout`, `@deepseek-ai/cordis` |

Succinix does not install these packages at runtime. It vendors the type
surface, implements the service shapes locally, and keeps the Cordis fork as the
single dependency baseline.

## License

All vendored files are copied from MIT-licensed npm packages published by
DeepSeek. See the `LICENSE` file beside each package directory. The original
copyright notices are preserved in the upstream files; this repository adds no
license terms to them.
