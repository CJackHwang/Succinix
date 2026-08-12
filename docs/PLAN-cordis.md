# PLAN: Succinix Cordis 全量插件化迁移

> 本计划是 Succinix Cordis 插件化迁移的单一规格。
> `ctx.succinix` 的服务注册/消费机制、子服务契约、HostManager 跨 fiber 重载
> 归属、配置热更新机制、fork 与 npm 发布物一致性、`AGENTS.md` 同步、管理命令面
> 都是本计划的硬规格。
>
> 目标：**`@succinix/engine@0.5.0` 本体就是 Cordis 插件**（单包、单轨、唯一对外形态）。
> Succinix 的每一层都改成 Cordis 可接入、可启停、可重载、可观测、可失败隔离的形态；
> SunamAI 的 Cordis 集成完成后，Succinix 直接作为外部插件挂进 SunamAI 生态。
>
> 协议共享：本次迁移只改变 SDK/打包/装配形态，不改变 `docs/PROTOCOL.md` 的文件 RPC
> 协议（v1 保持）。

---

## 0. 本计划要回答的问题

1. `@succinix/engine@0.5.0` 的发布物是什么？哪些导出保留、哪些删除？
2. Cordis 插件入口长什么样？`ctx.succinix.*` 提供哪些服务、哪些事件？
3. 配置如何进 Cordis 配置树？哪些字段可序列化、哪些必须走事件/JS 钩子？
4. 浏览器里 Cordis 怎么加载？`@cordisjs/plugin-loader`/`plugin-hmr` 不可用时用什么？
5. 单 host、多实例、快照、端口、服务如何被插件管理？
6. Succinix 自带 Vite app 如何变成 Cordis app，并消费自己的插件？
7. 插件如何被列出来、看状态、启停、重载、失败隔离？
8. SunamAI 期望的 `ctx.succinix` 形状和这里定义的是否完全一致？
9. 每个阶段改哪些文件、跑哪些测试、满足哪些验收、提交什么 commit？
10. 消费方如何声明注入、类型如何增强、服务何时不可用？

---

## 1. 执行须知与状态基线

### 1.1 仓库与版本

| 项 | 值 | 说明 |
|---|---|---|
| Succinix 仓库 | `~/Desktop/MyProject/Succinix` | 0.4.0；本计划定义 0.5.0 |
| engine 包 | `@succinix/engine` 0.4.0（独立 SDK） | 0.5.0 起为 Cordis 插件，breaking change |
| 已 deprecate | `0.4.0` 与 `0.1.0..0.1.3` | 迁移提示指向 0.5.0；撤包被 npm 2FA token 政策阻挡，deprecate 为最终处置 |
| cordis | peerDependency `>=4.0.0-rc.8`（发布物 semver） | 开发期围绕 fork 锁定，见 1.3 |
| SunamAI 仓库 | `~/Desktop/MyProject/SunamAI` | 并行执行 `docs/PLAN-succinix-embed.md` |
| 宿主应用 | `src/app/*`、`src/boot*.ts`、`src/main.ts` | 改造为 Cordis app，作为第一个消费者/自证 |

### 1.2 单轨铁律

1. **只维护一套对外面**：`@succinix/engine` = Cordis 插件；无独立 SDK API 线、
   无 `plugin-*` 第二包。
2. **核心逻辑零重写**：`src/engine/`、`src/terminal/`、`src/instance/` 行为与
   签名不变；改动只发生在打包形态、注册方式、导出面、插件壳、app 装配层。
3. **内部仍分层**：纯逻辑模块不 import `cordis`；只有 `src/plugin/` 薄壳允许
   import Cordis。将来 Cordis 有意外，重写的是薄壳不是内核。
4. **宿主应用也是消费者**：Succinix 自带 Vite app 改为 Cordis app，验证
   "装自己的插件即用"，不再直连内部模块。
5. **可管理是目标的一部分**：插件状态、事件、启停、重载、失败隔离必须有
   明确契约和测试，不能只在 README 里宣称。
6. **服务消费是显式契约**：消费 `ctx.succinix` 的插件必须
   `inject: ['succinix']` 或 `ctx.get('succinix')`；不依赖隐式全局，也不做
   顶层 `ctx.mixin` 扩散。

### 1.3 Cordis fork 同步与依赖锁（2026-08-13 复核）

| 项 | 值 | 说明 |
|---|---|---|
| fork | `CJackHwang/cordis` | 远程已复核：`git ls-remote` 与本地一致 |
| upstream | `cordiverse/cordis` | 本地 main = `f46ae95e`，与 upstream/main 零差异 |
| 规划分支 | `origin/sunam-planning` | `6c377af`，承载 `docs/sunam-ai-plugin-plan.md` 与 fork 研究笔记 |
| 关注分支 | `feat/reentrant-fiber-lifecycle`（`46d2ae5`） | **未并入 main**；fiber 生命周期大改，只研究不依赖 |
| 关注分支 | `fix/lazy-entry-config-resolution`（`e2e10d0`） | **未并入 main**；loader 懒配置解析，浏览器 loader 不可用时仅作参考 |
| `safe` 分支 | `db34989`（Cordis v3.18.1，2024-10） | 是**旧版稳定线**，不是 4.0 rc 候选；本计划不基于它 |
| 同步方式 | `git fetch upstream && git merge upstream/main` | 升级单独立项，不夹带进功能 commit |
| npm 一致性 | rc.8 源码与 fork main 是否逐字一致 | C0 用 `npm pack cordis@4.0.0-rc.8` 与 `f46ae95e` 比对定论；不一致则锁定 fork tarball 或调整 peer 范围 |

**Cordis rc.8 已知事实（源码核验，不是假设）：**

- 插件形态：函数插件、类插件、`{ apply(ctx, config) }` 对象插件。
- 核心服务：`ctx.events`、`ctx.logger`、`ctx.reflect`、`ctx.registry`、
  `ctx.fiber`；核心 API 含 `plugin()`、`inject()`、`provide()`、`on()`、
  `mixin()`、`isolate()`、`intercept()`。
- fiber 状态：`PENDING / LOADING / ACTIVE / FAILED / UNLOADING / DISPOSED`。
- `Plugin.Config` 走 StandardSchema V1；`resolveConfig` 当前**拒绝 async
  validation**，配置校验必须同步。
- **rc.8 已移除可选注入语义**（commit `b4b5501 feat(core): remove optional inject
  semantics`）。`@succinix/engine` 不能声明 `inject: ['capability']` 然后期待宿主
  缺省也能加载；能力面集成必须在 `apply` 内用 `ctx.get('capability')` 探测，能拿到
  才注册，拿不到就只用插件自带 `ctx.succinix.capabilities`。
- `@cordisjs/plugin-loader@1.0.0-rc.5` 依赖 Node `ModuleLoader`、
  `node-addon-require-builtin` 等，**不能默认它在 WebContainer 可用**。
- `@cordisjs/plugin-hmr` 依赖 `chokidar`、`node:path`、`node:url`、
  `node:module`，**预期浏览器不可用**，由 C0 实测记录。
- `@cordisjs/plugin-logger-console@1.0.0` 提供 `exports.default` 的 browser
  entry，C0 应实测；`supports-color` 等依赖是否干净由 POC 定论。
- `@cordisjs/plugin-database-memory` 不在本 fork 仓库内；C0 需按 npm 实际版本
  验证，不可用时由 SunamAI 自己的 persistence 插件承担，不阻塞 Succinix。

### 1.4 与 SunamAI 并行对齐

SunamAI 计划的 §1.3 表已按以下权威映射核对一致（历史版本曾把 C4/C5 编号误写为
"外部 demo / 发布"，已更正；不改变任何依赖结论）：

| Succinix C 阶段 | 内容 | SunamAI 依赖 |
|---|---|---|
| C0 | Cordis 浏览器 POC（硬 gate） | 与 SunamAI P0 并行，共用结论 |
| C1 | engine 0.5.0 包形态 + 插件骨架 | SunamAI P1 可预研 |
| C2 | 插件服务/capability/生命周期 | SunamAI P2 硬前置（或临时适配器兜底） |
| C3 | Succinix 宿主应用 Cordis 化 | 不阻塞 SunamAI |
| C4 | 可管理性：状态/重载/失败隔离/telemetry/replay 调研 | 为 SunamAI P5 提供验收依据 |
| C5 | 外部 demo + SunamAI 契约复验 | SunamAI P5 验收依据 |
| C6 | 0.5.0 发布 + 文档迁移 | SunamAI P5/P6 删除临时适配器的前置 |

SunamAI 计划要求 `@succinix/engine@0.5.0` 暴露 `ctx.succinix.executor`、
`ensureInstance(containerId)`、`terminal`、`snapshot`、`ports`，并声明
`terminal.exec/spawn/kill/interrupt`、`fs.read/write`、
`workspace.restore/flush/list`。本计划把这些作为硬契约，并补齐 `persist`、`workspace`、
`instance`、`container`，解决 SunamAI §6.2 中 `ctx.succinix.persist` 与
`ctx.succinix.instance.ports` 的引用缺口。

### 1.5 不在本计划范围

- 不改 `docs/PROTOCOL.md` 的 wire contract（协议 v1 保持）。
- 不做 SunamAI 特有逻辑（appBootSteps / AgentWorkspaceRuntime 契约适配）。
- 不做多租户/权限位（engine 既有边界；组织性隔离不是安全边界）。
- 不引入 npm workspaces；本地消费用 Vite alias，外部 demo 用 `file:` 或 npm 包。
- 不承诺浏览器运行时插件市场；默认构建期打包 + 静态插件组合。
- 不做浏览器里无法真实实现的 loader/HMR 模拟；有真实价值才做。
- `@succinix/engine` 不内嵌 app 命令域、selftest、xterm UI；这些属于
  Succinix 自带 app 插件，外部宿主不需要时可完全不装。

---

## 2. 目标架构

```
任意 Cordis 应用（SunamAI / Succinix app / dsh 生态未来消费者）
└─ config.yaml / config.ts / 内存插件表: [@succinix/engine]
        ↓
@succinix/engine@0.5.0（单包 = Cordis 插件）
├─ src/plugin/index.ts        插件对象 { name, apply, Config }
├─ src/plugin/config.ts       StandardSchema V1 同步配置
├─ src/plugin/schema.ts       零依赖 schema 工具（~standard 适配）
├─ src/plugin/types.ts        服务/状态/事件/实例类型
├─ src/plugin/events.ts       succinix/* 类型化事件 + module augmentation
├─ src/plugin/services.ts     ctx.succinix 服务面
├─ src/plugin/host-manager.ts 页面级 HostManager + 单 host 不变量
├─ src/plugin/default-instance.ts 默认实例聚合
├─ src/plugin/capabilities.ts 能力注册/检查（默认放行，宿主可覆盖）
├─ src/plugin/persist.ts      快照持久化 facade
├─ src/plugin/workspace.ts    工作区/快照 facade + 路径规范
├─ src/plugin/ports.ts        端口聚合（pagePorts 收敛为 ports）
├─ src/plugin/state.ts        SuccinixPluginState + state 事件
├─ src/plugin/assets.ts       资产 URL/SHA 校验/注入
├─ src/plugin/invariant.ts    入参/状态/出参断言（DSH J6）
└─ 核心逻辑（src/engine、src/terminal、src/instance：零行为改动）

Succinix 自带 app（第一消费者）
└─ src/host/main.ts           Cordis Context + 内存配置树 + React/xterm 挂载
   ├─ succinix-app-container  环境检查 + ctx.succinix.boot + app boot steps
   ├─ succinix-app-terminal   xterm + ctx.succinix.terminal.create
   ├─ succinix-app-commands   本地命令域（消费 ctx.succinix.*）
   ├─ succinix-app-snapshot   自动快照（消费 ctx.succinix.snapshot/persist）
   ├─ succinix-app-watchdog   host 看门狗（消费 ctx.succinix 生命周期）
   ├─ succinix-app-selftest   自检（消费 ctx.succinix.*）
   └─ succinix-app-devhooks   ?bench / ?scenario / ?test window 句柄
```

### 2.1 包导出面（0.5.0）

```jsonc
{
  "name": "@succinix/engine",
  "version": "0.5.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./host.js": "./assets/host.js",
    "./lifo-core.js": "./assets/lifo-core.js",
    "./assets/*": "./assets/*",
    "./package.json": "./package.json"
  },
  "files": ["dist", "assets", "README.md", "LICENSE"],
  "peerDependencies": {
    "cordis": ">=4.0.0-rc.8",
    "@webcontainer/api": "^1.6.4"
  },
  "dependencies": {
    "@standard-schema/spec": "^1.1.0"
  }
}
```

要点：

- 根导出 = 插件入口（默认导出 `{ name, apply, Config }`，并导出类型）。
- `cordis`、`@webcontainer/api` 保持 external，不打进 bundle。
- `@lifo-sh/ui` 继续 external（headless 不加载）。
- `host.js` / `lifo-core.js` / pyodide 资产仍复制进包；`assets/*` 子路径供
  外部宿主按需同步静态资源。
- `assets/sha256.json` 随 assets 发布，供加载前完整性校验；它是数据文件，
  不作为 JS 导出。
- `./terminal`、`./instance` 不再对外；0.4.0 的独立函数/类 API 不再承诺。
- `@standard-schema/spec` 作为 runtime dependency，保证发布 .d.ts 类型自包含。
- 发布 .d.ts 必须携带 `Context['succinix']` 与 `Events['succinix/*']`
  module augmentation（见 2.2.1），否则消费方类型不可用。
- 包内可保留 `src/engine`、`src/terminal`、`src/instance` 的内部导出用于测试，
  但包 `files` 白名单不含这些源码。

### 2.2 `ctx.succinix` 服务契约（与 SunamAI 对齐）

```ts
export interface SuccinixService {
  /** 插件可观测状态：容器、host、实例、capability、版本、configRevision */
  readonly state: SuccinixPluginState;

  /** 当前容器句柄；external/internal 模式统一在这里读，不再散落宿主 */
  readonly container: SuccinixContainerHandle;

  /** 默认实例的命令式通道；未 boot/attach 前访问必须快速失败并给出 state 原因 */
  readonly executor: TerminalExecutor;

  /** 终端会话工厂；output 由宿主注入，xterm 无关 */
  readonly terminal: SuccinixTerminalService;

  /** 默认实例快照 */
  readonly snapshot: SuccinixSnapshotService;

  /** 默认实例持久化上下文（SunamAI §6.2 引用的 ctx.succinix.persist） */
  readonly persist: SuccinixPersistService;

  /** 工作区 facade：restore/flush/list/stateRoot/home */
  readonly workspace: SuccinixWorkspaceService;

  /** 页面级端口视图 + 事件订阅（canonical，不再公开 pagePorts） */
  readonly ports: SuccinixPortsService;

  /** 默认实例声明式服务管理 */
  readonly services: SuccinixServicesService;

  /** 插件自带能力注册表；宿主有 ctx.capability 时可做可选集成 */
  readonly capabilities: SuccinixCapabilityService;

  /** 默认实例聚合句柄（未创建时为 null） */
  readonly instance: SuccinixInstance | null;

  /** 外部容器模式：宿主把已 boot 的 WebContainer 交给插件；幂等 */
  attach(wc: WebContainer, opts?: AttachOptions): Promise<void>;

  /** 内部容器模式：插件自己 boot WebContainer；幂等 */
  boot(opts?: BootOptions): Promise<WebContainer>;

  /** 创建/复用实例；同一 containerId 返回同一实例 */
  ensureInstance(containerId: string, opts?: EnsureInstanceOptions): Promise<SuccinixInstance>;

  /** 读取已创建实例；不存在返回 undefined */
  getInstance(containerId: string): SuccinixInstance | undefined;

  /** 释放实例；幂等 */
  releaseInstance(containerId: string): Promise<void>;

  /** 默认实例或指定实例的进程表快照（可管理性指标源，J1/J2 数据面） */
  listProcesses(containerId?: string): Promise<ProcInfo[]>;

  /** 领域事件订阅；返回退订函数 */
  on<K extends keyof SuccinixEventMap>(event: K, handler: SuccinixEventHandler<K>): () => void;

  /** 端口就绪/关闭订阅（替代 config 里的 onServerReady/onServerClosed 回调） */
  onServerReady(handler: (payload: SuccinixPortEvent) => void): () => void;
  onServerClosed(handler: (payload: SuccinixPortEvent) => void): () => void;

  /** 插件卸载时的软收尾：释放会话/订阅/实例引用；单 host 默认保留 */
  dispose(): Promise<void>;

  /** 显式完全关闭：kill host、清实例、清订阅；幂等 */
  shutdown(): Promise<void>;

  /** 管理面触发的配置重载；hot 字段只做 fiber reload，requiresRestart 字段内部先 shutdown */
  reconfigure(next: SuccinixConfig): Promise<void>;
}

export interface SuccinixContainerHandle {
  readonly mode: 'internal' | 'external';
  readonly state: 'unattached' | 'booting' | 'ready' | 'disposed';
  readonly wc: WebContainer | null;
  readonly hostPid: number | null;
  readonly startedAt: number | null;
}
```

### 2.2.1 服务注册与消费约定

- **注册**：engine 插件 `apply` 内调用 `ctx.provide('succinix', service)`。
  `ctx.provide` 是 fiber effect：dispose 时服务自动注销，依赖该服务的 fiber
  被 Cordis 刷新；reload 后重新 `provide`，消费方自动恢复。
- **消费**：第三方插件必须显式声明 `inject: ['succinix']`，或在运行时用
  `ctx.get('succinix')` 探测。未声明时直接访问 `ctx.succinix` 会得到 Cordis
  的 `cannot get property "succinix" without inject`；拿到 null 时必须按
  "服务未就绪/已卸载" 处理，不能假设插件已加载。
- **类型增强**：`src/plugin/types.ts` 负责
  `declare module 'cordis' { interface Context { succinix: SuccinixService } }`；
  `src/plugin/events.ts` 负责
  `declare module 'cordis' { interface Events { 'succinix/*': ... } }`。
  发布物 `.d.ts` 必须包含这两份 augmentation，否则 SunamAI 的 `ctx.succinix`
  只会在运行时可用、类型上不可用。
- **不做顶层扩散**：不调用 `ctx.mixin('succinix', ...)` 把
  `executor/terminal/ports` 平铺到 `ctx` 顶层；`ctx.succinix` 是唯一服务面
  （DC-17/DC-31）。

`EnsureInstanceOptions` 是 `SuccinixInstanceOptions` 的宿主面裁剪：
`wc`/`rpc` 由插件内部决定，宿主传 `output`（缺省用 no-op 输出，支持 headless
agent 使用）、`terminal`、`statePrefix`、`home`、`persistence`、`executor` 钩子。

`SuccinixInstance` 沿用 0.4.0 工厂产物，并明确 `persist` 与 `workspace` 视图：

```ts
export interface SuccinixInstance {
  instanceId: string;
  client: TerminalClient;
  terminal: SuccinixTerminalSession;
  executor: TerminalExecutor;
  persist: PersistContext;
  ports: Map<number, string>;
  snapshot: { save(force?): Promise<unknown>; restore(): Promise<void> };
  services: { list(); start(name); stop(name); };
  workspace: SuccinixWorkspaceView;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}
```

### 2.2.2 子服务详细契约

```ts
export interface SuccinixTerminalService {
  /** 创建终端会话；output 由宿主注入，不绑定 xterm */
  create(output: TerminalOutput, opts?: TerminalSessionOptions): SuccinixTerminalSession;
}

export interface SuccinixSnapshotService {
  save(force?: boolean): Promise<SaveResult>;
  restore(): Promise<void>;
  meta(): Promise<SnapshotMeta | null>;
  clear(): Promise<void>;
}

export interface SuccinixPersistService extends PersistContext {}

export interface SuccinixWorkspaceService {
  restore(): Promise<void>;
  flush(tag?: string): Promise<void>;
  list(): Promise<unknown[]>;
  readonly stateRoot: string;
  readonly home: string;
}

export interface SuccinixPortsService {
  list(): Map<number, string>;
  ready(port: number): string | undefined;
  onServerReady(handler: (payload: SuccinixPortEvent) => void): () => void;
  onServerClosed(handler: (payload: SuccinixPortEvent) => void): () => void;
}

export interface SuccinixServicesService {
  list(): Promise<ServiceState[]>;
  start(name: string): Promise<ServiceActionResult>;
  stop(name: string): Promise<ServiceActionResult>;
}

export type CapabilityPattern =
  | 'terminal.exec'
  | 'terminal.spawn'
  | 'terminal.kill'
  | 'terminal.interrupt'
  | 'fs.read'
  | 'fs.write'
  | 'workspace.restore'
  | 'workspace.flush'
  | 'workspace.list';

export interface SuccinixCapabilityService {
  check(pattern: CapabilityPattern): boolean;
  list(): CapabilityPattern[];
  define(pattern: CapabilityPattern, checker?: () => boolean): () => void;
}
```

默认实例未创建时，`executor/terminal/snapshot/persist/workspace/services` 的
访问必须快速失败并携带 `state.lastError` 原因；`releaseInstance('default')`
后同样进入该状态，直到再次 `ensureInstance('default')`。

### 2.3 类型化事件

插件统一通过 `ctx.succinix.on` 暴露领域事件，同时在 Cordis `Events` 上做
module augmentation，宿主可以用 `ctx.on('succinix/...')` 直接消费：

| 事件 | 载荷 | 用途 |
|---|---|---|
| `succinix/state` | `SuccinixStateEvent` | 插件状态/容器/实例变化，带 reason 与 changed 字段 |
| `succinix/server-ready` | `{ port, url, instanceId? }` | 端口就绪 |
| `succinix/server-closed` | `{ port, instanceId? }` | 端口关闭 |
| `succinix/command` | `SuccinixCommandEvent` | 命令采集 + telemetry（DSH J1） |
| `succinix/instance` | `{ containerId, state }` | 实例创建/释放 |
| `succinix/workspace` | `{ instanceId, reason, savedAt? }` | 快照/工作区变化（DSH J5 尽力面） |
| `succinix/process` | `{ instanceId, processes }` | 进程表快照变化（可轮询聚合，非协议 push） |

`SuccinixStateEvent` 让管理面可以按原因过滤，而不是每次全量对比：

```ts
export type SuccinixStateReason =
  | 'boot'
  | 'ready'
  | 'instance'
  | 'config'
  | 'error'
  | 'shutdown';

export interface SuccinixStateEvent {
  state: SuccinixPluginState;
  reason: SuccinixStateReason;
  changed: string[];
}
```

`SuccinixCommandEvent` 是 J1 telemetry 的基础：

```ts
export interface SuccinixCommandEvent {
  id: string;
  instanceId: string;
  command: string;
  runtime: 'node' | 'lifo' | 'browser';
  exitCode: number | null;
  startedAt: number;
  durationMs: number;
  pid?: number;
  timedOut?: boolean;
  error?: string;
}
```

实现来源：`TerminalExecutor`/`TerminalClient` 的 `onCommand` 目前只有
`{ command, exit, runtime }`，本计划在插件壳内包一层计时器，不改核心
`CommandLogEntry`。

### 2.4 配置 schema（StandardSchema V1，只允许可序列化字段）

```ts
export interface SuccinixConfig {
  hostJsUrl?: string;
  lifoCoreUrl?: string;
  pythonAssetsUrl?: string;
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
    /** 默认 soft：fiber dispose 不 kill host；管理面禁用前应显式 shutdown */
    disposeMode?: 'soft' | 'hard';
    /** 是否在页面 hide/unload 时强制 flush 快照 */
    flushOnPageHide?: boolean;
  };

  assets?: {
    /** 加载 host.js/lifo-core.js 时校验 SHA-256；缺省 true */
    integrity?: boolean;
  };
}
```

约束：

- **校验必须同步**：Cordis rc.8 的 `resolveConfig` 拒绝 async validation。
- **函数不进配置**：`onServerReady`、`onServerClosed`、`onCommand`、颜色、
  `TerminalOutput` 等运行时钩子一律经 `ctx.succinix.on*` / 服务参数注入。
- 非法值（如 `resultTtlMs <= 0`、`bootRetries < 1`、未知 capability pattern）
  返回 ValidationError，插件进入 FAILED，保留上次有效配置。
- schema 实现用 `src/plugin/schema.ts` 的零依赖 StandardSchema V1 工具；
  不强制引入 schemastery。未来若生态统一，可加 schemastery 适配层，但发布物
  不新增运行时依赖。

### 2.4.1 配置来源与热更新机制

- **宿主配置树**：`src/host/plugins.ts` 提供内存配置树，把 `src/config.ts`
  的 env/settings 显式映射为 `SuccinixConfig`；不允许把 `TerminalClient`、
  `WebContainer`、函数等运行时对象放进配置树。
- **URL 参数保持 app 级**：`?instance=`、`?user=`、`?test=1`、`?bench=1`、
  `?scenario=1` 由 app 插件读取，不进入 `SuccinixConfig`；`instance`/`user`
  通过 `ctx.succinix.ensureInstance(containerId, opts)` 传给实例工厂。
- **热更新机制**：管理面调用 Cordis `fiber.update(next)`（或 engine 插件暴露的
  `ctx.succinix.reconfigure(next)`），触发 `internal/update` + fiber restart。
  由于 HostManager 是页面级单例（见 2.6），fiber restart 不会 kill host；
  插件在 reapply 后递增 `configRevision` 并广播 `succinix/state`。
- **requiresRestart 派生**：
  - 仅需 fiber reload：`resultTtlMs`、`capabilities.rules`、`defaultInstance.*`、
    `terminal.*`、`lifecycle.*` 的非 host 字段；
  - 必须先 `shutdown()` 再 reload：`hostJsUrl`、`lifoCoreUrl`、
    `pythonAssetsUrl`、`container.mode` 以及任何改变 host 资产注入路径的字段。
- **校验失败语义**：`resolveConfig` 抛 `ValidationError` 后 fiber 进入 FAILED；
  插件必须保留上次有效配置与 `lastError`，管理面可回滚到
  `previousConfig` 并重试。

### 2.5 Capability 契约

Cordis core rc.8 没有内置 capability 服务，因此 Succinix 自带轻量注册表，默认
放行，宿主可覆盖：

| Pattern | 含义 |
|---|---|
| `terminal.exec` | 执行命令 |
| `terminal.spawn` | 后台长驻进程 |
| `terminal.kill` | 终止进程 |
| `terminal.interrupt` | Ctrl+C 真中断 |
| `fs.read` | 读取文件 |
| `fs.write` | 写文件 |
| `workspace.restore` | 快照恢复 |
| `workspace.flush` | 快照保存 |
| `workspace.list` | 列出工作区/快照 |

实现规则：

1. `src/plugin/capabilities.ts` 提供 `check/list/define`，check 默认放行。
2. 宿主配置可覆盖 `defaultAllow` 与 `rules`。
3. **不使用 `inject: ['capability']`**；apply 时 `ctx.get('capability')` 探测，
   宿主提供则把同一组 pattern 注册到宿主能力面；拿不到时 `ctx.succinix.capabilities`
   始终可用。
4. 能力面变化必须同步文档与测试；协议 wire 层不因能力面改变。

### 2.6 生命周期与单 host 不变量

**apply 时：**

1. 解析/校验 config。
2. 创建插件内部 `StateStore`、端口聚合、能力注册表；**HostManager 不在 apply
   内 new**，而是从页面级模块单例获取（见下）。
3. `ctx.provide('succinix', service)`。
4. 注册 `terminal.*`、`fs.*`、`workspace.*` 能力（若宿主 capability 存在）。
5. 订阅页面生命周期（`pagehide`/`beforeunload`）用于 flush + 最终 host 收尾。

**container mode 决定：**

- `internal`：第一次使用服务或显式 `boot()` 时，插件调用 `WebContainer.boot()`
  （带重试），之后单 host。
- `external`：宿主 boot WebContainer 后调用 `attach(wc)`；插件**仍负责在容器内
  拉起 Succinix host daemon**（注入 host.js + spawn `node host.js`），只是不负责
  WebContainer 本身的 boot。SunamAI 走此模式，`@sunam/plugin-runtime` 拥有容器。

**单 host 不变量：**

- 一个页面上下文最多一个 host 进程轮询 `/cmd.json`。
- `ensureInstance()` 永远复用已 boot 的 host；实例差异只体现在
  `instanceId` 路由、状态根、快照键、端口归属。
- `attach()`/`boot()` 幂等；重复调用不叠加监听器、不 spawn 第二个 host。
- `respawn()` 必须 kill-before-spawn（沿用 0.4.0 语义）。
- `attach()` 与 `boot()` 互斥：当前已是 `external` 时再 `boot()`（或反之）必须
  抛 `ERR_MODE_MISMATCH`，不允许静默切换模式。

**HostManager 是页面级模块单例：**

- `src/plugin/host-manager.ts` 导出 `getHostManager()`，内部持有模块级单例；
  它不属于任何 Cordis fiber，因此 fiber dispose/reload 不会销毁它。
- `pagePorts`、`instancePorts`、persist context、TerminalClient channel、host
  进程句柄统一由 HostManager 或同一页面单例注册表持有。
- apply 只负责"向 HostManager 注册当前 fiber 的页面生命周期 effect、端口订阅、
  能力注册"，dispose 只注销这些 effect；host 与页面级注册表保留。
- `shutdown()` 才真正 `manager.shutdown()`：flush 全部实例、kill host、清实例、
  清端口/能力/订阅，并把单例状态重置为 `disposed`。
- 测试入口 `resetPageSingletons()` 清空页面单例，保证 Vitest 用例之间不串状态；
  该函数不得在包发布物对外导出（仅测试/内部）。

**dispose / reload 语义：**

- 插件 fiber dispose 默认是**软收尾**（`lifecycle.disposeMode: 'soft'`）：释放
  实例引用、会话、端口订阅、能力注册，但**不 kill host**；host 由插件内部页面级
  HostManager 持有。
- 这是为了满足"插件重载不重启 host"：Cordis HMR/重载触发 dispose + 重新 apply，
  如果 dispose 直接 kill host，重载必然重启 host。
- 显式 `shutdown()`、`lifecycle.disposeMode: 'hard'`、管理面真正禁用插件前调用
  shutdown、或页面 `pagehide/beforeunload` 才 kill host。
- `dispose()` 与 `shutdown()` 都幂等；重复调用必须安全。

**实例生命周期：**

- `ensureInstance(id)`：不存在则创建；存在则返回同一实例。
- `releaseInstance(id)`：dispose 会话/executor 引用、退订端口、清理该实例的
  `instancePorts` 期望；共享 host 时不动 host。
- `releaseInstance('default')` 后，默认实例服务进入"未就绪"状态，直到再次
  `ensureInstance('default')`（见 2.2.2）。
- 默认实例（`default`）对应 `ctx.succinix.executor` / `snapshot` / `services` /
  `persist` / `workspace`。

### 2.7 可管理性

```ts
export interface SuccinixPluginState {
  version: string;
  containerMode: 'internal' | 'external';
  containerState: 'unattached' | 'booting' | 'ready' | 'disposed';
  host: { pid: number | null; startedAt: number | null };
  instances: Array<{ instanceId: string; state: 'active' | 'disposed' }>;
  capabilities: string[];
  configRevision: number;
  lastError: string | null;
}
```

管理面职责：

- SunamAI 的 `@sunam/plugin-plugin-manager` 负责通用插件管理 UI；
  Succinix 提供 `ctx.succinix.state`、事件和 `on*` 订阅即可被管理。
- Succinix 自带 app 提供最小自检入口（`succinix status`），用于自证可观测，
  不重复造完整插件管理 UI。
- 配置热重载：能安全应用的字段（`resultTtlMs`、capability rules、terminal 默认值、
  lifecycle/event 开关）走 update；需要重建 host 的字段（`hostJsUrl`、
  `lifoCoreUrl`、container mode）标记 `requiresRestart`，由管理面决定是否
  `shutdown` + 重新 apply。

**管理命令面（C4 落地）：**

- `succinix status`：输出 `SuccinixPluginState` 的 ASCII 表/JSON（终端 UI 必须
  English、无 emoji），至少包含 version、fiber state、containerMode、
  containerState、host pid/startedAt、instances、capabilities、configRevision、
  lastError。
- `succinix plugins`：列出 `ctx.registry.values()` 中每个 plugin runtime 的
  name 与各 fiber state；engine 插件本身状态以 `ctx.succinix.state` 为准。
- 管理面不做 UI：启停/重载由 SunamAI plugin-manager 或测试直接驱动
  `ctx.registry` / `fiber.update`。

**失败隔离 scope：**

- app 插件各自是独立 fiber：任一 app 插件 FAILED 不影响 engine 服务，也不影响
  其他 app 插件；`succinix plugins` 可直接看到 FAILED。
- engine 插件 apply/config 失败 => `succinix` 服务不可用；HostManager 单例与
  已 boot 的 host 仍保留（不会因插件 FAILED 泄漏进程或误杀 host），reapply 修复
  后服务恢复。
- host boot/respawn 失败 => `containerState` 保持 `unattached`/`booting`、
  `lastError` 记录原因，不 spawn 第二个 host；重试次数受
  `container.bootRetries` 约束。

### 2.8 浏览器 loader / HMR 边界

| 能力 | 默认策略 |
|---|---|
| Cordis core | 直接作为 ESM 依赖 |
| 配置树 | 构建期 `config.yaml` 转 JS，或直接用 `src/host/plugins.ts` 内存表；浏览器覆盖层可存 localStorage |
| 插件加载 | 静态/程序化组合：构建期 Vite 打包，fiber 负责启停 |
| HMR/重载 | 若 `@cordisjs/plugin-loader` / `plugin-hmr` 在浏览器不可用，用 Cordis fiber 重建 + 软 dispose；不模拟 Node loader |
| 运行时 ESM 插件市场 | 研究项，不做承诺 |

C0 必须实测 `@cordisjs/plugin-loader`、`plugin-hmr`、`plugin-database-memory`、
`logger-console` 在 WebContainer 中的真实可用性，并把结论写进
`docs/cordis-poc-report.md`。

### 2.9 开发期自消费

不引入 workspaces。Succinix app 与测试在源码期统一 import
`@succinix/engine`：

- `vite.config.ts`：alias `@succinix/engine` -> `./src/plugin/index.ts`。
- `tsconfig.json`：`paths` 同步 alias。
- vitest：同 alias，或直接 import `src/plugin/index.ts`。
- 发布物正确性由 C5 外部 demo（只依赖 npm 包/本地 pack 产物）验证。

---

## 3. 关键决策

| # | 决策 | 结论 |
|---|---|---|
| DC-01 | 单轨 | 唯一对外形态 = Cordis 插件；无独立 SDK 线、无 plugin-* 第二包 |
| DC-02 | 版本 | 0.4.0（独立 SDK）-> 0.5.0（插件）；0.4.0 与 0.1.x deprecate |
| DC-03 | 分层 | 纯逻辑不 import cordis；`src/plugin/` 薄壳允许 |
| DC-04 | cordis 依赖 | peerDependency `>=4.0.0-rc.8`；开发期 fork 锁定 `f46ae95e` |
| DC-05 | capability | 插件自带轻量注册表，默认放行；宿主 `ctx.capability` 可选集成 |
| DC-06 | 单 host | 页面级单 host；`attach/boot` 幂等；重载不重启 host |
| DC-07 | 宿主应用 | Succinix app 改造为 Cordis app，消费自己的插件 |
| DC-08 | POC gate | C0 验证 Cordis core 浏览器可行；loader/HMR 单独记录，不混入核心 gate |
| DC-09 | 容器归属 | 支持 `internal` 与 `external` 两种模式；SunamAI 用 `external` |
| DC-10 | 配置序列化 | config 只含可序列化字段；运行时回调走服务订阅/事件 |
| DC-11 | 导出面 | 删除 `./terminal`、`./instance`；根 = 插件入口 |
| DC-12 | 自消费 | Vite alias + tsconfig paths；不引入 workspaces |
| DC-13 | loader 策略 | 默认构建期静态插件组合；Node loader/HMR 浏览器可用性由 POC 决定 |
| DC-14 | 可管理性 | `ctx.succinix.state` + 事件 + 配置热更新 + 失败隔离为一等契约 |
| DC-15 | 端口命名 | `ctx.succinix.ports` 为 canonical；不公开 `pagePorts` |
| DC-16 | 协议 | `docs/PROTOCOL.md` v1 保持不变；能力面变化不触碰 wire 层 |
| DC-17 | 单 ctx 消费者 | 不提供 client 插件形态（无第二套 ClientContext/UI 运行时）；`ctx.succinix.*` 为唯一服务面；UI（终端面板/容器视图等）由消费者（SunamAI）的 `ctx.ui` 插槽消费 |
| DC-18 | 生态兼容（可移植性） | `@succinix/engine@0.5.0` 只依赖 `cordis` peer + 自身，零 `@deepseek-ai/dsh-*` 私有依赖 |
| DC-19 | 可选注入 | rc.8 已移除 optional inject；capability 集成用 `ctx.get('capability')`，不用 `inject` |
| DC-20 | 事件契约 | `succinix/*` 类型化事件 + `ctx.succinix.on`；telemetry/进程/工作区事件全部进 C4 |
| DC-21 | 服务面补齐 | `persist`、`workspace`、`instance`、`container` 进 `ctx.succinix`，与 SunamAI §6.2 对齐 |
| DC-22 | invariant | 插件壳内置 `src/plugin/invariant.ts`，门禁扫描新插件必含 invariant |
| DC-23 | 资产完整性 | 发布物带 host/lifo SHA-256；插件加载时 `crypto.subtle` 校验（可配置关闭） |
| DC-24 | schema | 零依赖 StandardSchema V1；不强制 schemastery；发布物新增 `@standard-schema/spec` |
| DC-25 | fork 分支策略 | main 纯上游；只研究 `feat/reentrant-fiber-lifecycle` 与 `fix/lazy-entry-config-resolution`，不并入；`safe` 是旧版稳定线，不依赖 |
| DC-26 | app host | 新增 `src/host/`；业务全部进 app 插件；`src/app/main.ts` 旧入口改为转发/删除 |
| DC-27 | 单例归属 | `pagePorts`/`instancePorts`/persist context/TerminalClient channel 视为页面级单例；HostManager 统一持有时可重载复用，测试提供 reset |
| DC-28 | dispose 语义 | 默认 soft；hard 由配置/管理面显式触发；文档写明禁用前应 shutdown |
| DC-29 | app 命令域 | `succinix-app-commands` 是 app 插件，不进 `@succinix/engine` 核心；skill 桥消费 `ctx.succinix.executor` 或 app 命令服务 |
| DC-30 | 契约快照 | C1 起维护 `docs/cordis-contract.md`（或包内 contract.test.ts），防止 Succinix/SunamAI 双轨漂移 |
| DC-31 | 服务注册/消费 | `ctx.provide('succinix', service)` 注册；消费方 `inject: ['succinix']` 或 `ctx.get('succinix')`；不做顶层 mixin 扩散 |
| DC-32 | HostManager 单例 | 页面级模块单例，不属于 fiber；dispose/reload 不销毁，shutdown 才销毁；测试用 `resetPageSingletons()` |
| DC-33 | container/instance | `containerId` 即 `instanceId`；`attach`/`boot` 互斥，模式切换抛 `ERR_MODE_MISMATCH` |
| DC-34 | 配置热更新 | `fiber.update` + `internal/update`；hot = fiber reload only；requiresRestart = shutdown + reapply；`configRevision` 随 state 事件递增 |
| DC-35 | fork/npm parity | C0 用 `npm pack cordis@4.0.0-rc.8` 与 fork `f46ae95e` 比对；不一致则锁定 fork tarball 或调整 peer 范围 |
| DC-36 | state 事件载荷 | `succinix/state` 为 `{ state, reason, changed }`；`succinix/process` 是轮询聚合，非协议 push |
| DC-37 | 管理命令面 | `succinix status` + `succinix plugins` 输出状态；不做插件管理 UI |
| DC-38 | AGENTS.md 同步 | C1 更新单轨/`ctx.succinix`/新门禁，C6 收尾；AGENTS 门禁随插件边界脚本扩展 |

---

## 4. 现状与文件级迁移清单

### 4.1 当前形态（0.4.0）

- `src/engine/`：浏览器侧 TerminalClient + `createTerminalExecutor` +
  host 注入；`src/engine/host/` 与 `src/engine/lifo-core.ts` 构建为
  `public/host.js` + `public/lifo-core.js`；Pyodide daemon 构建为
  `public/pyodide/` 资产。
- `src/terminal/`：无 UI 终端交互核心（`SuccinixTerminalSession`）与 boot 编排
  （`createTerminalBoot`）。
- `src/instance/`：`createSuccinixInstance` 聚合工厂（executor/session/persist/
  services/ports/restart/dispose）。
- `src/persist/`、`src/services/`、`src/config.ts`、`src/log.ts`、`src/motd.ts`：
  系统域模块；其中 `src/services` 当前依赖 `log`、`persist`、`config`，包构建时
  已被 instance 入口 bundle 进 `dist/instance.js`。
- `src/app/`、`src/boot*.ts`、`src/main.ts`、`src/commands/`、`src/selftest/`：
  宿主应用层，当前直连内部模块。
- `packages/engine/`：0.4.0 发布包，`exports` 为 `.`、`./terminal`、`./instance`、
  `./host.js`、`./lifo-core.js`、`./package.json`。

### 4.2 迁移清单

| 路径 | 现状角色 | 0.5.0 角色 | 动作 | 阶段 |
|---|---|---|---|---|
| `src/engine/index.ts` | 包根公开 API | 内部核心 barrel，仅供插件层/测试 import | 行为零改；不再作为包根导出 | C1 |
| `src/engine/client.ts` | 文件 RPC 客户端 | 内部核心 | 零改 | - |
| `src/engine/host-route.ts` | 路由/实例归属 | 内部核心 | 零改 | - |
| `src/engine/host-procs.ts` | 进程表 | 内部核心 | 零改 | - |
| `src/engine/tokenize.ts` | 分词 | 内部核心 | 零改 | - |
| `src/engine/ports.ts` | 页面级端口分发 | 插件 ports 服务底层 | 零改 | - |
| `src/engine/python-assets.ts`、`python-daemon-client.ts` | Python 懒注入 | 内部核心 | 零改 | - |
| `src/engine/host/*`、`lifo-core.ts` | 容器内 host | 构建为 `assets/host.js`、`assets/lifo-core.js` | 零改 | - |
| `src/engine/python-daemon/*` | Pyodide daemon | 构建为 `public/pyodide/*` 并随包发布 | 零改 | - |
| `src/terminal/*` | 终端 SDK | 内部核心；插件 `terminal` 服务包装 | 行为零改；`./terminal` 子路径移除 | C1/C2 |
| `src/instance/*` | 实例聚合工厂 | 内部核心；插件 `ensureInstance` 包装 | 行为零改；`./instance` 子路径移除 | C1/C2 |
| `src/persist/*`、`src/persist.ts` | 快照持久化 | 插件 `persist`/`snapshot`/`workspace` 服务底层 | 保持内部；不公开导出 | C2 |
| `src/services/*` | 服务管理 | 插件 `services` 服务底层 | 保持内部；按需解耦 `log/config` 依赖 | C2 |
| `src/config.ts` | 系统 env/settings | 插件内部系统状态模块 | 保持；与 Cordis 插件配置分开命名 | C2 |
| `src/log.ts`、`src/motd.ts` | 系统日志/motd | app 插件内部模块 | 不对外；app 插件使用 | C3 |
| `src/plugin/` | 不存在 | 新增插件入口层 | C1 骨架，C2 完整实现 | C1/C2 |
| `src/plugin/types.ts` | 不存在 | 服务/状态/事件类型 + `Context` augmentation | C1 骨架，C2 完整 | C1/C2 |
| `src/plugin/events.ts` | 不存在 | `succinix/*` 类型化事件 + `Events` augmentation | C1 骨架，C2 完整 | C1/C2 |
| `src/plugin/host-manager.ts` | 不存在 | 页面级 HostManager 单例 | 模块单例 + `resetPageSingletons()` | C1/C2 |
| `src/host/` | 不存在 | 新增 Cordis 宿主壳 + app 插件目录 | C3 新增 | C3 |
| `src/app/*` | UI/应用特性 | app 插件/消费者 | 改造，不再直连核心模块 | C3 |
| `src/boot.ts`、`src/boot-steps.ts` | 启动编排 | 被 Cordis 启动壳替代 | 替换/删除/兼容 shim | C3 |
| `src/main.ts` | 入口 shim | 指向 Cordis 启动壳 | 改壳 | C3 |
| `src/commands/*`、`src/commands.ts` | 本地命令域 | `succinix-app-commands` | 消费 `ctx.succinix.*` | C3 |
| `src/selftest/*`、`src/tests.ts` | 自检 | `succinix-app-selftest` | 消费 `ctx.succinix.*` | C3 |
| `src/pkg/*` | 包管理命令 | `succinix-app-commands` 子模块 | 同 commands | C3 |
| `src/host-restart.ts` | app host 重启 | `succinix-app-watchdog` | 收敛进插件生命周期 | C3 |
| `src/theme.ts`、`src/util.ts`、`src/version.ts` | 共享工具 | app/共享 | 按依赖关系保留 | C3 |
| `packages/engine/*` | 0.4.0 SDK 包 | 0.5.0 插件包 | 改 exports/version/build | C1/C6 |
| `packages/engine/tsconfig.plugin.json` | 不存在 | 唯一声明产物入口 | 新增；不再产出 terminal/instance 声明 | C1 |
| `packages/engine/tsconfig.terminal.json`、`tsconfig.instance.json` | 旧声明入口 | 废弃 | 删除/归档 | C1 |
| `packages/engine/assets/sha256.json` | 不存在 | host/lifo 资产 SHA-256 清单 | 构建生成并进 files 白名单 | C1 |
| `scripts/build-engine-package.mjs` | 构建 SDK 包 | 构建插件包 | 改入口/external/声明产物/SHA | C1 |
| `scripts/build-host.mjs` | host 资产构建 | 保持不变 + 产出 SHA | 微改 | C1 |
| `scripts/check-plugin-boundaries.mjs` | 不存在 | 新增边界门禁 | C1 新增 | C1 |
| `vite.config.ts` | app bundler | 加 `@succinix/engine` alias | 开发期自消费 | C1 |
| `tsconfig.json` | 根类型 | 加 paths alias/插件测试 | 改 | C1 |
| `AGENTS.md` | 现行设计/质量门禁 | 单轨 + `ctx.succinix` 契约 + 新门禁 | C1 更新，C6 收尾 | C1/C6 |
| `public/*` | 构建产物 | 不变 | 零改 | - |
| `examples/cordis-app/` | 不存在 | 外部消费者 demo | 新增 | C5 |
| `docs/SDK.md` 等 | 0.4.0 SDK 文档 | 0.5.0 插件文档 | C6 重写 | C6 |

### 4.3 当前包导出面（0.4.0）

```jsonc
{
  "exports": {
    ".": "./dist/index.js",
    "./terminal": "./dist/terminal.js",
    "./instance": "./dist/instance.js",
    "./host.js": "./assets/host.js",
    "./lifo-core.js": "./assets/lifo-core.js",
    "./package.json": "./package.json"
  }
}
```

0.5.0 删除 `./terminal` 与 `./instance`，根导出改为插件入口，并新增 `./assets/*`。

---

## 5. 迁移阶段 C0..C6

> 依赖主线：C0 -> C1 -> C2 -> C3 -> C4 -> C5 -> C6。每个 C 完成后 commit。

### C0 Cordis 浏览器 POC（硬 gate）

**目标**：证明 Cordis core 在 Vite + WebContainer 可真实运行，产出加载器结论。

任务：

1. 建 `examples/cordis-poc/` 最小 Vite demo（或临时 `docs/cordis-poc/`）。
2. 用 fork `CJackHwang/cordis` 的 `f46ae95e` 锁定依赖。
3. 实测：
   - 函数/类/对象插件 apply -> ACTIVE -> dispose。
   - `provide`/`inject`、`ctx.events`、`ctx.logger`、`ctx.reflect`、
     `ctx.fiber` 状态迁移。
   - 同步 StandardSchema 配置校验与 ValidationError。
   - `ctx.get('capability')` 缺省路径（验证 DC-19）。
   - `@cordisjs/plugin-loader` / `plugin-hmr` / `plugin-database-memory` /
     `logger-console` 浏览器可用性；不可用的明确记录替代路径。
   - Cordis 与 `@webcontainer/api` 同包共存，无 Node builtin 冲突。
4. 若 0.5.0 骨架已存在，顺带验证插件入口可加载；否则用 stub 插件。
5. 记录 `feat/reentrant-fiber-lifecycle` 与 `fix/lazy-entry-config-resolution`
   是否需要跟进；结论只进报告，不进代码依赖。
6. `npm pack cordis@4.0.0-rc.8`（或 `npm view`）与 fork `f46ae95e` 做差异核验，
   结论决定 devDependency 锁 fork tarball 还是继续用 npm semver（DC-35）。
7. 用 stub `succinix` 服务验证消费契约：提供方 `ctx.provide('succinix', service)`，
   消费方 `inject: ['succinix']` 可访问；dispose 后消费方不可访问，reload 后恢复。

产出：

- `docs/cordis-poc-report.md`：结论、依赖集合、loader 决策、关注分支建议。

验收：

- Cordis core 生命周期全绿。
- `provide`/`inject` 服务生命周期与 reload 恢复路径有 POC 记录。
- fork/npm 一致性结论写入报告，不再停留在"应该一致"。
- loader/HMR 可用性有明确记录（可用/不可用/降级方案），不再留口头假设。
- POC 失败 = Cordis core 浏览器不可行 => 计划冻结，保留 0.4.0 独立 SDK 形态。

commit：

`chore: cordis webcontainer POC (gate for single-track)`

---

### C1 包形态改造（0.5.0 骨架）

**目标**：包结构、导出面、构建链、类型与开发期 alias 先定型。

任务：

1. `packages/engine/package.json`：
   - version `0.5.0`；
   - exports 按 2.1；删除 `./terminal`、`./instance`；
   - peerDependencies 加 `cordis >=4.0.0-rc.8`，保留 `@webcontainer/api`；
   - dependencies 加 `@standard-schema/spec`。
2. 新增 `src/plugin/`：
   - `index.ts`：`{ name: 'succinix', apply, Config }` stub；
   - `types.ts`：服务/状态/事件类型；
   - `events.ts`：`succinix/*` 事件 + `Events` module augmentation；
   - `config.ts` + `schema.ts`：schema 类型与同步校验；
   - `services.ts`、`capabilities.ts`、`lifecycle.ts`、`host-manager.ts`：
     host-manager 先落模块单例与 `resetPageSingletons()` 骨架，其余先有签名；
   - `invariant.ts`：断言工具骨架。
3. `scripts/build-engine-package.mjs`：
   - 入口改为 `src/plugin/index.ts` -> `dist/index.js`；
   - `cordis`、`@webcontainer/api` external；
   - 删除 `dist/terminal.js`、`dist/instance.js` 产物与
     `tsconfig.terminal.json`/`tsconfig.instance.json` 构建步骤；
   - 新增 `packages/engine/tsconfig.plugin.json`，产出 `dist/index.d.ts` 及全部
     插件类型；
   - 保留 host/lifo/pyodide 资产复制；
   - 为 `assets/host.js`、`assets/lifo-core.js` 生成 `assets/sha256.json`
     SHA-256 清单，并加入 package `files` 白名单；
   - 增加导出面快照校验（exports 键集合）。
4. `scripts/check-plugin-boundaries.mjs`：
   - `src/engine|terminal|instance|persist|services` 不 import `cordis`；
   - `src/plugin/` 文件必须存在 invariant 或显式豁免。
5. `vite.config.ts` + `tsconfig.json`：加 `@succinix/engine` alias。
6. `AGENTS.md`：写入单轨铁律、`ctx.succinix` 契约指针、新增
   `check:plugin-boundaries`/`check:engine-package` 门禁；旧 `./terminal`、
   `./instance` 导出不再作为对外面。

测试：

- 包 exports 键集合快照测试（`.`, `./host.js`, `./lifo-core.js`, `./assets/*`,
  `./package.json`）。
- 插件对象 shape：name/apply/Config 存在。
- `Config` 同步校验基本路径；async validator 显式拒绝。
- 类型 augmentation 编译通过：`Context['succinix']` 与 `Events['succinix/*']`
  在消费方类型上下文中可见。
- `resetPageSingletons()` 可清空页面单例，测试间不串状态。
- `npm pack --dry-run` 产物清单符合 files 白名单。

验收：

- `npx tsc -p tsconfig.json --noEmit` 0 错。
- `node scripts/build-host.mjs` 成功。
- `npm run build:engine-package` 成功。
- `npm pack --dry-run` 只含预期文件。
- `assets/sha256.json` 存在且只含 host/lifo 两条记录。
- 核心目录 grep 无 `import.*cordis`。

commit：

`feat: engine 0.5.0 plugin entry (single-track package shape)`

---

### C2 插件实现（服务 + capability + 生命周期）

**目标**：`ctx.succinix` 完整实现，SunamAI 期望的服务面全部可用。

任务：

1. `src/plugin/config.ts` + `schema.ts` 完整实现：
   - StandardSchema V1，同步校验；
   - 字段按 2.4；
   - `requiresRestart` 派生逻辑（host 资产/容器模式变化）。
2. `src/plugin/services.ts`：
   - `ctx.succinix.executor`（默认实例）；
   - `terminal.create(output, opts?)`；
   - `snapshot.save/restore/meta/clear`；
   - `persist.save/load/clear/meta/force`；
   - `workspace.restore/flush/list/stateRoot/home`；
   - `ports.list/ready/onServerReady/onServerClosed`；
   - `services.list/start/stop`；
   - `ensureInstance/releaseInstance/getInstance`；
   - `listProcesses(containerId?)`（默认实例/指定实例进程表）；
   - `attach/boot/dispose/shutdown`；
   - `reconfigure(next)` 与 `configRevision` 递增；
   - `container` 句柄与 `instance` 默认实例句柄。
3. `src/plugin/host-manager.ts`：
   - 页面级模块单例 HostManager（不属于 fiber；软 dispose 保留 host）；
   - 单 host 不变量；
   - internal/external 容器模式；
   - `attach`/`boot` 模式互斥，切换抛 `ERR_MODE_MISMATCH`；
   - `pagehide/beforeunload` flush + 最终收尾；
   - 重载软收尾语义；
   - 明确 `pagePorts`/`instancePorts`/persist context/channel 单例的归属与
     `resetPageSingletons()`。
4. `src/plugin/capabilities.ts`：
   - 本地注册表 `check/list/define`；
   - 配置 rules/defaultAllow；
   - `ctx.get('capability')` 可选集成（DC-19）。
5. `src/plugin/workspace.ts`：
   - 快照/工作区 facade 从宿主应用提取；
   - 路径规范复用 `src/instance/paths.ts`；
   - 端口聚合收敛为 `ports`（不公开 `pagePorts`）。
6. `src/plugin/assets.ts`：
   - 资产 URL 解析、SHA-256 校验、注入幂等；
   - Python 资产基址策略（Vite public 优先，回落注入）。
7. 依赖收敛：
   - `src/services` 对 `log/config` 的依赖由插件注入或移动到
     `src/plugin/system/`；核心行为不变。
   - `ensureInstance` 的 `output` 缺省为 no-op，支持 headless agent。
8. 领域事件按 2.3 实现：
   - `succinix/state`、`server-ready`、`server-closed`、`command`、`instance`、
     `workspace`、`process`；
   - `succinix/state` 载荷为 `{ state, reason, changed }`；
   - `command` 事件补 `startedAt/durationMs/pid/error`（J1）。
9. 消费契约测试路径：
   - 消费方 `inject: ['succinix']` 正常加载；
   - `ctx.get('succinix', false)` 在服务未提供时返回 undefined，不抛错；
   - engine dispose 后消费方 fiber 被刷新，reload 后恢复。

测试：

- 配置 schema：合法/非法/未知字段/async 拒绝语义 >= 8。
- 生命周期：boot/ACTIVE/dispose/reload 不重启 host/shutdown kill
  host/幂等/失败状态 >= 12。
- 单 host：重复 attach、重复 boot、多实例不 spawn 第二个 host >= 5。
- 服务消费：inject 加载/未提供 fallback/dispose 后不可用/reload 恢复 >= 4。
- HostManager 单例：fiber dispose 后实例仍存在、shutdown 后 reset、
  `resetPageSingletons()` 隔离测试 >= 3。
- 能力：注册/默认放行/配置拒绝/`ctx.get('capability')` 宿主覆盖/list >= 6。
- 服务面：executor/terminal/snapshot/persist/workspace/ports/services 引用与
  调用 >= 8。
- 端口：ready/subscribe/unsubscribe/重载清理 >= 5。
- 资产：SHA 校验、缺省关闭、注入幂等 >= 3。
- invariant：插件壳入参/出参断言 >= 3。

验收：

- `npx tsc` 0 错；lint；相关单测；`npm run test` 全绿。
- 核心逻辑文件 git diff 无行为改动。
- `grep -n 'import.*cordis' src/engine src/terminal src/instance src/persist
  src/services` 无匹配。
- `ctx.succinix` 形状与 SunamAI `PLAN-succinix-embed.md` §6 对齐，且包含
  `persist`、`workspace`、`instance`、`container`。
- 发布 .d.ts 含 `Context['succinix']` 与 `Events['succinix/*']` augmentation，
  外部 demo 的消费方类型检查通过。
- HostManager 单例测试证明 reload 不重启 host，shutdown 后页面单例归零。

commit：

`feat: engine plugin (services, capabilities, lifecycle)`

---

### C3 宿主应用 Cordis 化（自证）

**目标**：Succinix 自带 app 从"直连内部模块"变为"Cordis app 消费自己的插件"。

任务：

1. 新增 `src/host/main.ts`：
   - 创建 `Context`；
   - 内存配置树（`src/host/plugins.ts`，或构建期 config 转 JS）；
   - 注册 `@succinix/engine`；
   - 注册 app 级插件；
   - 保持 `?test=1`、`?bench=1`、`?scenario=1` 的 window 句柄。
2. app 级插件拆分：

| 插件 | 现状 | 消费面 |
|---|---|---|
| `succinix-app-container` | `src/boot.ts`、`boot-steps.ts` | 环境检查 + `ctx.succinix.boot` + app boot steps |
| `succinix-app-terminal` | `src/app/xterm.ts`、`output.ts`、`local-commands.ts` | `ctx.succinix.terminal.create` |
| `succinix-app-commands` | `src/commands/*` | `ctx.succinix.executor` / `instance.*` / `services` / `ports` |
| `succinix-app-snapshot` | `src/app/auto-snapshot.ts` | `ctx.succinix.snapshot` / `persist` |
| `succinix-app-watchdog` | `src/app/watchdog.ts`、`host-restart.ts` | `ctx.succinix` 生命周期/executor |
| `succinix-app-selftest` | `src/selftest/*`、`tests.ts` | `ctx.succinix.*` |
| `succinix-app-devhooks` | `src/app/dev-hooks.ts` | 保留场景/bench 句柄 |

3. `CommandContext` 更新：宿主面不再直接持有 `TerminalClient`，改为
   `ctx.succinix` 服务句柄或实例句柄；命令输出语义不变。
4. `src/boot.ts`、`src/main.ts`、`src/app/main.ts` 收敛为 Cordis 启动壳的薄
   转发或删除；e2e/bench/scenario 脚本依赖的 window 句柄保持。
5. 自检 `?test=1`、`?bench=1`、`?scenario=1` 在 Cordis 形态下全量通过。

测试：

- app 插件生命周期测试 >= 6。
- 命令/自检断言值不因装配方式变化而变。
- e2e：`?test=1` selftest 全绿；bench 首提示符；scenario 命令序列。

验收：

- `npm run build` 成功；dev server `localhost:7892` 带 COOP/COEP。
- `rg 'from .*src/(engine|terminal|instance|persist|services)' src/app src/host
  src/commands src/selftest src/main.ts src/boot.ts` 无匹配（兼容 shim 除外，
  最终删除）。
- app 只消费 `@succinix/engine` 与 app 插件自身。
- 单 host 不变量、多实例 demo（`?instance=`/`?user=`）行为不变。

commit：

`refactor: host app as cordis consumer (self-verification)`

---

### C4 可管理性（状态/重载/失败隔离/telemetry/replay 调研）

**目标**：插件不只是能加载，还能被查看、启停、重载、失败隔离，并补齐 DSH
J1/J2/J3/J5 的 Succinix 侧数据面。

任务：

1. `ctx.succinix.state` 完整实现并按 `succinix/state` 事件广播。
2. 配置热更新：
   - 管理面走 `fiber.update(next)` 或 `ctx.succinix.reconfigure(next)`；
   - 可热更新字段只触发 fiber reload（HostManager 保留 host）；
   - 需重启字段先 `shutdown()` 再 reload；
   - 每次生效递增 `configRevision` 并以 `succinix/state`（reason=config）广播；
   - 校验失败保留上次有效配置并进入 FAILED，`lastError` 可读。
3. 重载测试：
   - 模拟 fiber dispose + reapply；
   - 断言 host pid 不变；
   - 断言实例引用按策略重建或复用；
   - 断言端口/命令订阅无泄漏。
4. 失败隔离：
   - apply 抛错；
   - config 非法；
   - host boot 失败；
   - `ctx.get('capability')` 注入失败/缺失；
   - 任一 app 插件 FAILED 不影响 engine 服务与其他 app 插件；
   - engine 插件 FAILED 时 host 由 HostManager 单例保留，reapply 修复。
5. Succinix app 增加最小管理入口 `succinix status`，输出
   `ctx.succinix.state`；另加 `succinix plugins` 列出 registry 中各 fiber 状态；
   完整管理 UI 归 SunamAI。
6. Telemetry（J1）：
   - `succinix/command` 事件含耗时/退出码/runtime/pid；
   - `ports` 与 `listProcesses()` 作为状态栏指标数据源。
7. Session/event 边界（J2）：
   - Succinix 只提供 exec/process/port 事件；
   - turn/trigger/session 语义归 SunamAI 层，不向上渗漏。
8. Replay 调研（J3，独立任务）：
   - 评估 executor 确定性边界：幂等命令、时序、随机性、输出 document 重放；
   - 产出 `docs/replay-support.md`，结论决定 SunamAI replay 支持度
     （全量/受限/不支持）。
9. Context injection 事件（J5）：
   - `succinix/workspace` 事件覆盖快照 save/restore/clear；
   - WebContainer 原生文件 watch 可用性做 POC 调研；不可用则只暴露已知变更源，
     不模拟 watch。
10. 事件载荷补全：
    - `succinix/state` 带 `reason` 与 `changed`（2.3）；
    - `succinix/process` 由轮询 `listProcesses()` 聚合后广播，不做协议 push；
    - 订阅/退订计数在 reload 后归零，作为订阅泄漏断言。

测试：

- 状态/事件订阅与退订 >= 6。
- state 事件 `reason/changed` 载荷断言 >= 2。
- 热重载原子性 >= 3。
- 失败隔离 >= 5。
- 订阅泄漏（重复 attach/reload/dispose）>= 4。
- telemetry 事件载荷断言 >= 3。
- `succinix status`/`succinix plugins` 输出断言 >= 2。
- replay 调研报告含确定性结论 >= 1。

验收：

- 所有可管理性测试全绿。
- `succinix status` 与 `succinix plugins` 在自带 app 可运行。
- 文档记录 `ctx.succinix.state` 与事件，SunamAI plugin-manager 可按此实现。
- `docs/replay-support.md` 已产出。

commit：

`feat: succinix plugin manageability (state, reload, failure isolation, telemetry)`

---

### C5 外部 demo + SunamAI 契约复验

**目标**：证明发布物可用，且与 SunamAI 约定的 API 完全一致。

任务：

1. 新增 `examples/cordis-app/`：
   - 独立 Vite app；
   - 依赖 `cordis` + `@succinix/engine`（本地 `file:` 或 `npm pack` 产物）；
   - 不依赖 Succinix 仓库源码。
2. demo 覆盖：
   - `node -e` 真 Node；
   - lifo 命令；
   - `ensureInstance` 多实例不 spawn 新 host；
   - 快照 save/restore；
   - 端口订阅；
   - reload 不重启 host；
   - 消费方 `inject: ['succinix']` 可用、未注入 fallback 路径明确；
   - `attach`/`boot` 模式互斥抛 `ERR_MODE_MISMATCH`；
   - `shutdown` 干净收尾；
   - 资产 SHA 校验。
3. 契约测试文件（可复制到 SunamAI 侧做互测）：
   - `ctx.succinix.executor`、`ensureInstance`、`terminal`、`snapshot`、
     `persist`、`workspace`、`ports`、`instance`、`container` 存在且类型符合；
   - 消费方插件声明 `inject: ['succinix']`，发布物 `.d.ts` 支持
     `ctx.succinix` 与 `ctx.on('succinix/...')` 类型检查；
   - engine dispose 后服务不可访问，重新 apply 后恢复；
   - capability pattern 集合与 SunamAI §6.4 一致。
4. 与 0.4.0 行为对照：同命令序列输出一致（node/lifo/python/服务/快照）。

验收：

- demo 只依赖发布物即可运行。
- 浏览器实测全流程通过。
- SunamAI 契约测试通过。

commit：

`feat: external cordis demo (published-artifact verification)`

---

### C6 破坏性发布 + 全量文档迁移

**目标**：0.5.0 正式发布，旧形态 deprecate，文档全部迁移。

任务：

1. npm：
   - `@succinix/engine@0.5.0` publish（breaking change）；
   - `0.4.0` 与 `0.1.0..0.1.3` 全部 deprecate，提示迁移到 0.5.0。
2. `CHANGELOG.md`：
   - breaking 清单：exports 变化、SDK 直调 -> Cordis 插件、生命周期归属、
     配置方式、`pagePorts` -> `ports`。
3. `docs/MIGRATION.md`：
   - 0.4.0 -> 0.5.0 迁移指南；
   - API 映射表：
     `createTerminalExecutor` -> `ctx.succinix.executor`；
     `createSuccinixInstance` -> `ctx.succinix.ensureInstance`；
     `./terminal` -> `ctx.succinix.terminal.create`；
     `./instance` -> `ctx.succinix.ensureInstance`；
     `onServerReady` 配置回调 -> `ctx.succinix.onServerReady`。
4. `docs/SDK.md` 重写为插件形态：安装、配置、服务面、capability、生命周期、
   热重载语义、container mode。
5. `README.md`、`docs/FEATURES.md`、`docs/README.zh-CN.md`、SDK 中文版同步。
6. 新增 `docs/PLUGIN.md`：第三方如何作为 Cordis 插件接入/扩展 Succinix。
7. 新增 `docs/cordis-contract.md`（或 `examples/cordis-app/contract.test.ts`
   作为唯一权威快照）。
8. `docs/PLAN-cordis.md` 执行记录补全为历史档案，不再作为待办规格。

验收：

- `npm pack --dry-run` 产物正确。
- 外部 demo 用发布后的 tarball 复验通过。
- `npm run check:docs` 通过。
- 迁移指南示例代码可运行。

commit：

`feat!: publish engine 0.5.0 breaking (cordis plugin single-track, docs migrated)`

---

## 6. 测试与 CI

### 6.1 测试分层

| 层 | 内容 | 工具 |
|---|---|---|
| 插件单测 | Config schema、生命周期、单 host、能力、事件、状态、资产、invariant | Vitest |
| 核心单测 | engine/terminal/instance/persist/services 既有测试保持 | Vitest |
| app 集成 | Cordis app 启动、命令、自检、bench/scenario | Vitest + e2e |
| 浏览器实测 | WebContainer + host + 多实例 + 快照 + reload + 资产 SHA | Playwright/runtime e2e |
| 外部 demo | 只依赖发布物 + 契约测试 | Vite + Playwright |

### 6.2 新增单测优先级

- 配置 schema >= 8；
- 插件生命周期 >= 12；
- 单 host/幂等 >= 5；
- 服务消费/inject（含未提供 fallback、dispose 后不可用、reload 恢复）>= 4；
- HostManager 单例/reset（fiber dispose 保留、shutdown 归零、测试隔离）>= 3；
- capability（含 `ctx.get('capability')`）>= 6；
- 服务面（executor/terminal/snapshot/persist/workspace/ports/services）>= 8；
- 可管理性/事件 >= 6；
- state 事件 `reason/changed` 载荷 >= 2；
- 重载原子性 >= 3；
- 失败隔离 >= 5；
- 资产完整性 >= 3；
- invariant >= 3；
- fork/npm 一致性（C0 报告）>= 1；
- 外部 demo 契约测试 >= 6。

### 6.3 门禁脚本

- 保持：`npm run typecheck`、`npm run lint`、`npm run test`、
  `npm run build`、`npm run audit:files`、`npm run check:static`、
  `npm run check:docs`。
- 新增：
  - `check:plugin-boundaries`：核心目录不 import `cordis`；插件文件含 invariant；
  - `check:engine-package`：构建插件包 + 导出面快照 + SHA 清单 +
    `npm pack --dry-run`；
  - `check:docs` 覆盖新增 `PLUGIN.md`/`MIGRATION.md`/`cordis-contract.md`。
- AGENTS.md 质量门禁持续生效：
  `npx tsc -p tsconfig.json --noEmit`、`node scripts/build-host.mjs`、
  `npm run build`、dev server COOP/COEP、`grep -n '✅\|❌\|🎉\|GREEN' src/ index.html`
  无匹配。

---

## 7. 回滚策略

- 每 C 独立 commit；回滚粒度 = 单个 C。
- C0 gate 失败：冻结计划，保留 0.4.0 独立 SDK；损失 = POC 时间。
- C1 前保留 `packages/engine` 0.4.0 产物副本（git tag 或 dist 副本），可随时 revert。
- C3 宿主改造前保留旧 `src/boot.ts` 路径；C3 完成后用 e2e 判定再删兼容 shim。
- C4/C5 不改变协议与核心逻辑，失败最多回退到 C2/C3 状态。
- C6 发布后按 semver；若 0.5.0 有阻断问题，发 0.5.1 修复，不回滚 npm。

---

## 8. 风险与已知边界

| 风险 | 等级 | 缓解 |
|---|---|---|
| Cordis rc API 变动 | 高 | fork 锁定 `f46ae95e`；升级单独立项 |
| `feat/reentrant-fiber-lifecycle` 未并入 | 中 | 只研究不依赖；插件资源全走 `ctx.effect`，重入安全写法进单测 |
| `@cordisjs/plugin-loader` 浏览器不可用 | 中 | 默认静态组合；POC 记录真实结论；不模拟 Node loader |
| `@cordisjs/plugin-hmr` 浏览器不可用 | 中 | 内存配置树 + fiber 重建 + 软 dispose；自定义 overlay 归 SunamAI |
| SunamAI 契约漂移 | 中 | C2 形状对齐 + C5 契约测试复制到 SunamAI 侧；本计划修正 §1.4 编号 |
| reload 与 host 生命周期冲突 | 中 | 软 dispose + HostManager + 明确 shutdown 语义 + 单测 |
| fork 与 npm rc.8 发布物不一致 | 中 | C0 `npm pack` 比对；锁定 fork tarball 或调整 peer 范围 |
| 可选注入被移除 | 中 | `ctx.get('capability')` 探测；不声明 optional inject |
| 消费方未 inject 直接访问 `ctx.succinix` | 低 | 类型 augmentation + 文档；C5 demo 覆盖 inject/fallback |
| 宿主 app 改造回归 | 中 | C3 全量 selftest + e2e；旧 boot 路径保留到 C3 验收 |
| 页面级单例跨 reload 泄漏 | 中 | HostManager 统一持有；测试 reset；订阅计数断言 |
| capability 语义不一致 | 中 | pattern 清单 + 默认放行 + 宿主覆盖测试 |
| 配置放函数 | 中 | schema 只允许可序列化字段；运行时钩子走事件 |
| 资产被篡改/缓存旧版 | 中 | SHA-256 清单 + 加载校验（可配置关闭） |
| bundle 膨胀 | 中 | `cordis`/`@webcontainer/api` external；host/lifo 保持懒加载 |
| 0.4.0 用户困惑 | 低 | deprecate 提示 + MIGRATION；已知当前零消费者 |
| Pyodide 资产体积 | 低 | 懒注入不变；发布物继续带 assets |
| `safe` 分支误读为 4.0 rc | 低 | 文档标注它是 v3.18.1 旧稳定线，不基于它 |

边界：

- 浏览器无 Node loader；不承诺运行时插件市场。
- 无真实内核/apt/native binaries；不模拟 chmod 权限位。
- 多实例是组织性隔离，不是安全边界。
- Firefox/Safari/mobile 不支持（沿用环境检查错误页）。
- 协议 v1 不变；端口是虚拟 preview。
- WebContainer 无原生文件 watch 时不模拟；工作区事件只覆盖已知变更源。

---

## 9. Definition of Done

- [ ] C0 POC 通过，`docs/cordis-poc-report.md` 存档
- [ ] C0 报告包含 loader/hmr/database-memory/logger-console 可行性、fork/npm
      一致性、provide/inject 生命周期结论
- [ ] `@succinix/engine@0.5.0` 发布 npm（breaking change，插件形态）；
      0.4.0 与 0.1.x 已全部 deprecate
- [ ] 包 exports 只有 `.`、`./host.js`、`./lifo-core.js`、`./assets/*`、
      `./package.json`
- [ ] `ctx.succinix.executor/ensureInstance/terminal/snapshot/persist/workspace/
      ports/instance/container` 与 SunamAI 计划对齐
- [ ] `ctx.succinix` 注册/消费契约有测试：inject 可用、fallback 明确、
      dispose 后不可用、reload 恢复；发布 .d.ts 含 augmentation
- [ ] capability 面完整：terminal.exec/spawn/kill/interrupt、fs.read/write、
      workspace.restore/flush/list
- [ ] 配置 schema 同步校验，只含可序列化字段；回调全部走事件/服务订阅
- [ ] 单 host 不变量 + attach/boot 幂等 + reload 不重启 host（单测断言）
- [ ] HostManager 为页面级模块单例：fiber dispose 保留、shutdown 归零、
      `resetPageSingletons()` 测试隔离
- [ ] dispose 软收尾、shutdown 完全关闭、重复调用幂等
- [ ] 核心逻辑（src/engine、src/terminal、src/instance）git diff 无行为改动
- [ ] 核心目录 grep 无 `import.*cordis`（仅 `src/plugin/` 允许）
- [ ] 宿主应用 = Cordis app，无核心模块直接 import（兼容 shim 已删）
- [ ] `succinix status`（或等价管理入口）可显示插件状态
- [ ] `succinix/*` 类型化事件 + command telemetry 载荷已实现，state 事件带
      `reason/changed`
- [ ] `docs/replay-support.md` 已产出，J3 结论明确
- [ ] 外部 demo（仅发布物依赖）全流程通过
- [ ] `docs/MIGRATION.md`、`SDK.md`、`PLUGIN.md`、`cordis-contract.md`、
      README、FEATURES 已迁移
- [ ] `AGENTS.md` 已同步单轨、`ctx.succinix` 契约与新增门禁
- [ ] CHANGELOG breaking 清单完整
- [ ] 全量测试 + AGENTS 门禁全绿（tsc/build-host/build/COOP-COEP/static check）

---

## 10. 执行记录（每 C 完成后追加）

- C0 Cordis POC：___
- C1 包形态骨架：___
- C2 插件实现：___
- C3 宿主应用 Cordis 化：___
- C4 可管理性 + telemetry/replay 调研：___
- C5 外部 demo + SunamAI 契约复验：___
- C6 发布 + 文档迁移：___

---

## 11. 参考文档

- SunamAI `docs/PLAN-succinix-embed.md`（§1.3 阶段编号已与本计划 §1.4 核对一致）
- DSH 情报档案 `~/Desktop/ds_harness_leak/03-analysis/dsh-technical-report.md`
- DSH 设计模式档案 `~/Desktop/ds_harness_leak/03-analysis/05-design-patterns.md`
- Cordis fork `~/Desktop/MyProject/cordis`，
  `origin/sunam-planning:docs/sunam-ai-plugin-plan.md`
- `docs/PROTOCOL.md`（v1 保持不变）

---

## 12. DSH 技术借鉴调研清单（对接面）

> SunamAI 采纳 dsh 的 **10 项**技术借鉴（DM-43/13.6，①-⑩），其中 **8 项**需要
> Succinix 作为对接方调研/配合（J1-J8；④ LLM 五件套 / ⑨ systemPrompt 随插件分发 /
> ⑩ 真实 Context 单测范式为 SunamAI 内部结构，无 Succinix 对接面）。本计划把
> 每项绑定到具体契约与产出。

### 12.1 对接面清单

| # | SunamAI 借鉴项 | Succinix 对接内容 | 产出/阶段 |
|---|---|---|---|
| J1 | ② Telemetry 指标集 | `succinix/command` 事件含耗时/退出码/runtime/pid；`listProcesses()`、`ports` 作为指标源 | C2 事件 + C4 验收 |
| J2 | ③ session 事件模型 | exec/process/port 事件提供给 SunamAI 聚合；turn/trigger 语义归 SunamAI | C4 边界文档 |
| J3 | ⑤ replay 确定性回放 | 调研 executor 确定性边界，产出 `docs/replay-support.md` | C4 独立任务 |
| J4 | ⑥ skill 系统 | `succinix-app-commands` 暴露命令面；skill 桥消费 `ctx.succinix.executor` 或 app 命令服务 | C3/C4 |
| J5 | ⑦ Context injection 事件化 | `succinix/workspace` 事件 + 已知变更源；原生 watch 只做 POC | C2/C4 |
| J6 | ① invariant 模式 | `src/plugin/invariant.ts` 入参/状态/出参断言；门禁扫描 | C1/C2 |
| J7 | ⑧ profile 装配 | `external` 模式兼容任意 profile；宿主装配对 Succinix 无感 | C1 |
| J8 | 质量体系：资产单一来源 | host/lifo 资产 SHA-256 清单与加载校验 | C1/C2 |

### 12.2 边界（明确不做）

- Succinix 不实现 Telemetry UI、不实现 session turn 语义、不实现 skill 管理器、
  不实现 plugin manager UI——这些是宿主角色的职责（DC-17 单 ctx 消费者）。
- Succinix 只保证数据供给与事件暴露。

---

*PLAN by Codex + Succinix/SunamAI 计划核对。2026-08-13。执行中规格与实现冲突
以实际代码为准并记录差异，不静默改规格。*
