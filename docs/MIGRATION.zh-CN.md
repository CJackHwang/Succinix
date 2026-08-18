# Succinix 0.7.0 迁移说明

[English](MIGRATION.md)

## 这是什么

这是给已经接入旧版 `@succinix/engine` 的应用的升级清单。0.7.0 是 Cordis 插件：普通消费代码使用四个服务，同一上下文中的宿主入口负责管理执行世界。

## 最重要的变化

| 旧做法 | 0.7.0 做法 |
| --- | --- |
| `createTerminalExecutor()` 或独立 `./terminal`、`./instance` 导出 | 安装插件后用 `host.ensureInstance()` |
| 通过旧 `ctx.succinix.*` 命名空间取得日常运行能力 | 使用 `ctx.fs`、`ctx.sandbox`、`ctx.terminals`、`ctx.sessionPersistence` |
| 把 `onServerReady`、`onServerClosed` 写在配置里 | 使用 `host.onServerReady()`、`host.onServerClosed()` 或 `succinix/*` 事件 |
| 不提供 host 资产 | 将包内 assets 目录复制到应用静态目录并设置 URL |
| 旧的批处理客户端 | 使用插件的执行器；手写传输时遵守 RPC v2 |

`ctx.get('succinix', false)` 仍用于宿主生命周期、实例、端口和默认执行器；它不替代四个日常服务。

## 怎么升级

### 1. 替换依赖和资产

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
mkdir -p public/engine
cp -R node_modules/@succinix/engine/assets/. public/engine/
```

### 2. 用插件替换旧构造函数

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
```

### 3. 改服务依赖

```ts
export const inject = ['fs', 'sandbox', 'terminals', 'sessionPersistence']
```

文件操作交给 `ctx.fs`；命令约束交给 `ctx.sandbox`；终端会话交给 `ctx.terminals`；插件会话事件交给 `ctx.sessionPersistence`。宿主的执行器、实例、端口和服务仍通过 `ctx.get('succinix', false)` 取得。

### 4. 核对生命周期

- 应用自己创建 WebContainer 时，使用 `external` + `host.attach(wc)`。
- 希望插件创建 WebContainer 时，使用 `internal` + `host.boot()`。
- `dispose()` 默认不会停止页面级 host；需要彻底停止时调用 `shutdown()`。
- 配置只放可序列化数据。端口和命令事件改为订阅 host 方法或 `succinix/*`。

## 不能兼容的地方

- RPC v2 不与旧批处理客户端兼容。
- `./terminal`、`./instance` 子路径和独立 SDK 导出已移除。
- 真实 Node 子进程不能通过 `ctx.sandbox` 获得每次调用的安全隔离。
- 页面级 host 不会因普通 fiber 热更新而重启；需要重启的配置变更会先关闭旧 host。

升级后运行 [cordis-app 示例](../examples/cordis-app/README.zh-CN.md) 或 `node scripts/cordis-app-e2e.mjs`。[接入说明](SDK.zh-CN.md)定义当前行为。
