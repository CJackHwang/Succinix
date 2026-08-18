# 编写 Succinix 第三方插件

[English](PLUGIN.md)

## 这是什么

这是给 Cordis 插件作者的说明。你的插件可以使用 Succinix 已经提供的文件、终端和会话保存能力，而不用自己再实现一套浏览器终端。

## 怎么开始

先声明真正需要的服务：

```ts
export const inject = ['fs', 'sandbox', 'terminals', 'sessionPersistence']
```

只需要其中一部分就只声明那部分。服务可选时使用 `ctx.get('fs', false)`，未安装 Succinix 时应关闭对应功能或给出自己的处理方式。

## 哪个能力该怎么用

| 需求 | 正确做法 | 不要做 |
| --- | --- | --- |
| 操作项目文件 | 用 `ctx.fs` 的目标、版本和读写方法 | 直接假设浏览器有另一份文件系统 |
| 约束 Lifo 命令 | 用 `ctx.sandbox.confine(argv, policy)` 取得执行参数 | 把它当成真实 Node 子进程的安全隔离 |
| 做交互工具 | 用 `ctx.terminals` 和登记过的 `Agent` | 在浏览器另写 Shell、编辑器或 TUI 状态 |
| 保存插件会话 | 用 `ctx.sessionPersistence` 的追加事件 | 把可恢复状态塞进临时浏览器内存 |
| 启动服务或查看端口 | 由宿主通过 `ctx.get('succinix', false)` 管理 | 把端口当成公网入站服务 |

Succinix 的执行世界在 WebContainer 中。命令、文件、进程、服务和交互应用应在这里扩展；浏览器代码只负责显示、输入和不可避免的 Web API。

## 最小示例

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-succinix-plugin'
export const inject = ['fs']

export async function apply(ctx: Context) {
  const file = await ctx.fs.resolve('/workspace/hello.txt')
  await ctx.fs.writeText(file, 'hello')
}
```

实际接口参数、错误码和终端所有权规则以 `@succinix/engine` 导出的类型为准。文件写入需要遵守版本和 sandbox policy；终端操作需要先登记 `Agent`，否则会被拒绝。

## 如何验证

仓库的 [cordis-app 示例](../examples/cordis-app/README.zh-CN.md)只消费已打包的引擎，不导入仓库源码。改公开服务、生命周期、资产或类型后，运行：

```bash
npm run build:engine-package
node scripts/cordis-app-e2e.mjs
```

需要完整接入步骤看[接入说明](SDK.zh-CN.md)，旧代码升级看[迁移说明](MIGRATION.zh-CN.md)，传输细节看[协议](PROTOCOL.zh-CN.md)。
