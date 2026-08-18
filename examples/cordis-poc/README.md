# Cordis And WebContainer Smoke Test

[简体中文](README.zh-CN.md)

## What It Is

This small browser page verifies that `@deepseek-ai/cordis@4.0.1` can run with WebContainer and can provide and consume the four dsh service keys through Cordis.

## How To Run It

```bash
npx vite --config examples/cordis-poc/vite.config.ts
```

This is a compatibility smoke test, not an integration example. For actual third-party integration, see [the Cordis app example](../cordis-app/README.md).
