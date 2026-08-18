# Succinix 接入说明

[English](SDK.md)

## 这是什么

`@succinix/engine` 是 DeepSeek Harness Cordis 的插件。安装后，应用得到一个浏览器内的项目运行环境：文件、命令、终端会话和保存的数据都围绕同一个 WebContainer 工作区工作。

## 有什么用

你可以把一个可执行、可保存的项目终端交给自己的网页和 Cordis 插件，而不用分别维护浏览器文件、命令、进程和终端状态。

| 需要做的事 | 使用哪个服务 |
| --- | --- |
| 读写项目文件 | `ctx.fs` |
| 生成受约束的 Lifo 命令参数 | `ctx.sandbox` |
| 创建和管理终端会话 | `ctx.terminals` |
| 保存插件自己的会话事件 | `ctx.sessionPersistence` |
| 管理 WebContainer、实例、端口和执行器 | `ctx.get('succinix', false)` |

前四项是普通消费方应声明的服务。最后一项是同一 Cordis 上下文中的宿主接口，不是替代前四项的万能服务。

## 怎么接入

### 1. 安装并提供资产

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
mkdir -p public/engine
cp -R node_modules/@succinix/engine/assets/. public/engine/
```

静态服务器必须能访问 `host.js`、`lifo-core.js`、`sha256.json` 和 `pyodide/`。页面还必须发送 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: credentialless`。

### 2. 安装插件并启动实例

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

const result = await host.executor.exec('node -e "console.log(1 + 1)"')
console.log(result.stdout)
```

`container.mode: 'external'` 表示 WebContainer 由你的应用创建；如果希望插件自行创建，把它改为 `'internal'`，然后调用 `host.boot()`，不要再调用 `attach()`。两种模式不能混用。

### 3. 在其他插件中使用服务

```ts
export const inject = ['fs', 'sandbox', 'terminals', 'sessionPersistence']

export function apply(ctx) {
  // ctx.fs、ctx.sandbox、ctx.terminals、ctx.sessionPersistence 已可使用。
}
```

服务是可选能力时，用 `ctx.get('fs', false)` 探测；不要依赖隐式全局变量。

## 使用时要知道

- `node`、`npm`、`npx` 使用真实 WebContainer Node；Python 使用内置 Pyodide；其余常见 Unix 命令由 Lifo 提供。它们共用文件。
- `ctx.sandbox.confine()` 只生成受约束的 Lifo 参数，不会执行命令。真实 Node 子进程不能按单次调用隔离，因此会明确失败。
- 终端会话按 `Agent` 所有者隔离。创建会话前用 `host.registerAgent(agent)` 登记，结束后注销；没有隐式 `guest` 所有者。
- `dispose()` 默认只卸载当前 Cordis fiber，`shutdown()` 才会停止页面级 host。
- 端口是浏览器预览地址；实例隔离用于组织项目，不是安全边界。

完整类型以安装包导出的 `.d.ts` 为准。仓库中的 [Cordis 契约](cordis-contract.zh-CN.md) 由独立示例在真实浏览器运行验证；需要改公开行为时，先改该示例和测试，再改这里。

旧版本接入请看[迁移说明](MIGRATION.zh-CN.md)，自定义插件看[第三方插件](PLUGIN.zh-CN.md)，自己实现传输层才看[协议](PROTOCOL.zh-CN.md)。
