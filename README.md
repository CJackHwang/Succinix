# Succinix

Succinix 是一个放在浏览器里的项目终端运行环境。它给网页应用接入一个已经配置好的工作区、终端、命令执行和文件持久化能力，不需要自己再拼一套模拟终端。

## 这是什么

它运行在 WebContainer 中：Node.js、Python 和常用 Unix 命令看到的是同一份项目文件。浏览器只负责显示终端和接收输入，命令、文件、进程和服务都在同一个运行环境里工作。

Succinix 也可以作为 Cordis 插件嵌入第三方应用。对接方得到的是一个可执行、可保存的浏览器项目环境，而不是一组需要自行组合的底层零件。

## 有什么用

- 在浏览器中创建、编辑和运行项目，无需本机安装 Node.js 或 Python。
- 使用 `node`、`npm`、`npx`、`python`、`pip` 及常见 Unix 命令处理项目文件。
- 启动开发服务并打开浏览器预览地址。
- 刷新页面后保留工作区、设置和已保存的快照。
- 把同一套终端、文件和运行环境交给自己的 Cordis 插件或网页应用使用。

已知边界：仅支持 Chromium 浏览器；端口是浏览器预览地址，不是公网入站服务；Python 适合执行脚本，不提供通用交互式 REPL；没有原生二进制、`apt` 或真实权限隔离。

## 怎么用

### 直接运行

```bash
npm install
npm run dev
```

打开 `http://localhost:7892`，出现提示符后输入 `help`。一个最小项目流程如下：

```text
npm create vite@latest demo
cd demo
npm install
npm run dev
```

在终端中用 `ports` 查看已启动服务的预览地址。常用命令：

- `snapshot save`：立即保存工作区。
- `workspace create <名称>`：新建独立工作区。
- `db start`：启动浏览器内的 Postgres 数据库。
- `succinix doctor`：检查当前环境是否可用。

### 嵌入自己的应用

安装插件和运行环境依赖：

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
```

把插件装进 Cordis，连接应用已经启动的 WebContainer，然后执行项目命令：

```ts
import { Context } from '@deepseek-ai/cordis'
import engine from '@succinix/engine'
import { WebContainer } from '@webcontainer/api'

const ctx = new Context()
const fiber = ctx.plugin(engine, {
  container: { mode: 'external' },
  defaultInstance: {
    instanceId: 'default',
    persistence: { dbName: 'my-app', storeKey: 'default' },
  },
})
await fiber

const wc = await WebContainer.boot()
const host = ctx.get('succinix', false)!
await host.attach(wc)
await host.ensureInstance('default', { executor: {} })
await host.executor.exec('npm run dev')
```

应用内的 Cordis 插件按需声明 `fs`、`sandbox`、`terminals`、`sessionPersistence` 服务；只有需要管理 Succinix 生命周期、实例或端口时才使用 `ctx.get('succinix', false)`。

## 文档

- [能力说明](docs/FEATURES.md)：适合先判断能不能解决你的问题。
- [语言与运行时](docs/LANGUAGES.md)：适合确认某个运行时是否可用及其限制。
- [接入参考](docs/SDK.md)：适合把 Succinix 接入 Cordis 应用。
- [第三方插件](docs/PLUGIN.md)：适合编写使用 Succinix 服务的插件。
- [迁移说明](docs/MIGRATION.md)：适合从旧版本接入方式升级。
- [协议与契约](docs/PROTOCOL.md) / [Cordis 契约](docs/cordis-contract.md)：仅在实现宿主、传输层或严格兼容时阅读。

## 开发校验

```bash
npx tsc -p tsconfig.json --noEmit
node scripts/build-host.mjs
npm run build
npm run lint
npm run test
npm run check:docs
```

发布前还需要执行仓库中的完整质量门禁；详见 `AGENTS.md`。
