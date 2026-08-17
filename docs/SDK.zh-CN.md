# Succinix Engine — dsh Cordis 集成参考

> 状态：**0.7.0 dsh 服务提供方（发布就绪）**。`@succinix/engine` 是面向
> `@deepseek-ai/cordis@4.0.1` 的 Cordis 插件，也是唯一对外集成面。它提供 dsh
> 服务键 `ctx.fs`、`ctx.sandbox`、`ctx.terminals` 与
> `ctx.sessionPersistence`。旧的 0.4.0 独立 SDK 导出（`createTerminalExecutor`、
> `./terminal`、`./instance`）与 0.5.0 的单键 `succinix` 服务均已移除；
> 见 [MIGRATION.md](MIGRATION.md)。

`@succinix/engine` 为任意 dsh 兼容 Cordis 应用提供浏览器原生 Unix 执行世界：
WebContainer 内真实 Node 运行时（`node|npm|npx`）、内置 Pyodide Python、Ruby WASM、
WASI adapter，以及处理其余命令的 Lifo Unix 用户态。批处理 RPC 与交互终端共用同一
实例级 SandboxContext、文件系统、cwd/env、进程、包与服务状态。

本文是集成参考。线上协议见 [PROTOCOL.md](PROTOCOL.md)，能力矩阵见
[FEATURES.md](FEATURES.md)，第三方插件开发见 [PLUGIN.md](PLUGIN.md)。

## 安装

```bash
npm install @succinix/engine@0.7.0
npm install @deepseek-ai/cordis @webcontainer/api   # peer dependencies
```

`@succinix/engine` 要求 `@deepseek-ai/cordis ^4.0.1` 与
`@webcontainer/api ^1.6.4`。

## 快速开始

```ts
import { Context } from '@deepseek-ai/cordis';
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
const host = ctx.get('succinix', false)!;
await host.attach(wc);
await host.ensureInstance('default', { executor: {} });

const node = await host.executor.exec('node -e "console.log(1+1)"');
const lifo = await host.executor.exec('grep -i foo file.txt');
await host.shutdown();
await fiber.dispose();
```

插件注册名为 `succinix`，并提供四个 dsh 服务。消费方声明
`inject: ['fs', 'sandbox', 'terminals', 'sessionPersistence']`，或用
`ctx.get('fs', false)` 探测。发布物 `.d.ts` 会增强 `@deepseek-ai/cordis` 的
`Context` 与 `Events`。

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

- `.` 是插件入口：`{ name: 'succinix', apply, Config }`，外加 dsh 类型与
  host seam 类型。
- `./host.js`、`./lifo-core.js`、`./assets/*` 是 host daemon、Lifo 内核、
  Pyodide 运行时与 `sha256.json` 的静态资产。
- 0.7.0 没有 `./terminal` 或 `./instance` 子路径。

## 公开 dsh 服务

四个公开服务键以 dsh 0.1.0-rc.6 形状为准，vendored 契约在
[`docs/contracts/dsh-0.1.0-rc.6/`](contracts/dsh-0.1.0-rc.6/SOURCES.md)：

| 键 | 契约 | Succinix 行为 |
| --- | --- | --- |
| `ctx.fs` | 12 原语、13 个 `FS_*` 错误码、`sandboxMode` | canonical `/workspace` 执行世界路径、原子文本/字节读写、version guard、sandbox policy 围栏 |
| `ctx.sandbox` | 同步 `confine(argv, policy)` | 返回 Lifo wrapper argv 与 `enforcement: 'full'`；`node|npm|npx` 以 `SANDBOX_UNAVAILABLE` fail-closed |
| `ctx.terminals` | owner 隔离的 PTY registry | 精确 `Agent` owner、固定信号白名单、每 session 单 in-flight send、幂等 `kill` |
| `ctx.sessionPersistence` | event-sourced session log | 实例状态根下的 append-only JSONL、raw artifact、只截尾 repair、source-qualified revision |

从 `@succinix/engine` 导入发布类型：

```ts
import {
  FsError,
  SandboxUnavailableError,
  TerminalError,
  SessionId,
  SessionPersistenceCorruptionError,
  type FileSystem,
  type SandboxProvider,
  type TerminalSessionService,
  type SessionPersistence,
} from '@succinix/engine';
```

### `ctx.fs`

浏览器执行世界暴露 `FileSystem`：`resolve`、`processPath`、`fileUrl`、
`contains`、`stat`、`lstat`、`readText`、`streamText`、`readBytes`、
`listDir`、`writeText`、`editText`。

- `resolve(path, opts?)` 返回不透明 `targetKey` 与展示路径；消费方不得解析
  `targetKey`。
- `stat` / `lstat` 对不存在目标返回 `undefined`。
- `readBytes` 必选 `signal` 与 `maxBytes`；超限抛 `FS_TOO_LARGE`，绝不截断返回。
- `writeText` / `editText` 接受可选 `sandboxPolicy`；`read-only` 拒绝一切变更，
  `workspace-write` 只允许写入策略的 `workspaceRoot` 内。
- outcome 的 `before` / `after` 统一 LF 规范化，作为同一 diff basis。
- `sandboxMode` 为 `'workspace-write'`：未显式传 policy 时，变更默认限定在
  workspace root。

### `ctx.sandbox`

`confine(argv, policy)` 同步且 fail-closed：

- 只接受 `read-only` 与 `workspace-write` 两种 `SandboxPolicy`。
- 运行时传入 `danger-full-access` 一律拒绝。
- 真实 `node|npm|npx` argv 无法按调用围栏，抛 `SandboxUnavailableError`
  （`SANDBOX_UNAVAILABLE`）。
- Lifo argv 包装为 `['succinix-sandbox', '--mode', mode, '--workspace', root,
  ...argv]`，并附带 Lifo 方言 denial signatures 与 runner failure rules。
- wrapper 是执行世界替换，不是桌面 sandbox，也不是安全边界；shell 脚本内可
  嵌套调用其他命令。

### `ctx.terminals`

`TerminalSessionService` 按 owner 隔离，要求精确 `Agent`：

```ts
const agent: Agent = { id: SessionId('agent-1'), status: 'idle', ctx: {} };
host.registerAgent(agent);

const session = await ctx.terminals.spawn(agent, {
  type: 'succinix',
  name: 'shell-1',
});
const send = ctx.terminals.startSend(agent, session.sessionId, {
  text: 'echo hello',
  submit: true,
});
const result = await send.done;
const view = ctx.terminals.read(agent, session.sessionId, { count: 100 });
await ctx.terminals.kill(agent, session.sessionId, 'done');
host.unregisterAgent(agent);
```

不存在隐式 `guest` owner。未注册 owner 抛 `OWNER_NOT_LIVE`；跨 owner 访问抛
`FOREIGN_SESSION`。会话是 process-local 的，host 重启不恢复。

### `ctx.sessionPersistence`

`SessionPersistence` 是存储于 `/workspace/.succinix/sessions` 的 append-only
事件日志（JSONL）：

- `create(meta)` 可 lazy：从未 append 的 session 不进入 `list` /
  `listSnapshots`。
- `append(id, events)` 要求连续 `seq`，并拒绝非 JSON 可序列化的事件数据。
- `load` 只修复尾部残缺行，从不重写完整日志。
- `inspect` 只读，不 commit repair。
- `supportsRawArtifacts` 为 true，`readRaw` 返回逐字 artifact。
- durability 为 WebContainer 文件系统写入 + 主动 snapshot flush；跨页面重载
  是 best-effort，不是崩溃级硬保证。

## Host seam

`succinix` 是内部生命周期与应用可观测 seam，不是 dsh 服务键。可信的
同 Context 消费方可探测：

```ts
const host = ctx.get('succinix', false);
if (!host) throw new Error('succinix is not available');
```

seam 暴露：

| 成员 | 用途 |
| --- | --- |
| `state` | 插件状态：version、container、host、instances、capabilities、`configRevision`、`lastError` |
| `container` | 当前容器句柄：`mode`、`state`、`wc`、`hostPid`、`startedAt` |
| `executor` | 默认实例 `TerminalExecutor`：`exec`、`spawn`、`listProcesses`、`kill`、`ping`、`pingDirect`、`interruptDirect`、`respawn` |
| `terminal` | `InteractiveTerminalService`：`open({ instanceId, cols, rows })` 打开执行世界终端 |
| `snapshot` | 默认实例的 `save`、`restore`、`meta`、`clear` |
| `persist` | 持久化上下文（快照键、强制保存） |
| `workspace` | `restore`、`flush`、`list`，以及 `stateRoot` / `home` |
| `ports` | `list`、`ready`、`expect`、`release`、`hasConflict`、`onServerReady`、`onServerClosed` |
| `services` | 声明式服务：`list`、`read`、`status`、`start`、`stop`、`restart`、`enable`、`disable`、`add`、`remove`、`autostart`、`ensureFiles` |
| `capabilities` | 本地能力注册表：`check`、`list`、`define` |
| `instance` | 默认 `SuccinixInstance` 或 `null` |
| `boot` | 启动内部 WebContainer |
| `attach` | 接管外部 WebContainer |
| `ensureInstance` | 创建/复用实例（替代 `createSuccinixInstance`） |
| `getInstance` | 读取已有实例 |
| `releaseInstance` | 释放并移除实例 |
| `registerAgent` / `unregisterAgent` | 维护 `ctx.terminals` 使用的 live-agent 集合 |
| `listProcesses` | 默认或具名实例的进程表快照 |
| `on` | 类型化 `succinix/*` 事件订阅 |
| `onServerReady` / `onServerClosed` | 端口事件订阅 |
| `dispose` | 软收尾（fiber dispose） |
| `shutdown` | 硬收尾（kill host） |
| `flush` | 对每个 live 实例做 best-effort 快照 flush |
| `reconfigure` | 校验并应用新配置 |

默认实例存在前访问 `executor`、`terminal`、`snapshot`、`persist`、
`workspace` 或 `services` 会以 state-backed 错误快速失败。

## 容器模式

### 内部模式

插件自行启动 WebContainer（带重试）：

```ts
const wc = await host.boot({
  instanceId: 'default',
  executor: {},
});
```

### 外部模式

宿主应用拥有 WebContainer 并交给插件。插件仍注入 `host.js`、拉起 host
daemon 并管理 host readiness：

```ts
const wc = await WebContainer.boot();
await host.attach(wc, { executor: {} });
```

`attach()` 与 `boot()` 互斥；容器就绪后切换模式抛
`ERR_MODE_MISMATCH`。

## 配置

`SuccinixConfig` 可序列化且同步校验，没有函数字段；运行时 hooks 走服务参数或
事件订阅。

```ts
export interface SuccinixConfig {
  hostJsUrl?: string;        // 默认 '/host.js'
  lifoCoreUrl?: string;      // 默认 '/lifo-core.js'
  pythonAssetsUrl?: string;  // 默认 '/pyodide/'
  rubyAssetsUrl?: string;    // 默认 '/ruby/'
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
    persistence?: { dbName?: string; storeKey?: string; includeGit?: boolean };
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

非法值抛 `ValidationError`；插件保留最后一次合法配置，并在
`host.state.lastError` 记录原因。

## 实例

`host.ensureInstance(containerId, opts)` 在共享页面 host 上创建按实例栈：

```ts
const alice = await host.ensureInstance('alice', {
  home: '/workspace/alice',
  persistence: { dbName: 'my-app', storeKey: 'alice' },
  executor: {},
});

await alice.executor.exec('node -v');
await alice.snapshot.save(true);
await alice.workspace.flush('manual');
```

实例状态根、快照键、SandboxContext、服务/端口视图与进程视图按 `containerId` 分区。
绑定真实 WebContainer 的实例默认使用 snapshot v2：binary export 分块写入 IndexedDB，
SHA-256 校验后才切换 generation，并保留 last-known-good。所属实例的 tinbase 数据也进入
快照；其他实例状态根与用户 home 被排除。这是组织性隔离，不是安全边界。

## 终端会话

`host.terminal` 是 `InteractiveTerminalService`。它连接浏览器设备与 WebContainer 内由
`Sandbox.create({ terminal })` 启动的 Lifo Shell；浏览器不再维护命令解析、history、Tab、
队列或编辑器状态。SDK/dsh 的非交互 `exec()` 继续使用文件 RPC v2 批处理通道。

```ts
const session = await host.terminal.open({
  instanceId: 'default',
  cols: 80,
  rows: 24,
});

const received: string[] = [];
const off = session.onData((data) => received.push(data));
await session.send('printf "hello\\n"\r');
await session.resize(120, 40);

await session.signal('SIGINT');
off();
await session.close();
```

`InteractiveTerminalSession` 只暴露 `id`、`send`、`resize`、`onData`、`signal` 与
`close`。传输使用 session/instance/boot nonce 身份、连续序列、ack/replay 与有界背压；
host respawn 后丢弃旧 nonce 帧。公开的 `ctx.terminals` 仍是 dsh 形状的 owner 隔离 PTY
registry，其 Succinix backend 包装同一个执行世界交互会话，而不是第二套浏览器 Shell。

## 端口与服务

端口事件经 `succinix/server-ready` 与 `succinix/server-closed`，或便捷订阅：

```ts
host.onServerReady(({ port, url, instanceId }) => {
  app.recordPreview(port, url, instanceId);
});
```

`host.ports` 是 canonical 页面级视图；spawn 前用 `expect(port)` /
`release(port)` 把端口归属到实例。

`host.listProcesses()` 聚合真实 Node/Python/Ruby 子进程与每实例 Lifo ProcessRegistry。
Ruby、WASI、交互命令与普通 Lifo 命令都带统一 runtime/instance/cwd/terminal 信息；
`host.executor.kill()` 把信号发送到对应真实子进程或 Lifo 进程。

声明式服务用 `host.services` 管理：

```ts
await host.services.ensureFiles();
await host.services.add('web', 'node server.js', 3001);
const start = await host.services.start('web');
const status = await host.services.status('web');
await host.services.stop('web');
```

执行世界另提供 `systemctl` adapter，直接复用该实例的 Lifo ServiceManager 与
ProcessRegistry。官方模板为 `node-http`、`vite`、`static-http`、`python-http`、
`tinbase`、`websocket`、`worker`；它是声明式服务管理器，不模拟 PID 1。

## 能力注册表

引擎自带轻量能力注册表：

```text
terminal.exec, terminal.spawn, terminal.kill, terminal.interrupt,
fs.read, fs.write, workspace.restore, workspace.flush, workspace.list
```

```ts
if (!host.capabilities.check('terminal.exec')) {
  throw new Error('execution is not allowed');
}

const dispose = host.capabilities.define('fs.write', () => isAllowed());
```

默认放行；`capabilities.defaultAllow` 与 `capabilities.rules` 可覆盖。

## Userland 扩展

在 `boot()` 或 `attach()` 后，必须从运行中的 host 注册扩展。注册会序列化到
WebContainer mailbox；执行新命令前，`flush()` 是确定性的发布边界：

```ts
const host = ctx.get('succinix', false)!;
const unregister = host.userland.registerCommand({
  name: 'hello-userland',
  status: 'adapter',
  runtime: 'lifo',
  execution: 'batch',
  source: { kind: 'shell', command: 'printf "hello\\n"', appendArgs: false },
});

await host.userland.flush();
const result = await host.executor.exec('hello-userland');
unregister();
await host.userland.flush();
```

`host.userland` 是唯一接入运行中执行世界的注册面。包仍导出
`createUserlandRegistry()`、`UserlandRegistry`、`UserlandCommandDefinition`、
`UserlandPackageSource` 与 `UserlandServiceTemplate`，但
`createUserlandRegistry()` 只用于离线描述和测试，不会向运行中的 host 安装命令。
命令只能声明结构化执行世界来源，不能传入浏览器函数；注册表拒绝重复名称和
fail-closed denylist。package 与 service template 通过同一 mailbox，复用 package manifest、
VFS、进程、服务、实例和生命周期状态。

交互命令必须声明 `execution: 'interactive'`，并使用 Lifo 公开的
`CommandContext.stdin` / `setRawMode` 合同。它们与 `vi`、`nano` 及已安装 Lifo 包共用
同一终端传输；消费者不得导入 Lifo 内部终端实现，也不得另建浏览器终端应用。

## 生命周期与热重载

- HostManager 是页面级模块单例，不是 Cordis fiber。
- 浏览器中 `container.hostPid` / `state.host.pid` 恒为 `null`（WebContainer
  进程无 pid）；`startedAt` 是跨软重载的稳定 host 身份 token。
- `fiber.update` 重跑 `apply`。热字段保持 `host.state.host.startedAt` 稳定；
  需要重启的字段会在 fiber 重新应用前关闭 host。
- `dispose()` 默认软收尾：释放实例与订阅，host 保持存活。
- `shutdown()` 强制 flush、kill host、清空页面注册表，并把 `containerState`
  置为 `disposed`。
- `lifecycle.disposeMode: 'hard'` 让 fiber dispose 也关闭 host。
- `flushOnPageHide` 开启 `pagehide` 的 best-effort flush；`beforeunload`
  总是触发 best-effort shutdown。浏览器 unload 无法等待异步工作。
- `reconfigure(next)` 同步校验、递增 `configRevision` 并 emit
  `succinix/state`（`reason: 'config'`）。改变 host 资产路径或容器模式的配置
  会先执行 shutdown。
- 每次成功的 `reconfigure` 或 fiber reapply 都递增 `configRevision`；
  页面级 HostManager 保证计数器跨软重载单调。

## 事件

类型化 `succinix/*` 事件是内部应用可观测事件，经 `host.on` 与 Cordis context
消费：

| 事件 | Payload |
| --- | --- |
| `succinix/state` | `{ state, reason, changed }` |
| `succinix/server-ready` | `{ port, url?, instanceId? }` |
| `succinix/server-closed` | `{ port, instanceId? }` |
| `succinix/command` | 命令遥测：id、instance、runtime、exit、duration |
| `succinix/command-start` | `{ id, instanceId, command, startedAt }` 执行前发出 |
| `succinix/command-finish` | 与 `succinix/command` 相同 payload |
| `succinix/runtime-ready` | `{ runtime, loadedAt, cached, instanceId? }` 运行时资产就绪 |
| `succinix/degradation` | `{ code, message, runtime, retryable, degraded, instanceId? }` 能力降级 |
| `succinix/persistence` | `{ instanceId, state, generation?, savedAt?, error? }` 持久化状态迁移 |
| `succinix/terminal-open` / `succinix/terminal-close` | `{ instanceId, sessionId, bootNonce }` 会话生命周期 |
| `succinix/terminal-backpressure` | `{ instanceId, sessionId, bootNonce, queuedBytes, limitBytes }` 输出背压 |
| `succinix/instance` | `{ containerId, state: 'created' \| 'released' }` |
| `succinix/workspace` | `{ instanceId, reason, savedAt? }` |
| `succinix/process` | `{ instanceId, processes }`（轮询聚合） |

## 资产与完整性

包内包含 `assets/host.js`、`assets/lifo-core.js`、`assets/pyodide/*` 与
`assets/sha256.json`。复制到静态目录，或用 Vite 导入：

```ts
import hostJsUrl from '@succinix/engine/host.js?url';
import lifoCoreUrl from '@succinix/engine/lifo-core.js?url';

const fiber = ctx.plugin(engine, {
  hostJsUrl,
  lifoCoreUrl,
  pythonAssetsUrl: '/pyodide/',
});
```

`assets.integrity: true`（默认）会在注入前用 `sha256.json` 校验 `host.js` 与
`lifo-core.js`。

## 要求与限制

- 仅 Chromium（Chrome/Edge）；WebContainers 不支持 Firefox、Safari 或移动端。
- 页面必须跨源隔离：`Cross-Origin-Opener-Policy: same-origin` 与
  `Cross-Origin-Embedder-Policy: credentialless`。
- 端口是虚拟 preview；没有真实入站网络。
- 执行世界边界是有意的：WebContainer/Lifo 拥有 userland 命令、运行时、包、服务、编辑器、TUI 与第三方扩展；浏览器只是控制/设备平面，不得另建一套命令或编辑器模型。显式交互 userland 命令已通过轻薄传输接入 Lifo `ITerminal` 与公开 `CommandContext.stdin` / `setRawMode`。
- 通用子进程 stdin 仍未支持；交互 userland 终端不会自动让任意 Node/Python 子进程 REPL 可用。
- Lifo 不支持符号链接或硬链接。
- 不模拟 `chmod` 语义与权限位。
- 无精确 OS 级内存/CPU 统计；估算必须标注。
- `ctx.sandbox` 是执行世界替换，不是桌面安全边界。
- `ctx.sessionPersistence` 的 durability 跨浏览器重载是 best-effort。

## 相关文档

- [MIGRATION.md](MIGRATION.md) — 旧 API 到 0.7.0 单轨插件迁移指南
- [PLUGIN.md](PLUGIN.md) — 第三方 Cordis 插件开发
- [cordis-contract.md](cordis-contract.md) — 权威契约快照
- [PROTOCOL.md](PROTOCOL.md) — 文件 RPC 线上契约（v2）
- [FEATURES.md](FEATURES.md) — 支持能力清单
