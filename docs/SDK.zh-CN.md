# Succinix Engine — SDK 形态设计（建议）

> 中文翻译。英文版为准：见 [SDK.md](SDK.md)
>
> 这是**设计文档**，不是已发布的包。它评估如何让*其他*前端项目把 Succinix engine 作为沙箱内嵌，
> 并给出推荐路径。仓库内解耦已完成（`src/engine/`，线上契约见 [PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md)）；
> 本文档决定*分发形态*应该是什么样。

## 目标场景（Target scenario）

> **"把 Succinix engine 内嵌到不同人的前端项目里，提供沙箱。"**

宿主应用已运行于 Chromium 浏览器并能创建 WebContainer。它想为自己的用户提供类 Unix 的
shell / 命令执行器——带真实 Node 运行时与 Unix 用户态、共享应用的文件——而不自行构建这一切。

## 三种候选形态

### 形态 A —— npm 包 `@succinix/engine`

打包 engine 目录（浏览器客户端 + 两个容器内 host 资产）并发布。使用方安装后这样用：

```ts
import { WebContainer } from '@webcontainer/api';
import { createTerminalExecutor } from '@succinix/engine';

const wc = await WebContainer.boot();
const term = createTerminalExecutor();
await term.boot(wc, {
  onServerReady: (port, url) => app.recordPreview(port, url),
  onServerClosed: (port) => app.dropPreview(port),
});

const r = await term.exec('node -e "console.log(1+1)"');   // runtime: "node"
const r2 = await term.exec('grep -i foo file.txt');        // runtime: "lifo"
await term.dispose();
```

`TerminalExecutor` 门面是**完整的生态执行面**（P1-3）：

| 方法 | 作用 |
| --- | --- |
| `boot(wc, opts?)` | 注入 host 资产、spawn host、等待它应答 `ping`。 |
| `exec(cmd, opts?)` | 跑一条命令（统一路由）；超时返回 `{ ok:false, timedOut:true }` 而非抛异常。 |
| `spawn(cmd, opts?)` | 后台长驻进程（node 系）；返回 `{ pid }`。 |
| `listProcesses()` | 统一进程表快照（`ps`）。 |
| `kill(pid)` | 对表条目发 SIGTERM；成功返回 `true`。 |
| `ping()` | host 存活探针。 |
| `pingDirect(timeoutMs?)` | 看门狗探活——**绕过串行化队列**，长命令占着队列时也能用。`true`=存活，`false`=超时，`null`=通道忙（本轮跳过，中性）。 |
| `respawn()` | 重启 host：kill 旧 → 重注入资产 → spawn 新 → 等待就绪。保持单 host 不变量。 |
| `dispose()` | 释放资源（kill host、清引用）。幂等。 |

> **两个执行面、同一 host**（P1-3）。Succinix 应用自身的终端额外使用低层 `TerminalClient`（`bootEngineHost` 返回）走命令路径，因为其命令处理器依赖协议原始语义（`exec` 超时抛异常、`processes`/`killed`/`cwd` 字段、命令上下文里的 `client` 句柄）。两个执行面驱动的是**同一个** host、**同一条** `/cmd.json` 通道；刻意不是同一个对象。内嵌请用 `createTerminalExecutor()`。

- **如何内嵌：** 作为库，同页、同 origin、同一 WebContainer。
- **集成深度：** 深——engine 共享应用的容器文件系统，应用与沙箱看到同一份文件。这是本产品的
  核心差异化。
- **隔离度：** 中——无 iframe 边界。命令隔离来自 Lifo 沙箱 + host 进程模型，而非独立的
  document/全局对象。不可信的 *node* 代码以真实子进程运行（WebContainer 自己的沙箱）。
- **性能：** 最优——共享文件系统上的直接文件 RPC，无序列化桥。
- **包体积：** engine 客户端极小；host daemon（`host.js`，0.4.0 起约 15 KB —— 随按实例/按用户
  host 路由增长）须作为静态资产提供（随包打包或抓取），`lifo-core.js`（约 1 MB）在首个
  Lifo 命令时懒加载。
- **维护：** 一个仓库、一个版本；host 与客户端一起发布。经 npm 做版本管理。

### 形态 B —— iframe 沙箱（Succinix 作为独立部署页）

把 Succinix 部署为独立沙箱页；宿主应用用 `<iframe>` 内嵌它并经 `postMessage` 通信。

- **如何内嵌：** iframe + 消息桥（命令 → 结果、端口事件中继）。
- **集成深度：** 浅——文件不自动共享。应用须显式把内容同步进/出沙箱。
- **隔离度：** 强——独立 origin、document、CSS、全局对象。最适合不可信代码或应用自己
  负担不起 WebContainer 的场景……但沙箱仍需*自己的* WebContainer，所以若应用自己也要拉起一个，
  就得为容器付两次成本。
- **性能：** 在沙箱自己的文件 RPC 之上多一层桥（每命令 postMessage + JSON 序列化）。更多
  活动部件、更长的往返。
- **包体积：** 宿主应用内无任何东西；沙箱页部署一次。
- **维护：** 独立运行/部署/版本化沙箱页；保持桥 schema 同步。

### 形态 C —— 脚手架 `create-succinix-app`

生成 "host + engine" 项目骨架的 CLI/模板（Vite host 应用、预接线的 engine、可选终端 UI、
端口注册表、PROTOCOL 感知的客户端）。

- 不是 A/B 的替代——它是它们的**上手入口**。减少"boot + 终端 + 端口怎么接线？"的空白页。

## 对比

| 维度        | A —— npm 包                       | B —— iframe 沙箱                   | C —— 脚手架              |
|------------------|---------------------------------------|--------------------------------------|---------------------------|
| 集成深度| 深（共享文件系统）              | 浅（显式同步）              | —（A/B 的上手入口）    |
| 隔离度        | 中（Lifo + 进程模型）         | 强（document/origin 边界）    | —                         |
| 性能      | 最优（直接文件 RPC）                | 桥开销 + 双容器   | —                         |
| 包体积      | engine 小；host 资产需提供服务    | 应用内无；沙箱部署一次   | —                         |
| 维护      | 一个仓库、npm 版本化               | 沙箱页 + 桥 schema         | 模板测试            |
| 契合"内嵌进不同前端" | **是**（同页、最佳 UX） | 可以，但牺牲共享 FS | 加速 A 的采纳 |

## 建议：**形态 A**，再向 B 和 C 演进

**推荐主形态是 A（`@succinix/engine`）。** 目标场景是同页内嵌：已持有 WebContainer 的前端想
在*页面内*获得共享文件的沙箱。A 提供：

- **共享文件系统体验完整保留** —— 应用的 `wc.fs`、Node 子进程与 Lifo 命令看到同一棵树。
  这是 Succinix 存在的理由，且只存活于同页集成中。
- **最低延迟与最简单的运维面** —— 无桥、无第二个容器、无可独立部署并保活的页面。
- **干净的扩展边界** —— engine 已通过 `TerminalExecutor` 暴露完整协议；未来的 postMessage
  适配器（形态 B）可*架在其上*而不改 engine。

**形态 B 是硬隔离的回退。** 若使用方日后需要强 document 边界（不可信代码、敌意 CSS，或
无法自行拉起 WebContainer 的宿主应用），`@succinix/sandbox-page` + 桥包可包装同一 engine。
它是*分发*选择，不是不同的 engine。

**形态 C 是增长杠杆** —— 一个模板，让新使用方一条命令拿到可用的 host + engine 应用。

## 落地路线图（Landing roadmap）

1. **现在（本任务，POC）：** engine 解耦进 `src/engine/`，干净公开 API、权威协议文档、本设计
   文档。同一仓库、同一构建（vite 把 engine 打进 Succinix bundle）；目录/API 边界是拆分的前提。
2. **阶段 1 —— 拆包（形态 A）。**
   - 前置：engine 对 Succinix 应用层无运行时依赖（本任务已完成：日志经 `onCommand` 注入，
     无 `persist`/`log`/`config` 导入）。
   - 从 `src/engine/` + host 资产（`public/host.js`、`public/lifo-core.js`）发布
     `@succinix/engine`；使用方提供这两个文件（或我们从 CDN 抓取）。
   - 定义发布/版本化流程，以及对外部 Vite 应用的冒烟测试。
3. **阶段 2 —— postMessage 桥（形态 B，可选）。**
   - 前置：形态 A 已发布；把桥 schema 定义为文件 RPC 协议的 1:1 映射（请求 id → 结果、
     端口事件中继）；文档化沙箱页的 COOP/COEP 要求。
   - 作为适配器 + 可部署沙箱页（`@succinix/sandbox`）发布。
4. **阶段 3 —— 脚手架（形态 C）。**
   - 前置：形态 A API 稳定、PROTOCOL/SDK 文档完成、CI 跑模板测试。
   - `create-succinix-app` 生成 host + engine 骨架并接线 `boot`、终端（可选）与端口注册表。

每个阶段以前一阶段为门禁；没有一个阶段改变线上协议（见 [PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md)，
版本 1）。

## 已完成的部分（本任务之后）

- `src/engine/index.ts` —— 公开 API：`TerminalClient`、`createTerminalExecutor()`、
  `bootEngineHost`、`waitForHostReady`、类型（`TerminalExecutor`、`ExecResult`、
  `TerminalExecutorOptions`、`ProcInfo`）。
- `src/engine/client.ts` —— 文件 RPC 客户端（经 `onCommand` 与日志解耦）。
- `src/engine/host.ts`、`host-procs.ts`、`lifo-core.ts` —— 容器内 host daemon 与进程注册表，
  构建为 `public/host.js` + `public/lifo-core.js`。
- `docs/PROTOCOL.md` —— 权威线上契约。
- 本文档 —— SDK 形态决策。

## 终端 SDK（嵌入终端会话，0.4.0）

自 0.4.0 起包暴露 `@succinix/engine/terminal` —— 无 UI 的终端交互核心，供需要完整终端
体验（历史 / Tab 补全 / 真 Ctrl+C 中断 / 命令队列 / cwd 跟随提示符）但不想捆绑 xterm 的
宿主使用。渲染由宿主负责：`TerminalOutput` 只有两个方法（`write(data)` / `clear()`），
xterm 适配器约 10 行。

```ts
import { SuccinixTerminalSession, type TerminalRpc } from '@succinix/engine/terminal';
import { createTerminalExecutor, type ExecResult } from '@succinix/engine';

const executor = createTerminalExecutor();
await executor.boot(wc); // 注入 host.js + spawn + 就绪（每页一次）

const rpc: TerminalRpc = {
  exec: (cmd, _opts, timeoutMs) => executor.exec(cmd, { timeoutMs }),
  spawn: (cmd, _opts, timeoutMs) => executor.spawn(cmd, { timeoutMs }),
  listProcesses: () => executor.listProcesses(),
  kill: (pid) => executor.kill(pid),
  ping: () => executor.ping(),
  pingDirect: (t) => executor.pingDirect(t),
  interruptDirect: (t) => executor.interruptDirect(t),
};

const session = new SuccinixTerminalSession(rpc, { write: (d) => term.write(d), clear: () => term.clear() }, {
  localHandlers: { hello: async (ctx, args) => `hello ${args.join(' ')}\n` },
});
term.onData((d) => session.handleData(d));
await session.boot(); // 解锁输入门禁 + 首提示符
```

### 契约

- **`TerminalRpc`** —— 窄 RPC 依赖面：`exec`（必选），可选 `spawn` / `listProcesses` /
  `kill` / `ping` / `pingDirect` / `interruptDirect` / `readdir`。
  `createTerminalExecutor()` 天然满足（见 [PROTOCOL.md](./PROTOCOL.md)）；可选方法安全降级
  （无 `readdir` → Tab 补全只补命令名；无 `interruptDirect` → Ctrl+C 只清队列不通知 host）。
- **`TerminalOutput`** —— `{ write(data: string): void; clear(): void }`。SDK 从不 import
  xterm；渲染（颜色 / 字体 / 滚动）归属宿主。
- **本地命令注入** —— `localHandlers: Record<string, (ctx, args) => ...>`。内置 `help` /
  `clear` / `pwd` / `echo`；宿主同名处理器覆盖内置。表外命令原样走 RPC（host 回
  unknown command 语义）。
- **boot 步骤配置** —— `createTerminalBoot(ui, { steps, testMode?, retry?,
  hostReadyDeadlineMs?, onCommand? })` 跑完整 boot 流程（环境检查 / WebContainer.boot 重试 /
  host 注入与 spawn / 快照恢复 / 工作区初始化 / autostart），带 `N/M` 进度计数。
  `steps: string[]` 是固定序列文案；动态步骤自带消息。独立应用用 `DEFAULT_BOOT_STEPS`
  （8 基础步 + autostart 服务数）。

### 分工

- `createTerminalExecutor()` 是**命令式通道**（Agent/宿主管道）：boot/exec/spawn/ps/kill/ping/respawn。
- `SuccinixTerminalSession` 是**交互会话**：行编辑 / 历史 / 补全 / 排队 / cwd 跟随提示符 /
  boot 门禁，经 `TerminalOutput` 呈现命令结果。
- `createTerminalBoot()` 是 **boot 编排器**：步骤文案 / 进度 / 重试参数化，给想要与独立
  应用相同 boot 体验的宿主。

### 打包说明

- `@succinix/engine/terminal` 打包 `session` + `boot`（ESM，`@webcontainer/api` 为 external
  peer 依赖）。`grep "node:" dist/terminal.js` 为空 —— 与引擎一致，纯浏览器层。
- 宿主每页一个 executor（单 host 不变量）；需要多个终端视图时在同一 RPC 通道上创建多个
  session。

## 多实例嵌入（0.4.0）

自 0.4.0 起包暴露 `@succinix/engine/instance` —— 聚合工厂：一次调用组装完整的
按实例栈：已 boot 的 executor、终端会话、快照持久化与服务视图。

```ts
import { createSuccinixInstance } from '@succinix/engine/instance';
import type { WebContainer } from '@webcontainer/api';

const wc = await WebContainer.boot();
const inst = await createSuccinixInstance({
  wc,
  instanceId: 'alice', // 用户/租户 id；'default'（或 ''）= 独立应用行为
  output: { write: (d) => term.write(d), clear: () => term.clear() }, // 必填
});
term.onData((d) => inst.terminal.handleData(d));
await inst.terminal.boot();

await inst.executor.exec('node -v');       // 命令式通道，按实例路由
await inst.snapshot.save();                // 每实例持久化键
const states = await inst.services.list(); // 每实例服务视图
await inst.restart();                      // 实例级重置（清状态 + 重建会话）
await inst.dispose();                      // 释放会话 + executor（共享 host 不动）
```

`SuccinixInstance` 暴露 `instanceId`、`client`（每实例 RPC 客户端）、`terminal`
（会话；`restart()` 换新）、`executor`、`persist`、`ports`（port → 预览 URL 视图）、
`snapshot {save, restore}`、`services {list, start, stop}`、`restart()` 与
`dispose()`。

### 隔离模型（DM-11）

**组织性隔离，不是安全边界**。每页一个共享 host daemon；实例按目录 / 状态 / 快照 /
进程视图分割。

| 维度 | 跨容器（双 tab / 双页） | 同页（多实例） |
| --- | --- | --- |
| 运行时（host / Node / Lifo） | 完全独立 | 共享单 host |
| 文件系统 / 交互 cwd | 完全独立 | 共享（Lifo cwd 页面级） |
| 持久化状态 / 快照 | 完全独立 | 每实例键 |
| 服务 + 端口预览 | 完全独立 | 每实例期望端口注册表 |
| 进程表（`ps`）/ `kill` | 完全独立 | 按 `instanceId` 过滤；跨实例/用户 `kill` 拒绝（host 路由） |
| RPC 通道 / 看门狗 | 每页一个 | 每页共享一个 |

### 同页共享规则

- **每个 WebContainer 一个 RPC 通道** —— `/cmd.json` 是单槽信箱。每实例建一个
  `TerminalClient`（各自带自己的 `instanceId`）；通道（队列 / 请求 id / 写时序）
  按 `wc` 自动共享。同页**绝不**起第二个 host。
- **每页一个看门狗（host 级）** —— `createSuccinixInstance` 不内置看门狗；宿主
  在页面级接一个（如 `startHostWatchdog`），所有实例共享。
- **`rpc` 选项** —— 传宿主已 boot 的 client 即复用其 host；缺省时工厂自建
  （单实例页面，或多 tab demo 的每个 tab —— 与独立应用行为一致）。

### 宿主风格接线（每容器 / 每用户一个实例）

推荐形态：每个用户会话一个 WebContainer、每容器一个实例 —— 每个用户从聚合 API
获得完整运行时隔离：

```ts
async function userSession(userId: string) {
  const wc = await WebContainer.boot();
  const inst = await createSuccinixInstance({
    wc,
    instanceId: userId,
    home: `/workspace/users/${userId}`, // 每用户 home（浏览器 wc.fs 视角）
    output: render(userId),
  });
  await runApplicationBootSteps(instBoot, {
    wc,
    client: inst.client,
    ports: inst.ports,
    instanceId: userId,
    userHome: `/workspace/users/${userId}`, // 种子 home + 会话 cwd
  });
  startHostWatchdog(inst.executor, wc); // 每页一次
  return inst;
}
```

同页多实例受支持（每实例需自己的 client、自己的 `instanceId` 与自己的 `output`），
但按 DM-11，共享运行时意味着交互式 Lifo cwd 与长驻进程是页面级，不是实例级。

### 多用户语义（0.4.0，U1）

`userId` 与 `instanceId` 是同一字段 —— 用户 = 带 home 目录的实例。demo URL
`?user=<id>` 是 `?instance=<id>` 的别名，额外种子每用户 home。

- **home 约定**：`/workspace/users/<id>`（浏览器 `wc.fs` 视角；根
  `/workspace/users` 可覆盖）。工厂传 `home` —— 会话在 home 内启动（Lifo 视图
  `/workspace/workspace/users/<id>`），提示符渲染为 `~`（`alice@succinix:~$`）。
- **home 初始化**：`runApplicationBootSteps({ userHome })`（或 `ensureUserHome`）
  首次启动创建目录、种子 `.succinix` 标记文件（内容 = 用户 id），并写入会话 cwd
  状态文件 —— 刷新后 host 仍从 home 恢复会话起点。
- **进程视图**：带用户/实例 id 的 `ps` 只返回该用户进程 + `system`；非默认实例的
  `kill` 拒绝非本实例进程（`permission denied: process <pid> is not owned by
  instance '<id>'`），含全部 `system` 进程。默认实例（`guest` / 独立应用）保持
  0.4.0 前行为：全表可见、可 kill 任意进程。
- **身份展示**：独立应用仍是 `guest` 单用户。嵌入宿主可传 `promptPrefix`
  （如 `alice@succinix:`）与 `userId`（供 `whoami`）。
- **隔离性质声明**：组织性隔离 —— 进程归属是 cwd/scope 启发式，非安全边界
  （见 AGENTS.md "Explicitly Not Implemented"）。

### statePrefix 注意

`statePrefix` 覆盖浏览器侧状态文件的落盘位置（缺省 `/workspace/.succinix-<id>`；
默认实例 = `/etc`）。host 侧归属（进程过滤 / kill 越权 / `ps`）以内置
`.succinix-<id>` 前缀为准，覆盖前缀时请保持 `instanceId` 命名与其对齐
（如 `instanceId: 'users/alice'` 在 host 侧对应 `/workspace/.succinix-users/alice`）。
