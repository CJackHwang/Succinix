# Cordis App Contract Example

[简体中文](README.zh-CN.md)

## What It Is

This is an independent third-party application. It uses only the packed `@succinix/engine`, never Succinix source, so it proves that another application can integrate the actual release artifact.

## What It Checks

It checks plugin installation, the four Cordis services, command execution, files, terminals, session persistence, instances, ports, services, snapshots, reload behavior, and asset integrity.

## How To Run It

From the repository root:

```bash
npm run build:engine-package
node scripts/cordis-app-e2e.mjs
```

To inspect it manually:

```bash
cd examples/cordis-app
npm install
npm run build
npm run preview
```

Open `http://localhost:7895/` and wait for the result summary. The example copies packed host, Lifo, and Python assets into its own static directory, matching a real third-party integration.
