# MASTER PLAN: Succinix 平台化 —— 组件化 SDK → 多实例 → 多用户

> 2026-08-10 定稿。**本计划只覆盖 Succinix 单一项目**；SunamAI 集成是
> Succinix 平台化完成后的独立后续计划（届时 SunamAI 作为宿主消费 instance API），
> 不在本文件范围。
> 执行者：Claude Code（用户一次性连续开发）。本文件是唯一规格来源：
> 按阶段顺序推进，每 TASK 过完门禁 + commit 再进下一个；阶段间有强制验证点（§5）。

---

## 0. 愿景：Succinix 的终点

Succinix 从"一个浏览器 Linux 应用"进化为**可嵌入的多租户 Linux 运行时**：

```
L0 单实例（现状 0.3.0）      L1 SDK 化               L2 多实例               L3 多用户 API
┌──────────────────┐   ┌────────────────────┐   ┌────────────────────┐   ┌─────────────────────┐
│ main.ts 单体     │→  │ SuccinixTerminal   │→  │ createSuccinix      │→  │ 多用户语义定型       │
│ (交互+装配混合)  │   │ Session + Boot 参数 │   │ Instance 聚合 API   │   │ (组织性隔离,文档化)  │
└──────────────────┘   └────────────────────┘   └────────────────────┘   └─────────────────────┘
  engine（已有）          + terminal 导出          + persist 多 key         + 每用户 home/进程/快照
  persist 单 key         独立应用不回归            + /etc 按实例前缀          + 独立应用 guest 不变
  /etc 全局                                       + 协议 instanceId
```

- **独立应用**（succinix.alibicore.com）：guest 单用户形态全程不回归。
- **生态价值**：任何宿主（SunamAI 是第一个潜在消费者）未来可
  `createSuccinixInstance({ userId })` 获得完整多租户 Linux —— 本计划的出口。
- **隔离性质（必须如实标注）**：浏览器沙箱无真内核/权限位，"多用户/多实例"是
  **组织性隔离**（目录/状态/进程视图分层），**不是安全隔离**。此声明写入 SDK.md
  （多实例/多用户文档节）与 AGENTS.md（Explicitly Not Implemented 列表，多用户条目）。

---

## 1. 现状与已验证事实（2026-08 实测）

- `src/engine/` 已 SDK 化：`createTerminalExecutor()`（boot/exec/spawn/listProcesses/
  kill/ping/pingDirect/respawn/dispose）+ `TerminalClient`（含 interruptDirect）+
  `bootEngineHost`/`waitForHostReady`。自包含（`grep node: dist/` 空）。
- `src/main.ts`（729 行）：单例终端应用 —— xterm + 交互状态机（历史/补全/真中断/
  队列/提示符 cwd）+ 应用特性（看门狗/自动快照/?bench=1/?scenario=1 hooks）。
- `src/boot.ts`（448 行）：`bootSuccinix(ui: BootUI)`，12 步 boot + 环境检查 +
  资产预取 + 重试（bootWebContainerWithRetry/waitForHostReadyWithRetry）。
- `src/commands.ts`（1417 行）：25 个浏览器侧本地命令（help/clear/sysinfo/ports/db/
  snapshot/free/top/cache/reboot/shutdown/env/settings/workspace/service/log/pkg/
  netstat/ip/uname/motd/lang/pwd/version/whoami），走 `tryHandleLocalCommand`。
- `src/persist.ts`（392 行）：IndexedDB `succinix-persist` 库 / `current` key，
  force 语义 + 30s age-force + 内容签名去重。
- 门禁基线：tsc 0 / lint 0 / vitest 118 / `?test=1` ≥71 passed / grep emoji 0。
- 包：`@succinix/engine` 0.1.4（exports `.` + `./host.js`/`./lifo-core.js`）。
- 物理边界（AGENTS.md）：不做真内核/apt/原生二进制、不做登录仪式/权限位、
  不做 REPL stdin、不做 symlink。**多用户条目当前为"❌ 已砍"，U1 改为
  "组织性隔离，嵌入模式可用"**。
- 基础设施：Vercel git 集成自动部署（push main 自动上线）；npm 发布链路已通
  （granular token bypass 2FA）；GitHub HTTPS push（SSH 22 被墙）；
  依赖仓库改 host 产物必须同步发包（CIRUNTIME 教训）。

---

## 2. 目标架构

```
@succinix/engine（npm 包，独立 **0.1.x 线**，随 0.4.0 应用版本一次性发布：
                 terminal 导出 + 实例 API + 多用户全量）
├─ createTerminalExecutor()          [已有] 命令式接口（Agent/宿主通道）
├─ SuccinixTerminalSession           [E1]  终端交互核心（无 UI：历史/补全/真中断/队列/cwd）
├─ TerminalBoot + BootUI             [E2]  boot 流程参数化（steps 数组，宿主可自定义）
├─ persistenceKey 注入               [M1]  IndexedDB 按实例分割
├─ 状态文件路径参数化                [M2]  /etc → per-instance 前缀（浏览器+host）
├─ 协议 instanceId（additive）       [M3]  /cmd.json 可选字段，host 按实例路由
├─ per-instance 服务/端口/db 视图    [M4]  service/ports/db 按实例
├─ createSuccinixInstance()          [M5]  聚合 API：{ terminal, executor, snapshot, services }
├─ 多用户语义定型                    [U1]  userId/instanceId 等价，组织性隔离文档化
└─ assets/host.js + lifo-core.js     [已有]
```

**分层边界（写代码时严格遵守）**：
- `SuccinixTerminalSession` / `TerminalBoot` **不 import xterm/DOM/persist/log/config/
  commands**。只依赖窄接口（TerminalRpc/TerminalOutput/BootUI）+ 注入选项。
- 浏览器侧本地命令（commands.ts 全家）不进 SDK 核心 —— 走 `localHandlers` 注入。
- 应用特性（看门狗/自动快照/bench/scenario hooks）留在 main.ts（应用层），不进 SDK。
- 实例化（M 系列）的改动落在 persist/commands/host 的参数化层，SDK 核心形态不变。

**实例隔离模型（同页 vs 跨容器 —— 必须如实区分，不混为一谈）**：
- **跨容器隔离（每 Tab / 每 WC）** = 每实例独立 host 进程 + 独立 Lifo sandbox + 独立
  IDB key，隔离完整。`?instance=`/`?user=` demo 与 0.4.0 验收**全部基于此**。
- **同页多实例（未来宿主如 SunamAI 的目标形态）** = 共享一个 host 进程 + 一个 Lifo
  sandbox + 一条 `/cmd.json` 单槽通道。此时**只有持久化/快照/服务与端口视图**按实例
  隔离；**命令运行时共享**（Lifo 交互 cwd 页面级，每实例 cwd 是浏览器侧逻辑值）。
  同页路径有 3 个必须事先定死的架构约束（同页共享 RPC 通道 / 单看门狗 / 端口按
  实例归属），否则双 tab demo 全绿、同页一接就挂 —— 定稿见 DM-11 / DM-12，拆解见
  M1/M3/M4/M5 的"同页"节。
- **术语锚点（全文档统一）**："同页共享"与"页面级（per-page）"是同一事实的两个
  视角，不是两种模式 —— **资源按页面粒度一份（per-page）→ 同页多实例共享它
  （同页共享）**。正文两者可互换使用，语义等价；"per-instance"（按实例各一份）
  是它的对立面（如持久化/快照/服务/端口视图）。

---

## 3. 保留项铁律（任何 TASK 不许改）

1. **文件 RPC 协议**：`/cmd.json` → `/result-<id>.json`，每请求独立结果文件；
   命令集 run/ps/kill/spawn/cwd/ping/exit + interrupt。`docs/PROTOCOL.md` 权威。
   M3 的实例上下文扩展**必须 additive**（可选字段，不带 = 默认实例，旧行为不变）。
2. **统一路由**：node|npm|npx|python 前缀 → 真执行；其余 → Lifo；含 shell 元字符
   → 整条回退 Lifo shell。改路由 = 改 host，禁止。
3. **host 注入顺序**（CIRUNTIME 根因）：先 ensureAsset(lifo-core) → 再 spawn host.js
   → 再 ping 探活。任何重构不得破坏。
4. **单 host 不变量**：多实例/多用户仍是**一个大 host 进程**，实例是逻辑层。
   禁止为每实例 spawn 独立 host（双 host 竞态族）。
5. **物理边界**：不做真内核/apt/原生二进制、不做登录仪式/权限位、不做 REPL stdin、
   不做 symlink。多实例/多用户是组织性隔离，如实标注非安全边界。
6. **质量门禁**：tsc 0 / build-host.mjs 成功 / npm run build 成功 / grep emoji 0 /
   `?test=1` ≥71（且各阶段自检数不降）。
7. **独立应用不回归**：boot 观感、`?test=1`/`?bench=1`/`?scenario=1` hooks、
   全量本地命令、guest 单用户语义 —— 每阶段末回归实测。
8. **代码风格**：注释中文、标识符英文、TS strict、禁 emoji；SDK 核心（terminal/
   engine）**零新增依赖**（xterm 只在应用层）。
9. **`@succinix/engine` 自包含**：`grep -rn "node:" dist/` 为空；host 资产不引用
   node: 模块；包不含 pyodide（现状）。
10. **发布纪律**：改 host 产物的 TASK 必须 `build-host.mjs` 重建（+ 记录待发布
    版本）。远程副作用（push/publish/部署）**不由 CC 执行**，由用户/Hermes 确认后做。

---

## 4. 决策点定稿（DM-1 ~ DM-12）

| # | 决策 | 定稿 |
|---|---|---|
| DM-1 | 本地命令启用集 | 独立应用**始终全量**（现状不变）。多实例 demo 模式（`?instance=<id>`）默认与单实例一致；M4 实现 per-instance 语义后管理类命令（snapshot/service/reboot）按实例生效，无需裁剪。 |
| DM-2 | 快照持久化 | persist 支持 per-instance key（M1）；默认实例 key 与现状全等。多实例各自快照/恢复。 |
| DM-3 | session 的 RPC 依赖面 | **已定**：窄接口 `TerminalRpc`（exec/spawn?/listProcesses?/kill?/ping/pingDirect?/interruptDirect?，可选方法安全降级），测试注入 fake。 |
| DM-4 | xterm 适配器归属 | **已定**：SDK 只定义 `TerminalOutput { write; clear }`；xterm 适配器在应用层（main.ts）写薄适配（≤10 行）。SDK 不依赖 @xterm/xterm。 |
| DM-5 | boot 步骤配置 | **已定**：`TerminalBootOptions.steps: string[]`，编号 N/M 自动；独立应用 12 步不变。宿主（未来）传自己的步骤清单。步骤文案必须与真实状态绑定（TERMBOOT 教训）。 |
| DM-6 | npm 版本节奏 | **已定**：主项目走 `0.x` 线，**全部 TASK 完成后一次性发布 `0.4.0`**（terminal 导出 + 实例 API + 多用户全量；中间不发布）；`@succinix/engine` 独立走 `0.1.x` 线（本次随 0.4.0 发布 0.1.4，见 SDK.md 版本策略节）。各阶段只做本地打包验证（`npm pack` + 干净目录安装），版本 bump 与发布统一在 F 阶段后由用户/Hermes 执行。 |
| DM-7 | 提示符 cwd 跟随 | **已定**：SDK 内实现（session 维护 cwd，`cd` 成功更新，渲染 `guest@succinix:<短路径>$`，/workspace→~）。 |
| DM-8 | 实例标识 | **已定**：`instanceId: string`；缺省 `'default'` = 单实例路径（全等现状）。demo 用 `?instance=<id>` URL 参数启动指定实例。 |
| DM-9 | 实例 API 形态 | **已定**：工厂 `createSuccinixInstance({ wc, instanceId, statePrefix?, persistence?, terminal?, executor?, rpc?, bootUI?, bootSteps? })` → `{ terminal, executor, snapshot, services, restart, dispose }`（rpc = 同页共享通道，见 M5）。 |
| DM-10 | 多用户语义 | **已定**：`userId` 与 `instanceId` 等价（同一字段）；home 目录约定 `/workspace/users/<id>`（宿主可覆盖）；组织性隔离声明写入 SDK.md（多实例/多用户节）+ AGENTS.md（Explicitly Not Implemented 列表）。 |
| DM-11 | 同页多实例语义 | **已定**：0.4.0 只承诺并验证**跨容器隔离**（每 Tab/每 WC = 独立 host + 独立 sandbox + 独立 IDB key）。同页同时创建多个实例走**共享运行时**：一个页面一条 RPC 通道（同一 TerminalClient/executor + 单看门狗，见 M5），请求带 instanceId；Lifo 交互 cwd 页面级（不按实例同步），每实例 cwd 是浏览器侧逻辑值，node/python spawn 用显式绝对 cwd。此边界写入 SDK.md"多实例"节。 |
| DM-12 | 实例状态根命名与进程归属 | **已定**：实例状态根用 `/workspace/.succinix-<id>`（M2）；host-procs 的归属判定**同步扩展** —— 在现有 `c-<id>` 段模式之外，额外匹配 `.succinix-<id>` 根段（与 CISOL 的 `c-<id>` 命名空间共存，不冲突）。M3/M4 的"cwd 前缀匹配 / ps 过滤 / kill 越权"一律以 stateRoot 为准。 |

---

## 5. 开发顺序总览（3 阶段 · 10 TASK）

```
阶段 0 · EMBED-SDK（组件化）             验证点：?test=1 + 浏览器实测 + 本地打包验证
  E1 提取 SuccinixTerminalSession ────────┐
  E2 boot 流程参数化 ─────────────────────┤
  E3 main.ts 组装层重构（依赖 E1+E2）─────┤
  E4 @succinix/engine 打包（本地验证，不发布）┘

阶段 1 · 多实例化                        验证点：双实例互不可见 + 独立应用回归 + 本地打包验证
  M1 persist persistenceKey 注入
  M2 状态文件路径参数化（/etc → per-instance，浏览器+host）
  M3 host 协议实例上下文（additive instanceId）
  M4 service/ports 按实例视图 + db 实例化
  M5 createSuccinixInstance 聚合 API + ?instance= demo

阶段 2 · 多用户 API 定型                 验证点：多用户语义全绿 + 最终打包验证
  U1 多用户语义完整化（协议/终端/快照 + AGENTS.md/SDK.md 边界声明）

阶段 3 · 发布收尾                        验证点：CI 全绿 + 部署验证
  F1 文档定稿（SDK.md 双语/README/CHANGELOG）
  F2 全项目过时文档清点与更新
  F3 两仓/单仓 CI 全绿
  F4 最终验收清单全过
```

**硬依赖**：E1+E2→E3→E4→(publish)；M 系列依赖 E 系列（SDK 化后改动在模块化层）；
U1 依赖 M 系列。每阶段验证点未过不跳级。

---

## 6. 阶段 0 · EMBED-SDK

### TASK-E1：提取 SuccinixTerminalSession

**目标**：`src/terminal/session.ts` —— 无 UI 终端交互核心（纯逻辑可单测）。

**导出**（`src/terminal/session.ts`）：
```ts
export interface TerminalRpc {
  exec(cmd: string, opts?: Record<string, unknown>, timeoutMs?: number): Promise<ExecResult>;
  spawn?(command: string, opts?: Record<string, unknown>, timeoutMs?: number): Promise<ExecResult>;
  listProcesses?(): Promise<ProcInfo[]>;
  kill?(pid: number): Promise<boolean>;
  ping(): Promise<boolean>;
  pingDirect?(timeoutMs?: number): Promise<boolean | null>;
  interruptDirect?(timeoutMs?: number): Promise<ExecResult | null>;
}
> **实现来源**：`createTerminalExecutor()` 实例天然满足（engine 的 TerminalExecutor
> 有 exec/spawn/listProcesses/kill/ping/pingDirect/interruptDirect 全套；TerminalClient
> 本身无独立 ping/ps/kill 方法 —— 协议命令走 exec，适配时对齐 executor）。
export interface TerminalOutput { write(data: string): void; clear(): void; }
export interface TerminalSessionOptions {
  cwd?: string;                       // 初始 cwd（缺省 /workspace）
  timeoutMs?: number;                 // 命令超时（缺省 60000）
  bootGate?: boolean;                 // boot 前静默忽略输入（缺省 true）
  localHandlers?: Record<string, (ctx: LocalCommandCtx, args: string[]) => Promise<string | void>>;
  history?: boolean;                  // 命令历史（缺省 true）
  tabComplete?: boolean;              // Tab 补全（缺省 true）
  interrupt?: boolean;                // Ctrl+C 真中断（缺省 true，无 interruptDirect 降级）
  promptPrefix?: string;              // 缺省 'guest@succinix:'
  onCommand?: (entry: CommandLogEntry) => void; // 命令日志采集（对齐 engine onCommand；
                                               // 缺省不写日志，由应用层注入落盘）
}
export interface LocalCommandCtx { output: TerminalOutput; cwd: string; session: SuccinixTerminalSession; }
export class SuccinixTerminalSession {
  constructor(rpc: TerminalRpc, output: TerminalOutput, options?: TerminalSessionOptions);
  handleData(data: string): void;
  prompt(): void; getPrompt(): string; getCwd(): string;
  async boot(): Promise<void>;        // 解锁门禁 + 首提示符
  dispose(): void;                    // 丢队列、抑制输出
}
```

**行为迁移**（从 main.ts 逐条对齐，**不许简化**）：
- `handleData`：箭头上/下（历史导航）、Tab/Shift+Tab（补全）、回车（提交/排队）、
  退格、Ctrl+C（busy 时 `interruptDirect` + 清队列；空闲 ^C+提示符）、Ctrl+L
  （`output.clear()` + 重绘）、残缺转义丢弃。逐条对照 main.ts 115-200 行迁移。
- 历史：`history[]` + 哨兵回"新行"；非空命令进历史。
- Tab 补全：公共前缀（`commonPrefix`）+ 内置/注入命令名；路径补全
  （main.ts 229 行 handleTab）迁移，无 ls RPC 时降级为仅命令名（应用层可增强）。
- 队列：busy + queue，busy 回车 → queued 提示；结算出队，空则 prompt()。
- cwd 跟随：`cd` 成功（res.cwd string）→ session.cwd 更新 + 提示符短路径。
- boot 门禁：booted 标志（对齐 main.ts R1）。
- 内置最小本地命令：`help`（列已注入命令）/ `clear` / `pwd` / `echo`；
  本地表未命中 → **原样走 RPC**（host 回 unknown command 语义）。
- 命令日志：session 不直接写 /var/log/succinix.log（不 import log）——经 `onCommand`
  选项采集（CommandLogEntry 类型从 engine 导入），应用层决定落盘（main.ts 注入
  现有 log 写入，保持 /var/log/succinix.log 行为）。

**单测** `src/terminal/session.test.ts`（vitest，fake RPC + 收集 output）≥12 用例：
转义序列全分支 / 排队结算 / Ctrl+C 真中断调用 + 队列清空（fake 断言）/ cd cwd
跟随 / boot 门禁 / 本地命令注入命中与回落 / 历史导航 / 补全。

**保留项**：不改 main.ts 现有逻辑（E3 才动）；不 import persist/log/config/commands；
不改 engine/。
**门禁**：`npx tsc -p tsconfig.json --noEmit` + `npx vitest run src/terminal/session.test.ts`
+ `grep -n '✅\|❌\|🎉\|GREEN' src/terminal/`（0）。
**验收**：全绿；session.ts 无 xterm/DOM/persist/log import。
**commit**：`feat(embed): extract SuccinixTerminalSession as UI-free terminal core`

---

### TASK-E2：boot 流程参数化（TerminalBoot）

**目标**：`src/terminal/boot.ts` —— `createTerminalBoot(wc, ui, opts)`，boot 步骤/
进度/重试参数化，独立应用行为不变。

**导出**：
```ts
export interface TerminalBootOptions {
  steps: string[];                       // 步骤文案（编号 N/M 自动）
  testMode?: boolean;
  retry?: { attempts: number; intervalMs: number };
  hostReadyDeadlineMs?: number;
}
export function createTerminalBoot(wc: WebContainer, ui: BootUI, opts: TerminalBootOptions): TerminalBoot;
```
`BootUI` **直接复用 boot-ui.ts 的实际接口**（[锚点] 第 10 行）：`log(text, kind?)/systemInfo(lines)/complete()/fail(reasons, opts?)`。
**进度由 TerminalBoot 内部用 `ui.log('[  OK  ] N/M <msg>', 'ok')` 实现**（对齐 boot.ts 现有
ok/note/failStep/noteOnly 包装函数模式 —— 那些包装迁移进 TerminalBoot，不改 boot-ui.ts）。

**实现**：复用 boot.ts 现有 checkEnvironment/detectSystemInfo/
bootWebContainerWithRetry/waitForHostReadyWithRetry/initWorkspace/资产预取 ——
**参数化不改时序**。`bootSuccinix(ui)` 保留，内部改为
`createTerminalBoot(..., { steps: <现有 12 步>, testMode: <URL 参数>, ... }).boot()`。

**单测** `src/terminal/boot.test.ts` ≥5：steps 长度 = 进度总数 / 重试路径
（fake wc 失败 2 次后成功）/ testMode 透传。

**门禁**：tsc + vitest（session+boot）+ `node scripts/build-host.mjs`（确认无意外破坏）。
**验收**：`?test=1` dev 实测与改动前一致（git stash 基线对照一次）。
**commit**：`refactor(embed): parameterize boot flow via TerminalBoot + BootUI`

---

### TASK-E3：main.ts 重构为组装层

**目标**：main.ts 变薄组装层；删除被 session 替代的交互实现；应用特性保留。

**改动**：
- xterm + FitAddon 创建（主题/字体/滚动保留）→ `output: TerminalOutput` 适配
  （write → term.write，clear → term.clear）。
- `session = new SuccinixTerminalSession(rpcAdapter, output, { localHandlers:
  <commands.ts 全量适配注入>, ... })`。commands.ts 的 tryHandleLocalCommand
  通过薄适配层桥接 —— **适配层闭包捕获 CommandContext 所需字段**
  （wc/client/ports/fit/hostProc，[锚点] CommandContext 51 行），term 用
  `{ writeln, write, clear }` shim 桥接 TerminalOutput；**commands.ts 本身不改**。
- rpcAdapter = `createTerminalExecutor()` 实例的适配（interruptDirect 必须透传）。
- boot：`createTerminalBoot` 12 步 + 自检接线（testMode）→ session.boot() →
  motd → 首提示符。
- 应用特性保留：startAutoSnapshot / startHostWatchdog / `?bench=1`/
  `?scenario=1` hooks（`__succinixBench`/`__succinixScenario` 挂载点、scenarioRun
  语义）/ server-ready 预览提示。可抽 `src/app/` 或留 main.ts（以清晰为准）。
- **scenarioRun 归属**：留在应用层（main.ts 或 src/app/），复用 session 暴露的
  rpc 与本地命令表（session 提供只读访问面），输出走 capture-term shim（现有
  实现）；`__succinixScenario` hooks 形状不变（scenarios.mjs 依赖）。
- host 重启路径：executor.respawn() 后 session 无需重建（确认看门狗触发后终端可用）。
- 新增 `src/terminal/index.ts` 统一导出（session/boot/output 类型）。

**保留项**：`?test=1` ≥71；`?bench=1`/`?scenario=1` hooks 形状不变
（scripts/bench.mjs、scenarios.mjs、verify-deploy.mjs 依赖）；commands.ts/
persist.ts/boot.ts/tests.ts/services.ts 不改（最小适配需写明）。

**门禁**：tsc + build-host + `npm run build` + `npx vitest run src/terminal/ tests/`
+ grep emoji（src/ index.html）。
**验收（浏览器实测，必须真跑）**：
1. dev 7892：boot 日志直进终端 → motd → `guest@succinix:~$`
2. `echo hello` 回显；`cd /workspace` → `~`；`cd /` → `~`
3. `sleep 2` 期间 Ctrl+C → 真中断 + 回提示符
4. ↑/↓ 历史；`cl`+Tab → clear
5. `?test=1` ≥71 + `__succinixResult` 存在
6. `?bench=1` `__succinixBench` 存在；`?scenario=1` `__succinixScenario.run('echo hi')` ok:true
**commit**：`refactor(embed): rewrite main.ts as assembly layer over terminal SDK`

---

### TASK-E4：@succinix/engine 打包（独立 0.1.x 线，随 0.4.0 发布；本地验证，不发布）

**目标**：terminal 层并入包，`./terminal` 导出。

**改动**：
- `scripts/build-engine-package.mjs`：esbuild bundle `src/terminal/index.ts` →
  dist/terminal.js（与 index.js 同配置：ESM、external @webcontainer/api）；
  tsc emitDeclarationOnly 补 .d.ts —— **注意 packages/engine/tsconfig.json 的
  编译入口列表同步加 terminal 入口**（[锚点] 现有脚本 entryPoints 单入口模式）。
- package.json：version 沿 **0.1.x** 线（当前 0.1.4；engine 独立版本生命周期，bump 统一在 F 阶段执行；此处本地验证 exports 完整）；exports 加 `"./terminal"`；peerDeps 不变。
- `docs/SDK.md`（+ zh）：新增"终端嵌入（Terminal SDK）"节 —— 接入示例
  （15 行内）、TerminalRpc/TerminalOutput 契约、本地命令注入、boot 步骤配置、
  与 createTerminalExecutor 的分工（命令式通道 vs 终端会话）。

**验证（不 publish）**：
```bash
npm run build:engine-package
cd packages/engine && npm pack --dry-run    # dist/terminal.js + .d.ts 在包内
# /tmp 干净目录 npm i <tgz> && import('@succinix/engine/terminal') → Object.keys 含 SuccinixTerminalSession
grep -rn "node:" dist/terminal.js           # 空
```
**commit**：`feat(embed): add terminal SDK exports to engine package`（本地打包，不推）

**▶ 阶段验证点 0**：`?test=1` 全绿 + E3 实测清单 1-6 复跑 + 本地打包验证（`npm pack --dry-run` + 干净目录 import `./terminal`）。

---

## 7. 阶段 1 · 多实例化

> 目标：Succinix 从单实例进化到多实例 —— 每实例独立状态/快照/进程视图。
> 实例标识 `instanceId`（缺省 `'default'` = 单实例全等现状）。
> 隔离为组织性。每个改 host 的 TASK：重建 host.js 并记录待发布版本。
> 多实例的验证入口：**`?instance=<id>` URL 参数** —— 独立应用以此参数启动指定
> 实例（状态/快照/持久化按实例分割），开两个 tab（不同 id）即双实例 demo。

### TASK-M1：persist persistenceKey 注入

**目标**：persist.ts 支持实例级 IndexedDB key，默认行为不变。

**改动**：
- `src/persist.ts`：DB_NAME/STORE_NAME/KEY 是模块级常量（非导出）——参数化为
  persist 上下文（如 `createPersist({ dbName?, storeKey? })` 或函数参数），
  `saveSnapshot/loadSnapshot/clearSnapshot/getSnapshotMeta/forcePersist` 均走
  该上下文；缺省 = 现状 `succinix-persist`/`current`（行为全等）。
- **🔴 模块级缓存状态必须一并实例化（只换 DB key 不够，否则静默丢数据）**：
  persist.ts 的 `lastSignature`/`lastSavedMeta`/`overLimitWarned`/`lastFullSaveAt`/
  `inflight`/`cleared`/`dbPromise`/`lastListingSig`/`lastCollected` 全是**模块级单例**。
  多实例共享时：实例 A 的目录签名/内容签名去重会污染 B（B 的快照被静默跳过 =
  **数据丢失**）、A 的 in-flight 保存 Promise 会复用给 B（B 读到 A 的 meta）、A 的
  `clearSnapshot` 脏标志会挡掉 B 的写入、`lastFullSaveAt` 让 B 的 30s 年龄强制窗口
  失真。因此 `createPersist` 必须返回**绑定全部上述状态的闭包快照对象**
  （save/load/clear/meta/force 一组），每个实例独立持有；boot.ts / main.ts /
  commands.ts 改为从实例上下文取用（缺省单例 = 现状全等）。持久化门控签名
  （computeListingSignature）按实例隔离，互不比对。
- 浏览器侧 `snapshot` 命令：ctx 带实例持久化选项（缺省单实例）。
- 单测：`tests/persist-instance.test.ts` —— ① 两个实例（不同 key）写入互不覆盖、
  各自恢复；② **两实例交错 save**（A 存、B 存、A 再存）各自独立去重、无跨实例污染；
  ③ A `clearSnapshot` 不影响 B 的后续保存；④ 默认 key 与现状一致（现有 persist
  测试全绿不动）。

**保留项**：force 语义/30s age-force/内容签名去重逻辑不动；现有 API 向后兼容。
**门禁**：tsc + `npx vitest run tests/persist*.test.ts` 全量。
**commit**：`feat(instance): inject persistence key per instance in persist layer`

---

### TASK-M2：状态文件路径参数化（/etc → per-instance）

**目标**：浏览器侧命令与 host 的状态文件路径按实例前缀分割。

**改动**：
- 浏览器侧：命令写 `/etc/succinix.*` / `/ws/.current` 的路径常量 → 实例前缀函数
  `statePath(instanceId, name)`（缺省前缀空 = `/etc/...` 现状；实例化时 =
  `<stateRoot>/etc/...`，stateRoot 如 `/workspace/.succinix-<id>`）。
  [锚点] src/commands.ts、src/config.ts 的路径常量统一走该函数。
- host 侧：host 读 `/etc/*` 用 `${process.cwd()}` 拼接 → 路径拼接参数化：
  状态根 = `f(instanceId)`（缺省 = cwd 根，现状语义）。**实例配置按实例存放**：
  bootEngineHost 写配置时落到该实例的 `<stateRoot>/etc/succinix.engine.json`，
  host 启动时从请求携带的 instanceId 解析自身配置路径（全局单份 /etc 配置在
  多实例下会串扰，禁止）。改 `src/engine/host/` + `bootEngineHost` → 重建 host.js。
- **host 侧 per-instance 状态清单（明确"哪些 /etc/* 实例化、哪些仍页面级"）**：
  同页共享 host 时，下列 host 全局状态必须按 instanceId 分键（`Map<instanceId, ...>`，
  缺省 `default` 键 = 现状单值全等）：会话 cwd（现 host.ts 单值 `sessionCwd` +
  `/etc/succinix.cwd`）、当前前台 run pid（`currentRunPid`，供 interrupt）、env 文件合并
  （`/etc/succinix.env`）、settings/services/autostart/motd/engine.json 的读取路径
  —— 全部落到 `<stateRoot>/etc/<name>`。**页面级（不实例化）**：`/browser-wrote.txt`
  等自检文件、`/ws/.current` 工作区指针（workspace 是页面/容器级语义，见 M4 保留项）。
- **归属命名一致（DM-12）**：stateRoot 用 `/workspace/.succinix-<id>`，则
  `src/engine/host-procs.ts` 的 `CONTAINER_SEGMENT_PATTERN` 必须**同步扩展**匹配
  `.succinix-<id>` 根段（现有只认 `c-<id>`，否则实例内 spawn 的进程归属落
  `unknown`，M3 的 ps 过滤 / M4 的 service 归属全部失效）。两命名空间共存。
- 单测：浏览器侧路径函数（前缀空/非空）；host 路径解析（配置存在/缺省）；
  host-procs 新增 `.succinix-<id>` 归属用例（不回归 `c-<id>` 既有用例）。

**保留项**：默认实例路径不变（`/etc` 语义）；host 注入顺序不变。
**门禁**：tsc + build-host + 相关单测 + `?test=1`（独立应用默认前缀空，必须 ≥71）。
**commit**：`feat(instance): parameterize state file paths per instance (browser + host)`

---

### TASK-M3：host 协议实例上下文（additive）

**目标**：请求可带 `instanceId`，host 按实例维护状态/进程视图；不带 = 默认实例。

**改动**：
- `/cmd.json` 请求体加可选 `instanceId` 字段（additive，不带 = 默认实例，旧行为
  不变）；`/result-<id>.json` 回带 `instanceId`（回显）。
- host 内部：状态文件读取（M2 的 statePrefix）与进程表登记（复用 CISOL 的
  containerId 标注字段，语义对齐为 instanceId）按实例关联；`ps` 响应带
  `instanceId` 过滤面（请求带 instanceId 时只返回该实例 + system 进程）。
  改 `src/engine/host/` + `host-procs.ts` → 重建 host.js。
- `docs/PROTOCOL.md`（+zh）补 instanceId 节（additive 声明）。
- **多实例共享命令队列语义**：/cmd.json 仍单 host 串行处理（已有），请求带
  instanceId 区分归属；interrupt 只中断该实例的进程。
- **interrupt 按实例的机制（补全）**：host 的 `currentRunPid` 由单值改为
  `Map<instanceId, pid>`（缺省 `default` 键 = 现状全等）。`spawnChild` 登记时按请求的
  instanceId 归位，`interrupt` 请求带 instanceId 时只 kill 该实例的当前 run；无当前
  run 返回 `pid:null`（同现状）。ps 过滤同样按 M2 归属字段对齐。
- **🔴 共享 Lifo sandbox 约束（同页多实例的死穴，必须写明）**：`getSandbox()` 缓存的是
  单例 sandbox，`sandbox.cwd` 是单值 —— 同页两个实例都执行 `cd` 会互相改掉对方的
  Lifo cwd（A `cd /x` 后 B `cd /y`，A 再 `pwd` 返回 `/y`）。**0.4.0 定稿（DM-11）**：
  Lifo 交互 cwd 为**页面级**（不按实例同步），每实例 cwd 是浏览器侧逻辑值，node/python
  spawn 用显式绝对 cwd（经 M2 的 stateRoot）承担实例内相对路径。**不为每实例建独立
  sandbox**（成本高、超出单 host 承诺）；此约束写进 SDK.md，宿主侧集成时按"共享运行时"
  理解。跨容器（双 tab）不受影响 —— 各 tab 独立 sandbox。
- **验证盲区（如实标注）**：双 tab demo 各自是独立 host，**永远不会向共享 host 发送
  instanceId** —— M3 的 host 侧按实例路由（Map 分键 / ps 过滤 / kill 越权）只被本 TASK
  的协议级单测覆盖，e2e 留给未来同页宿主。阶段验收清单须区分"已 e2e 验证（跨容器）"
  与"仅单测验证（同页路由）"，不得因双 tab 全绿而误判同页已通。
- 单测：协议级 —— 带/不带 instanceId 的请求路由与响应；host 进程登记关联（含
  `.succinix-<id>` 归属）；interrupt 按实例（A 实例 interrupt 不杀 B 实例 run）。

**保留项**：协议向后兼容（旧客户端零改动可用）；单 host 不变量。
**门禁**：tsc + build-host + 协议单测 + `?test=1`。
**commit**：`feat(instance): additive instanceId context in file RPC protocol`

---

### TASK-M4：service/ports 按实例视图 + db 实例化

**目标**：管理类命令具备 per-instance 语义（DM-1：多实例模式全量命令按实例生效）。

**改动**：
- `service` 命令：列表/操作按 instanceId 过滤（进程 cwd 前缀匹配，复用 CISOL
  scope 判定）；跨实例操作拒绝（对齐 kill 拦截语义）。
- `ports` 命令：spawn 服务登记 instanceId（host spawn 响应带 cwd/instanceId）；
  按实例过滤显示。
- `db`（tinbase）：实例化 = 数据目录放实例工作区（`/workspace/.succinix-<id>/tinbase`），
  `db start` 按实例 cwd 起；实例间数据隔离。**端口分配**：每实例独立端口
  （登记进 per-instance ports 视图），端口冲突时拒绝启动并提示；同一实例重复
  start 幂等（已有语义）。
- `reboot`/`shutdown`：多实例模式下重定义为**实例级重置**（清实例状态 + 重 boot，
  不刷新宿主页面；独立应用单实例语义不变）。
- **reboot 实例级重置的机制（补全）**：`SuccinixInstance` 增加 `restart()` —— dispose
  当前实例的 session/executor 引用、清该实例状态（M2 stateRoot + M1 快照键，按需），
  再按原 options 重 boot（走 M5 实例工厂内部 boot 路径）；**不刷新宿主页面**。demo 的
  `?instance=` 单页单实例路径中 reboot 仍可 `location.reload()`（该 Tab 即该实例，
  刷新 = 实例级重置）；同页宿主用 `restart()`。`shutdown` 多实例模式 = 停当前实例
  （dispose，不动其他实例），文案注明"仅停当前实例，页面可关"。
- **🔴 端口事件按实例归属（补全 M5 的 🔴 分发）**：WebContainer 的 server-ready/close
  事件只携带 (port, url)，**无实例归属**。同页多实例靠**实例服务注册表**归属：每实例
  维护"已启动服务的期望端口集合"（来自本实例 spawn 响应里的 instanceId + 服务端口，
  见 M3 回显）；server-ready 到达时归到"期望该端口的实例"；无法归属（端口被非服务进程
  占用）时归页面级 registry、不进入任何实例 ports 视图（如实标注）。双 tab 各 host
  事件天然隔离，此机制只在同页路径生效。
- `workspace` 命令与多实例：**页面/容器级**（不按实例化）—— `/ws/.current` 是单份，
  stateRoot 落在当前工作区下；切换工作区会把实例状态根一并挪走（stateRoot 在工作区
  内），作为已知语义写进文档，不为此做额外迁移。
- 单测：service 过滤 / ports 过滤 / db 数据目录断言 / reboot 实例级语义。

**保留项**：命令名与输出形态不变（只是视图收窄）；独立应用（默认实例）行为全等。
**门禁**：tsc + build-host + 相关单测 + `?test=1`。
**commit**：`feat(instance): per-instance service/ports views, db data dirs, instance-level reboot`

---

### TASK-M5：createSuccinixInstance 聚合 API + ?instance= demo

**目标**：实例聚合对象，终端/executor/快照/服务一个工厂产出；`?instance=` demo
入口验证多实例。

**导出**（`src/instance/`，经 engine 打包）：
```ts
export interface SuccinixInstanceOptions {
  wc: WebContainer; instanceId: string;
  statePrefix?: string;              // 缺省 '' = 单实例 /etc
  persistence?: { dbName?: string; storeKey?: string };
  terminal?: TerminalSessionOptions; // 透传（cwd/localHandlers/...）
  executor?: EngineBootHooks;        // 透传（asset URL/端口回调/...）
  rpc?: TerminalClient;              // 同页共享 RPC 通道（per-page，缺省自建，见"同页共享通道"）
  bootUI?: BootUI;                   // boot 进度 UI（缺省静默，宿主可传 E2 TerminalBoot 的 UI）
  bootSteps?: TerminalBootOptions['steps']; // boot 步骤文案（缺省引擎默认；应用级 bootsteps 归宿主）
}
export interface SuccinixInstance {
  instanceId: string;
  terminal: SuccinixTerminalSession;
  executor: TerminalExecutor;
  snapshot: { save(force?: boolean): Promise<unknown>; restore(): Promise<void> };
  services: { list(): Promise<unknown[]>; start(name: string): Promise<unknown>; stop(name: string): Promise<unknown> };
  restart(): Promise<void>;          // M4：实例级重置（dispose + 清状态 + 重 boot，不刷新宿主页面）
  dispose(): Promise<void>;
}
export function createSuccinixInstance(opts: SuccinixInstanceOptions): Promise<SuccinixInstance>;
```
- 内部组装：executor.boot → session（instanceId 注入 rpc/命令 ctx）→ snapshot 绑定
  per-instance persist → services 绑定 per-instance 视图。
- **同页多实例（共享运行时，DM-11）**：createSuccinixInstance 可在同一页面创建多个
  实例（每实例独立 session/output/snapshot/services/ports 视图，共用单 host）；demo
  用双 tab 是最简验证，宿主（如 SunamAI）可同页多实例 —— 但按 DM-11，同页只有
  持久化/快照/服务与端口视图按实例隔离，命令运行时共享（Lifo 交互 cwd 页面级）。
- **🔴 同页共享 RPC 通道（per-page 粒度；同页必做，否则并发挂起）**：`/cmd.json` 是单槽信箱，每个
  TerminalClient 各有独立互斥队列 —— 同页两个实例并发写会互相覆盖（后写吞先写，
  先发请求等不到结果、30s 超时）。同页多实例必须**共享一个 RPC 通道**：同一
  TerminalClient / 同一 executor（或共享请求锁），请求带 instanceId（M3 区分归属）。
  `createSuccinixInstance` 支持传入共享 `rpc`/`client`（缺省自建 —— 单实例/双 tab 各自
  独立无竞争，行为全等现状）。protocol 层的 additive instanceId 使共享通道无需改协议。
- **单看门狗（同页必做）**：看门狗是 **per-host**（页面级一个），不是 per-instance ——
  多个看门狗会各自 pingDirect、各自独立判定失联并 respawn，触发双 host 竞态（违反
  单 host 不变量）。实例工厂不内置看门狗；宿主在页面级起一个，实例共享。demo（双 tab）
  每 tab 各一个，天然无冲突。
- **🔴 端口事件多实例分发（机制在 M4，此处接线）**：engine 的 `wcListenersBound` 按 wc
  实例去重（server-ready/port 监听器只注册一次）——同页多实例时只有第一个 boot 的
  hooks 收到端口事件。按 M4 的实例服务注册表归属（server-ready 按期望端口归到实例）；
  页面级维护一份 hooks/端口注册表，分发给各实例的 ports 视图。双 tab 各 host 天然隔离。
- **`?instance=<id>` demo**：main.ts 读取 URL 参数，非缺省时用
  `createSuccinixInstance({ instanceId: id, ... })` 组装（状态/快照按实例分割）；
  缺省走单实例路径（行为全等现状）。`?test=1` 在 demo 模式下仍跑默认实例自检。
- **实例工厂与 boot 流程的关系（补全，防两套 boot 漂移）**：`createSuccinixInstance`
  做**引擎级 boot** —— 注入 host + spawn + 就绪 → executor → session（instanceId 注入
  rpc/命令 ctx）→ **按实例快照键恢复**（M1 load，缺省 default 键全等现状）→ snapshot
  绑定 per-instance persist → services 绑定 per-instance 视图。应用级 bootsteps
  （workspace init / motd / env 统计 / autostart）**不在实例工厂内** —— 由宿主经
  `TerminalBoot`（E2）参数化或自行决定；`SuccinixInstanceOptions` 增可选 `bootUI?`
  /`bootSteps?`（缺省静默 boot，无进度 UI）。独立应用的 `bootSuccinix`（E2 保留）在
  demo 模式下改为内部调用实例工厂 + 应用级 bootsteps，避免逻辑分叉。
- 文档 SDK.md（+zh）"多实例"节：实例模型、组织性隔离声明、接入示例
  （宿主风格：每容器/每用户一个 instance）。
- 打包验证：exports 增加 instance API（engine 独立 0.1.x 线，bump 统一在 F 阶段执行，见 DM-6）；本地 `npm pack` + 干净目录安装验证。

**保留项**：单实例路径 = 默认 instanceId 行为全等；`?test=1` 等 hooks 不降。
**门禁**：tsc + build-host + `npm run build` + 实例单测（≥8：两实例隔离/聚合
组装/默认实例等价）+ `?test=1` + 浏览器实测（单实例回归 + 双 tab demo）。
**commit**：`feat(instance): aggregate SuccinixInstance API (terminal+executor+snapshot+services)`

**▶ 阶段验证点 1**：
1. 双 tab demo（`?instance=c-1` / `?instance=c-2`）：各自终端独立、进程互不可见
   （ps 过滤）、状态文件独立（env 不串扰）、快照独立（A 修改 B 不受影响）、
   `service start` 只影响自己实例、`reboot` 只重置自己
2. 单实例回归：无参数启动 = 现状全等（?test=1 ≥71 + E3 清单 1-6）
3. 本地打包验证（exports 含 instance API，干净目录可 import）
4. **盲区确认（M3）**：双 tab 各自独立 host，**不**覆盖 host 侧按实例路由
   （Map 分键 / ps 过滤 / kill 越权）——该部分以 M3 协议级单测为证，如实标注
   "跨容器已 e2e、同页路由仅单测"，不把双 tab 全绿误判为同页已通。

---

## 8. 阶段 2 · 多用户 API 定型

### TASK-U1：多用户语义完整化

**目标**：`createSuccinixInstance` 定型为对外多用户 API；userId/instanceId 等价；
组织性隔离正式文档化（AGENTS.md 的 Explicitly Not Implemented 列表更新）。

**改动**：
- 协议/文档统一措辞：instanceId ↔ userId 等价（内部同一字段）；SDK.md"多用户"
  章节完整化 —— 每用户 home 目录约定（`/workspace/users/<id>`，宿主可覆盖）、
  进程视图、状态、快照、终端装配示例。
- host 协议补 user 维度的完整性检查：`ps` 过滤（请求带 userId 时只返回该用户 +
  system）、`kill` 越权拒绝（跨用户 kill 拦截，复用 CISOL 语义 host 侧收口）。
  改 `src/engine/host/` + `host-procs.ts` → 重建 host.js。
- 独立应用：guest 单用户语义不变；`?instance=` demo 升级为 `?user=` 参数
  （别名兼容 instance）。
- **每用户 home 初始化**：`initWorkspace` 参数化 per-user —— 用户首次启动时
  创建 `/workspace/users/<id>`（mkdir + 状态文件种子），缺省 guest 路径全等现状。
- **AGENTS.md Explicitly Not Implemented 列表更新**：多用户条目（当前第 25 行，单
  用户 bullet）从"❌ 已砍（单用户非安全隔离，登录仪式无价值）"改为"✅ 组织性隔离
  （嵌入模式可用，按实例/用户分割目录·状态·进程视图；**非安全边界**；登录仪式/
  权限位/chmod 语义仍不做）"。
- 单测：多用户语义完整化断言（每用户 home/进程过滤/kill 越权拒绝）。

**保留项**：单 host 不变量；协议 additive；独立应用 guest 语义。
**门禁**：tsc + build-host + 单测 + `?test=1` + 双用户 demo 实测。
**commit**：`feat(multiuser): finalize multi-user semantics across protocol/terminal/snapshot`

**▶ 阶段验证点 2**：双用户 demo（`?user=a` / `?user=b`）全隔离断言过 + 单实例
回归 + 最终打包验证（exports 完整：`./terminal` + instance + 多用户，干净目录 import）。

---

## 9. 阶段 3 · 发布收尾

### TASK-F1：文档定稿
- `CHANGELOG.md` 补 **0.4.0 一条**（含全部变更：Terminal SDK / 多实例 / 多用户；Keep a Changelog 格式，英文）。
- `README.md`（+ zh）：Ecosystem 节更新 —— @succinix/engine 各版本能力一句话
  + SDK.md 链接；Features 核对（多实例/多用户能力项）。
- `docs/SDK.md`（+ zh）与实现逐节核对（Terminal SDK / 多实例 / 多用户三节）。
- `docs/PROTOCOL.md`（+ zh）instanceId/userId 节核对。
- `docs/FEATURES.md`（+ zh）补多实例/多用户能力。
- **隔离模型文档化（DM-11 落地）**：SDK.md"多实例"节必须写清 同页 vs 跨容器 的隔离
  边界（跨容器 = 完整隔离；同页 = 共享运行时，持久化/快照/服务与端口视图按实例、
  Lifo 交互 cwd 页面级（per-page）、RPC 通道与看门狗同页共享（per-page）），避免宿主按"每实例独立运行时"
  误接。
- **门禁数字以实测为准**：vitest 总数随新增单测增长（基线 118 → 实测更新）；
  E4/M5/U1 打包后跑 `scripts/bench.mjs` 对照基线（bundle 体积/启动时间，
  新增导出体积增量如实记录）。

### TASK-F2：全项目过时文档清点与更新

**目标**：平台化（Terminal SDK / 多实例 / 多用户）改完后的**全项目文档扫尾** ——
不局限于 F1 的新增能力文档，把仓库里所有 .md 中因本次重构而过时的内容逐份清点并
更新，确保对接开发部门时没有一份文档在描述旧架构。

**改动**：
- **清点范围（双语成对，英文为主、zh-CN 同步）**：
  - 仓库根：`README.md` / `README.zh-CN.md`（特性清单、版本号、单应用叙事、
    "guest 唯一用户"等过时表述）、`AGENTS.md` / `AGENTS.zh-CN.md`（除 U1 已改的
    多用户条目外，核对技术约束 / 质量门禁 / 依赖描述是否仍成立）、`CHANGELOG.md` /
    `CHANGELOG.zh-CN.md`（历史条目与本次 0.4.0 一条一致）、`CONTRIBUTING.md` /
    `CONTRIBUTING.zh-CN.md`（开发命令 / git 工作流 / 构建步骤引用）。
  - `docs/`：`SDK.md` / `SDK.zh-CN.md`（含开篇 "design document, not a shipped
    package" 这类已过时定位 —— 包已发布 0.1.4）、`PROTOCOL.md` / `PROTOCOL.zh-CN.md`
    （命令集 / 进程模型 / 边界声明）、`FEATURES.md` / `FEATURES.zh-CN.md`、
    `LANGUAGES.md` / `LANGUAGES.zh-CN.md`（node/python 版本号、运行时能力）、
    `README.zh-CN.md`（若为根 README 副本，核对是否已落后）。
- **过时类型清单（逐文件套用）**：单应用/单用户架构叙事（应改为"实例/用户可嵌入"）、
  版本号与命令数等数字（如本计划 §1 已修正的 20→25）、测试基线引用、错误的文档
  结构引用（AGENTS.md 是 Explicitly Not Implemented 列表，非"物理边界表"）、不再
  成立的技术约束、旧 TASK 编号残留的流程描述。
- **双语同步**：每份英文文档的修改必须同步到对应 zh-CN 文件；门禁含全部 .md 成对
  存在。
- **输出**：本 TASK 的 commit message 列出"本次清点更新的文档清单"，供 F4 验收核对。

**保留项**：不改引擎/应用代码（纯文档）；不因文档更新引入新 API 承诺；F1 已覆盖的
核心文档仍归 F1 负责，本 TASK 在其后做**交叉核对**（防 F1 漏网）。
**门禁**：无代码改动（tsc/lint/自检不受影响）；`git status` 仅 .md 变化；双语成对
更新完成。
**commit**：`docs: sweep project-wide stale documentation after platformization`

### TASK-F3：CI 全绿
- push 后 `gh run watch` + `gh run view --json jobs` conclusion 全 success
  （verify：tsc/lint/vitest 全量 + `?test=1` 自检 ≥71）。
- 确认 CI 不依赖未发布资产（engine 包构建自仓库源码，无外部回落坑）。

### TASK-F4：最终验收
- §11 清单全过；npm `@succinix/engine` **0.1.4**（独立 0.1.x 线）干净安装验证；
  succinix.alibicore.com 强刷显示最新版本（Vercel 自动部署）；
  部署站 `?instance=`/`?user=` demo 可用。

---

## 10. 发布与部署流程（远程副作用，不由 CC 执行）

| 动作 | 时机 | 执行者 |
|---|---|---|
| `npm publish @succinix/engine@0.1.4`（engine 独立 0.1.x 线） | **全部 TASK 完成后一次性发布** | 用户/Hermes |
| git push + GitHub Release（v0.4.0 tag，主项目 0.x 线） | 同上 | 用户/Hermes |
| Vercel 部署 | push main 自动 | 自动（强刷验证） |

发布前检查：`npm whoami` / `npm pack --dry-run` / 干净目录安装验证 /
`npm view` 传播确认（curl registry 直查，防本地缓存误判）。

---

## 11. 最终验收清单（全部完成后逐项勾）

- [ ] `@succinix/engine` **0.1.4（独立 0.1.x 线）一次性发布**，`/terminal` + instance + 多用户 API 干净安装可 import
- [x] 独立应用：`?test=1` 76 passed / 0 failed（verify-deploy 门禁 ≥71）；boot 门禁过（verify-bootgate）、
      boot/历史/补全/真中断/cd cwd 由终端会话单测 + 场景套件覆盖；单实例行为全等 0.3.0
      （2026-08-11 verify-deploy 实测 76/0/5）
- [x] 多实例：`?instance=c-1`/`c-2` 双 tab —— 进程互不可见 / kill 越权拒绝 /
      状态与快照独立 / env 不串扰 / service 按实例 / reboot 实例级；
      同页按实例路由（Map 分键 / ps 过滤 / kill 越权）以 M3 协议级单测为证，
      如实标注"跨容器已 e2e、同页路由仅单测"
- [x] 多用户：`?user=a`/`b` 全隔离断言过（instance-demo 27/27 含用户段）；AGENTS.md 的 Explicitly Not Implemented 列表
      已更新（多用户 = 组织性隔离，非安全边界）
- [x] `?bench=1`/`?scenario=1`/`?test=1` 三个开发钩子全程可用（bench / scenarios S1 /
      lang-verify / verify-deploy 实测通过，scripts/ 依赖不破）
- [x] 文档（SDK.md 双语/README/CHANGELOG/PROTOCOL/FEATURES）与实现一致
      （0.4.0 版本单源同步；SDK.md/PROTOCOL.md/FEATURES.md 均含中英双语）
- [x] 全项目过时文档清点完成（F2）——根 README/AGENTS/CHANGELOG/CONTRIBUTING +
      docs/ 全部双语成对同步，无描述旧架构（单应用/单用户/旧数字/旧引用）的残留
- [x] CI 全绿（jobs conclusion 全 success）—— push 0f5c25b 触发 run 31459095383，
      check job 全绿（lint / tsc / vitest+coverage / build / verify-deploy ?test=1 ≥71），
      nightly-scenarios 按设计 skip（2026-08-11，gh run view 实测）
- [ ] 部署站强刷显示最新版本；`?instance=`/`?user=` demo 线上可用 —— 需 Vercel 部署
- [ ] 技能沉淀：webunix-development 更新（宿主集成两层模型 + 多用户组织性隔离声明）

---

*MASTER PLAN by Hermes（沈知夏），2026-08-10。执行中规格与实现冲突 → 以实际代码
为准并记录差异，不静默改规格。阶段验证点未过不跳级。*
