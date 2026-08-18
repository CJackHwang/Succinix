# Changelog

[简体中文](CHANGELOG.zh-CN.md)

This changelog keeps changes that affect users and integrators. Git history keeps development logs, test output, and per-commit detail.

## 0.7.0

### What Changed

- Succinix is now integrated as the `@succinix/engine` Cordis plugin.
- Consumer plugins use `fs`, `sandbox`, `terminals`, and `sessionPersistence`; the host uses `ctx.get('succinix', false)` for WebContainer, instances, and execution.
- The browser terminal, Node, Python, and Unix commands share one WebContainer workspace.
- Workspaces use the current snapshot persistence; old storage is recognized but never automatically migrated or deleted.
- Engine assets must be published as static files. See [Integration](docs/SDK.md).

### Read Before Upgrading

- For old SDKs, old service names, or old RPC clients, read [Migration](docs/MIGRATION.md).
- To decide whether Succinix fits, read [README](README.md) and [Features](docs/FEATURES.md).
- To validate a packed integration, read the [Cordis contract](docs/cordis-contract.md).
