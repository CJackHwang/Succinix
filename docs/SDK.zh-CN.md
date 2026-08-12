# Succinix Engine — Cordis 插件集成

> 状态：**0.5.0 插件形态（发布就绪）**。`@succinix/engine` 是一个 Cordis
> 插件，也是唯一对外集成面。旧的 0.4.0 独立 SDK 导出（`createTerminalExecutor`、
> `./terminal`、`./instance`）已移除；迁移见 [MIGRATION.md](MIGRATION.md)。

`@succinix/engine` 让任意 Cordis 应用在 WebContainer 内获得浏览器原生 Unix
沙箱：真实 Node 运行时（`node|npm|npx`）、内置 Pyodide Python
（`python|python3|pip|pip3`），以及处理其余命令的 Lifo Unix 用户态。容器文件系统
与宿主应用共享。

本文档是集成参考。线上协议见 [PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md)，能力矩阵见
[FEATURES.zh-CN.md](FEATURES.zh-CN.md)，第三方插件开发见
[PLUGIN.md](PLUGIN.md)。

## 安装

```bash
npm install @succinix/engine@0.5.0
npm install cordis @webcontainer/api   # peer dependencies
```

`@succinix/engine` 要求 `cordis >= 4.0.0-rc.8` 与
`@webcontainer/api ^1.6.4`。

## 快速开始

```ts
import { Context } from 'cordis';
import engine from '@succinix/engine';
import { WebContainer } from '@webcontainer/api';

const ctx = new Context();
const fiber = ctx.plugin(engine, {
  container: { mode: 'external' },
  defaultInstance: {
    instanceId: 'default',
    persistence: { dbName: 'my-app', storeKey: 'default' },
  },
  terminal: { timeoutMs: 120000, bootGate: false },
});
await fiber;

const wc = await WebContainer.boot();
await ctx.succinix.attach(wc);
await ctx.succinix.ensureInstance('default', { executor: {} });

const node = await ctx.succinix.executor.exec('node -e "console.log(1+1)"');
const lifo = await ctx.succinix.executor.exec('grep -i foo file.txt');

await ctx.succinix.shutdown();
await fiber.dispose();
```

插件以 `succinix` 注册；消费方声明 `inject: ['succinix']`，或用
`ctx.get('succinix', false)` 探测。发布物 `.d.ts` 会增强
`Context['succinix']` 与 Cordis `Events`。

## 包导出

```jsonc
{
  "exports": {
    ".": {
      "types": "./dist/plugin/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./host.js": "./assets/host.js",
    "./lifo-core.js": "./assets/lifo-core.js",
    "./assets/*": "./assets/*",
    "./package.json": "./package.json"
  }
}
```

- `.` 是插件入口：`{ name: 'succinix', apply, Config }`，并导出类型。
- `./host.js`、`./lifo-core.js`、`./assets/*` 是 host daemon、Lifo 内核、
  Pyodide 运行时与 `sha256.json` 的静态资产。
- 0.5.0 没有 `./terminal` 或 `./instance` 子路径。

## 容器模式

### 内部模式（internal）

插件自行启动 WebContainer，带重试：

```ts
const wc = await ctx.succinix.boot({
  instanceId: 'default',
  executor: {},
});
```

### 外部模式（external）

宿主应用拥有 WebContainer，并交给插件。插件仍负责注入 `host.js`、spawn host
daemon 并等待就绪：

```ts
const wc = await WebContainer.boot();
await ctx.succinix.attach(wc, { executor: {} });
```

`attach()` 与 `boot()` 互斥；容器就绪后切换模式会抛 `ERR_MODE_MISMATCH`。

## 配置

`SuccinixConfig` 只含可序列化字段，且同步校验；函数一律通过服务参数或事件订阅
注入。

```ts
export interface SuccinixConfig {
  hostJsUrl?: string;        // 默认 '/host.js'
  lifoCoreUrl?: string;      // 默认 '/lifo-core.js'
  pythonAssetsUrl?: string;  // 默认 '/pyodide/'
  resultTtlMs?: number;
  container?: {
    mode?: 'internal' | 'external';
    bootRetries?: number;
    bootIntervalMs?: number;
    hostReadyDeadlineMs?: number;
  };
  defaultInstance?: {
    instanceId?: string;
    statePrefix?: string;
    home?: string;
    persistence?: { dbName?: string; storeKey?: string };
  };
  terminal?: {
    cwd?: string;
    timeoutMs?: number;
    bootGate?: boolean;
    history?: boolean;
    tabComplete?: boolean;
    interrupt?: boolean;
    promptPrefix?: string;
  };
  capabilities?: {
    defaultAllow?: boolean;
    rules?: Array<{ pattern: string; allow: boolean }>;
  };
  lifecycle?: {
    disposeMode?: 'soft' | 'hard';
    flushOnPageHide?: boolean;
  };
  assets?: {
    integrity?: boolean;     // 默认 true
  };
}
```

非法值产生 `ValidationError`；插件保留上次有效配置，并在
`ctx.succinix.state.lastError` 记录原因。

## 服务面

`ctx.succinix` 是完整服务契约：

| 成员 | 作用 |
| --- | --- |
| `state` | 插件状态：版本、容器、host、实例、能力、`configRevision`、`lastError` |
| `container` | 当前容器句柄：`mode`、`state`、`wc`、`hostPid`、`startedAt` |
| `executor` | 默认实例 `TerminalExecutor`：`exec`、`spawn`、`listProcesses`、`kill`、`ping`、`pingDirect`、`interruptDirect`、`respawn` |
| `terminal` | `terminal.create(output, opts?)` 返回无 UI 终端会话 |
| `snapshot` | 默认实例快照：`save`、`restore`、`meta`、`clear` |
| `persist` | 持久化上下文（快照键、强制保存） |
| `workspace` | `restore`、`flush`、`list`，以及 `stateRoot`、`home` |
| `ports` | `list`、`ready`、`expect`、`release`、`hasConflict`、`onServerReady`、`onServerClosed` |
| `services` | 声明式服务管理：`list`、`read`、`status`、`start`、`stop`、`enable`、`disable`、`add`、`remove`、`autostart`、`ensureFiles` |
| `capabilities` | 本地能力注册表：`check`、`list`、`define` |
| `instance` | 默认 `SuccinixInstance`，未创建时为 `null` |
| `boot` | 启动内部 WebContainer |
| `attach` | 接管外部 WebContainer |
| `ensureInstance` | 创建或复用实例（替代 `createSuccinixInstance`） |
| `getInstance` | 读取已创建实例 |
| `releaseInstance` | 释放并移除实例 |
| `listProcesses` | 默认或指定实例的进程表快照 |
| `on` | 类型化领域事件订阅 |
| `onServerReady` / `onServerClosed` | 端口事件订阅 |
| `dispose` | 软收尾（fiber dispose） |
| `shutdown` | 完全关闭（kill host） |
| `reconfigure` | 校验并应用新配置 |

默认实例未创建时访问 `executor`、`snapshot`、`persist`、`workspace` 或
`services` 会快速失败，并附带 state 原因。

## 实例

`ensureInstance(containerId, opts)` 在共享页面 host 上创建按实例栈：

```ts
const alice = await ctx.succinix.ensureInstance('alice', {
  home: '/workspace/alice',
  persistence: { dbName: 'my-app', storeKey: 'alice' },
  executor: {},
});

await alice.executor.exec('node -v');
await alice.snapshot.save(true);
await alice.workspace.flush('manual');
```

实例状态根、快照键、服务/端口视图与进程视图按 `containerId` 分区。这是组织性
隔离，不是安全边界。

## 终端会话

宿主负责渲染。`TerminalOutput` 只有两个方法：

```ts
const session = ctx.succinix.terminal.create({
  write: (data) => term.write(data),
  clear: () => term.clear(),
});

term.onData((data) => session.handleData(data));
await session.boot();
```

`SuccinixTerminalSession` 负责历史、Tab 补全、命令队列、Ctrl+C 中断与
cwd 跟随提示符；不依赖 xterm。

## 端口与服务

端口事件经 `succinix/server-ready`、`succinix/server-closed` 或便捷订阅
到达：

```ts
ctx.succinix.onServerReady(({ port, url, instanceId }) => {
  app.recordPreview(port, url, instanceId);
});
```

`ctx.succinix.ports` 是 canonical 页面级视图；spawn 前用 `expect(port)` /
`release(port)` 把端口归属到实例。

声明式服务用 `ctx.succinix.services` 管理：

```ts
await ctx.succinix.services.ensureFiles();
await ctx.succinix.services.add('web', 'node server.js', 3001);
const start = await ctx.succinix.services.start('web');
const status = await ctx.succinix.services.status('web');
await ctx.succinix.services.stop('web');
```

## 能力（capability）

插件自带轻量能力注册表，模式集合如下：

```text
terminal.exec, terminal.spawn, terminal.kill, terminal.interrupt,
fs.read, fs.write, workspace.restore, workspace.flush, workspace.list
```

```ts
if (!ctx.succinix.capabilities.check('terminal.exec')) {
  throw new Error('execution is not allowed');
}

const dispose = ctx.succinix.capabilities.define('fs.write', () => isAllowed());
```

宿主若提供 `capability` 服务，插件会把同一组模式注册进去。默认放行；
`capabilities.defaultAllow` 与 `capabilities.rules` 可覆盖。

## 生命周期与热重载

- HostManager 是页面级模块单例，不属于 Cordis fiber。
- fiber reload（`fiber.update`）重新执行 `apply`，但不重启 host；
  `ctx.succinix.state.host.startedAt` 保持不变。
- `dispose()` 默认软收尾：释放实例与订阅，host 保留。
- `shutdown()` 强制 flush、kill host、清页面注册表，并置
  `containerState` 为 `disposed`。
- `lifecycle.disposeMode: 'hard'` 让 fiber dispose 同时关闭 host。
- `pagehide` / `beforeunload` 触发 shutdown；`flushOnPageHide` 只 flush
  快照而不关机。
- `reconfigure(next)` 同步校验、递增 `configRevision` 并广播
  `succinix/state`（`reason: 'config'`）。改变 host 资产路径或容器模式的
  配置会先执行 shutdown。

## 事件

类型化事件可通过 `ctx.succinix.on` 或 Cordis `ctx.on` 消费：

| 事件 | 载荷 |
| --- | --- |
| `succinix/state` | `{ state, reason, changed }` |
| `succinix/server-ready` | `{ port, url?, instanceId? }` |
| `succinix/server-closed` | `{ port, instanceId? }` |
| `succinix/command` | 命令 telemetry：id、实例、runtime、exit、duration |
| `succinix/instance` | `{ containerId, state: 'created' \| 'released' }` |
| `succinix/workspace` | `{ instanceId, reason, savedAt? }` |
| `succinix/process` | `{ instanceId, processes }`（轮询聚合） |

## 资产与完整性

包内带 `assets/host.js`、`assets/lifo-core.js`、`assets/pyodide/*` 与
`assets/sha256.json`。可作为静态文件服务，或用 Vite 导入：

```ts
import hostJsUrl from '@succinix/engine/host.js?url';
import lifoCoreUrl from '@succinix/engine/lifo-core.js?url';

const fiber = ctx.plugin(engine, {
  hostJsUrl,
  lifoCoreUrl,
  pythonAssetsUrl: '/pyodide/',
});
```

`assets.integrity: true`（默认）会在注入前用 `sha256.json` 校验
`host.js` 与 `lifo-core.js`。

## 要求与边界

- 仅 Chromium（Chrome/Edge）；WebContainers 不支持 Firefox、Safari 与移动端。
- 页面必须跨源隔离：`Cross-Origin-Opener-Policy: same-origin` 与
  `Cross-Origin-Embedder-Policy: credentialless`。
- 端口是虚拟 preview，没有真实入站网络。
- 无交互式 REPL stdin；文件 RPC 是唯一通道。
- Lifo 不支持符号链接 / 硬链接。
- 不模拟 `chmod` 与权限位。
- 无精确 OS 级内存/CPU 统计；估算值必须标注。

## 相关文档

- [MIGRATION.md](MIGRATION.md) — 0.4.0 到 0.5.0 迁移指南
- [PLUGIN.md](PLUGIN.md) — 第三方 Cordis 插件接入
- [cordis-contract.md](cordis-contract.md) — 权威契约快照
- [PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md) — 文件 RPC 线上契约（v1）
- [FEATURES.zh-CN.md](FEATURES.zh-CN.md) — 支持能力清单
