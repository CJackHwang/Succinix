# Succinix

Succinix 是一个放在浏览器里的项目终端运行环境。它把工作区、终端、命令执行和文件保存配置好，网页应用不用再自己拼一套模拟终端。

## 这是什么

Succinix 运行在 WebContainer 中。Node.js、Python 和常用 Unix 命令看到的是同一份项目文件；浏览器只显示终端和传递输入。它也可以作为 Cordis 插件嵌入第三方应用。

## 有什么用

- 在浏览器中创建、编辑和运行项目，不要求本机安装 Node.js 或 Python。
- 用 `node`、`npm`、`npx`、`python`、`pip` 和常用 Unix 命令处理同一份文件。
- 启动开发服务并打开浏览器预览地址。
- 保存工作区、设置和快照，刷新后恢复。
- 为自己的 Cordis 插件提供文件、命令约束、终端会话和会话数据服务。

边界也很明确：只支持 Chromium；端口是浏览器预览地址，不是公网服务；Python 适合脚本执行，不提供通用 REPL；没有原生二进制、`apt` 或真正的权限隔离。

## 怎么用

### 直接运行

```bash
npm install
npm run dev
```

打开 `http://localhost:7892`，出现提示符后输入 `help`。常见流程：

```text
npm create vite@latest demo
cd demo
npm install
npm run dev
```

用 `ports` 查看预览地址，用 `snapshot save` 保存工作区，用 `succinix doctor` 检查环境。

### 嵌入自己的应用

先安装依赖，并把引擎资产复制到应用的静态目录。插件运行时会读取这些文件；只安装 npm 包不会自动把它们发布到浏览器。

```bash
npm install @succinix/engine@0.7.0 @deepseek-ai/cordis @webcontainer/api
mkdir -p public/engine
cp -R node_modules/@succinix/engine/assets/. public/engine/
```

然后配置插件、连接应用已启动的 WebContainer，并创建默认实例：

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

应用内的 Cordis 插件按需声明 `fs`、`sandbox`、`terminals`、`sessionPersistence`。只有需要管理生命周期、实例或端口时才使用 `ctx.get('succinix', false)`。

## 文档

- [能力说明](docs/FEATURES.md)：判断它能不能解决你的问题。
- [运行时说明](docs/LANGUAGES.md)：确认语言、包和已知限制。
- [接入说明](docs/SDK.md)：把 Succinix 接入 Cordis 应用。
- [第三方插件](docs/PLUGIN.md)：写使用 Succinix 的 Cordis 插件。
- [迁移说明](docs/MIGRATION.md)：从旧接入方式升级。
- [协议](docs/PROTOCOL.md) 与 [契约](docs/cordis-contract.md)：只在实现宿主、传输层或严格兼容时阅读。

## 开发校验

```bash
npx tsc -p tsconfig.json --noEmit
node scripts/build-host.mjs
npm run build
npm run lint
npm run test
npm run check:docs
```

完整质量门禁见 [AGENTS.md](AGENTS.md)。
