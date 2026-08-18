# Succinix

[简体中文](docs/README.zh-CN.md)

Succinix is a project terminal environment that runs in the browser. It gives a web app one configured workspace, terminal, command runner, and persistence layer instead of asking it to imitate a terminal in the UI.

## What It Is

Succinix runs inside WebContainer. Node.js, Python, and common Unix commands see the same project files; the browser only renders the terminal and forwards input. It can also be embedded in another application as a Cordis plugin.

## What It Is For

- Create, edit, and run projects in the browser without a local Node.js or Python installation.
- Use `node`, `npm`, `npx`, `python`, `pip`, and common Unix commands on the same files.
- Start development servers and open their browser preview URLs.
- Save workspace state, settings, and snapshots across refreshes.
- Give Cordis plugins file access, command confinement, terminal sessions, and session persistence.

The limits are deliberate: Chromium only; ports are browser previews, not public services; Python runs scripts but has no general REPL; native binaries, `apt`, and real permission isolation are unavailable.

## How To Use It

### Run the standalone app

```bash
npm install
npm run dev
```

Open `http://localhost:7892`, then enter `help`. A typical workflow is:

```text
npm create vite@latest demo
cd demo
npm install
npm run dev
```

Use `ports` to find the preview URL, `snapshot save` to keep the workspace, and `succinix doctor` to check the environment.

### Embed it in an application

Install the dependencies and publish the engine assets as static files. Installing the npm package alone does not make those files available to the browser.

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
mkdir -p public/engine
cp -R node_modules/@succinix/engine/assets/. public/engine/
```

Configure the plugin, attach the WebContainer created by the application, then create the default instance:

```ts
import { Context } from '@deepseek-ai/cordis'
import engine from '@succinix/engine'
import { WebContainer } from '@webcontainer/api'

const ctx = new Context()
const fiber = ctx.plugin(engine, {
  hostJsUrl: '/engine/host.js',
  lifoCoreUrl: '/engine/lifo-core.js',
  pythonAssetsUrl: '/engine/pyodide/',
  container: { mode: 'external' },
  defaultInstance: {
    instanceId: 'default',
    persistence: { dbName: 'my-app', storeKey: 'default' },
  },
})
await fiber

const host = ctx.get('succinix', false)!
await host.attach(await WebContainer.boot())
await host.ensureInstance('default', { executor: {} })
await host.executor.exec('npm run dev')
```

Application plugins explicitly inject `fs`, `sandbox`, `terminals`, and `sessionPersistence` as needed. Use `ctx.get('succinix', false)` only when managing the host lifecycle, instances, ports, or executor.

## Documentation

- [Features](docs/FEATURES.md): decide whether Succinix fits the task.
- [Runtimes](docs/LANGUAGES.md): supported languages, packages, and limits.
- [Integration](docs/SDK.md): embed Succinix in a Cordis application.
- [Third-party plugins](docs/PLUGIN.md): write a Cordis plugin that uses Succinix.
- [Migration](docs/MIGRATION.md): upgrade older integrations.
- [Protocol](docs/PROTOCOL.md) and [contract](docs/cordis-contract.md): only for host, transport, or strict compatibility work.

## Development Checks

```bash
npx tsc -p tsconfig.json --noEmit
node scripts/build-host.mjs
npm run build
npm run lint
npm run test
npm run check:docs
```

See [AGENTS.md](AGENTS.md) for the complete quality gates.
