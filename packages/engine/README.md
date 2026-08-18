# @succinix/engine

`@succinix/engine` 是把 Succinix 接入 Cordis 应用的插件。它为网页应用提供浏览器内的项目工作区：可以管理文件、执行命令、创建终端会话并保存会话数据。

## 有什么用

你不需要自己实现文件系统、命令路由、终端和持久化。插件连接 WebContainer 后，Node、Python 和 Unix 命令会使用同一个工作区。

## 怎么用

安装后，先把包内资产提供为应用的静态文件：

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
mkdir -p public/engine
cp -R node_modules/@succinix/engine/assets/. public/engine/
```

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
})
await fiber

const host = ctx.get('succinix', false)!
await host.attach(await WebContainer.boot())
await host.ensureInstance('default', { executor: {} })
await host.executor.exec('npm run dev')

await host.shutdown()
await fiber.dispose()
```

应用内插件需要文件、命令约束、终端或会话保存时，声明：

```ts
export const inject = ['fs', 'sandbox', 'terminals', 'sessionPersistence']
```

`ctx.get('succinix', false)` 用于宿主生命周期、实例、端口和执行器管理；日常能力优先使用上述四个服务。

## 接入前确认

- peer 依赖是 `@deepseek-ai/cordis ^4.0.1` 与 `@webcontainer/api ^1.6.4`。
- 只支持 Chromium，页面必须启用 COOP/COEP。
- 端口是浏览器预览地址，不是公网服务。

完整字段与生命周期规则见 [SDK.md](../../docs/SDK.md)，旧版本升级见 [MIGRATION.md](../../docs/MIGRATION.md)。
