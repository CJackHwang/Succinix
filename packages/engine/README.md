# @succinix/engine

`@succinix/engine` 是把 Succinix 接入 Cordis 应用的插件。它让你的网页应用获得一个浏览器内项目终端：可以管理文件、执行命令、创建终端会话并保存会话数据。

## 这有什么用

你不需要自己实现文件系统、命令路由、终端和持久化。插件连接 WebContainer 后，Node、Python 和 Unix 命令使用同一个工作区。

## 怎么用

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
```

```ts
import { Context } from '@deepseek-ai/cordis'
import engine from '@succinix/engine'
import { WebContainer } from '@webcontainer/api'

const ctx = new Context()
const fiber = ctx.plugin(engine, { container: { mode: 'external' } })
await fiber

const host = ctx.get('succinix', false)!
await host.attach(await WebContainer.boot())
await host.ensureInstance('default', { executor: {} })
await host.executor.exec('npm run dev')
```

应用内插件需要文件、命令约束、终端或会话保存时，声明：

```ts
export const inject = ['fs', 'sandbox', 'terminals', 'sessionPersistence']
```

`ctx.get('succinix', false)` 用于宿主生命周期、实例、端口和执行器管理；日常能力优先使用上述四个服务。

## 接入前确认

- 使用 `@deepseek-ai/cordis@4.0.1`。
- 只支持 Chromium，页面必须启用 COOP/COEP。
- 端口是浏览器预览地址，不是公网服务。

完整服务字段、资产打包与生命周期规则请阅读仓库中的 [SDK.md](../../docs/SDK.md)。旧版本升级请阅读 [MIGRATION.md](../../docs/MIGRATION.md)。
