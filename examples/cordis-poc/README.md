# dsh WebContainer POC

Minimal Vite page proving `@deepseek-ai/cordis@4.0.1` can run alongside
`@webcontainer/api` in a browser bundle, with dsh service keys
(`fs` / `sandbox` / `terminals` / `sessionPersistence`) through provide/inject,
synchronous StandardSchema config validation, and real Node execution inside a
WebContainer.

```sh
npx vite --config examples/cordis-poc/vite.config.ts
```
