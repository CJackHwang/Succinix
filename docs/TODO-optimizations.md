# Succinix 优化 TODO 清单（架构审计）

> **性质**：这份文件是**前瞻性的改进待办清单**（不是历史开发档案，不归入 `docs/tasks/` 的 TASK 归档）。
> **审计日期**：2026-08-10
> **基线状态**（审计时）：`tsc --noEmit` 0 错 · `vitest run` 140 全过 · lint 0 error
> **范围**：项目代码 / 功能 / 架构中可改进、可优化的所有问题点，按优先级排序。

---

## 状态图例与优先级

| 标记 | 含义 |
| --- | --- |
| `[ ]` | 待办 |
| `[~]` | 进行中 |
| `[x]` | 已完成 |

| 优先级 | 含义 |
| --- | --- |
| **P0** | 正确性 / 数据完整性风险（优先处理） |
| **P1** | 架构层面问题 |
| **P2** | 代码质量 / 重复代码 |
| **P3** | 测试覆盖缺口 |
| **P4** | 性能 |
| **P5** | 功能 / UX 缺口 |
| **P6** | 安全加固（轻量） |

**快速胜利**（P0-2 + P2 全部，约 1-2 小时）：机械改动、零风险，做完基线立即更干净。
**高价值**（P1-4 + P5-15 + P5-16）：补最脆弱文件的测试盲区 + 最大 UX 提升。

---

## 优先级总览（速览表）

| 编号 | 优先级 | 类别 | 一句话 |
| --- | --- | --- | --- |
| P0-1 | P0 | 数据完整性 | 自动快照「结构签名」门控捕捉不到等长内容编辑 → 崩溃丢数据窗口 |
| P0-2 | P0 | 正确性 | host 重启后陈旧 `/cmd.json` 可能被执行一次 |
| P1-3 | P1 | 架构 | `createTerminalExecutor()` 门面未被主应用使用，两条执行路径并行 |
| P1-4 | P1 | 架构/测试 | 最复杂的 `host.ts`（740 行）是测试盲区 |
| P1-5 | P1 | 架构 | 进程归属判定是命令串启发式，可被伪装 |
| P2-6 | P2 | 重复代码 | 7 处 `sleep` / 3 处 `forcePersist` / 4 处 `ensureParentDir` / 4 处 ANSI 常量 |
| P2-7 | P2 | 一致性 | 版本号硬编码 4 处，升级必漂移 |
| P2-8 | P2 | 重复代码 | `host.ts` 内三份「spawn + 输出收集 + 登记」逻辑 |
| P2-9 | P2 | 重复代码 | `dbStart` 4 段几乎相同的失败输出块 |
| P2-10 | P2 | 重复代码 | `execute()` 与 `scenarioRun()` 是同一管线的两个拷贝 |
| P3-11 | P3 | 测试 | 覆盖率门禁只覆盖 6 个纯逻辑文件 |
| P3-12 | P3 | 测试 | 引擎门面 `TerminalExecutorImpl` 零测试 |
| P4-13 | P4 | 性能 | 空闲时每 2.5s 全量递归 readdir 签名 |
| P4-14 | P4 | 性能 | 日志追加是 O(文件大小) 的读改写 |
| P5-15 | P5 | UX | 无法中断运行中的命令（Ctrl+C 空转） |
| P5-16 | P5 | UX | 无命令历史 / 上下箭头 / Ctrl+R / Tab 补全 |
| P5-17 | P5 | UX | 命令队列无法清空 |
| P6-18 | P6 | 安全 | 无 CSP 响应头 |
| P6-19 | P6 | 安全 | `?test=1`/`?bench=1`/`?scenario=1` 把内部句柄挂到 `window` |

---

# P0 — 正确性 / 数据完整性风险

## P0-1 [x] 自动快照门控「等长编辑」丢数据窗口

- **优先级**：P0 · **类别**：数据完整性
- **相关文件**：[persist.ts:156-193](src/persist.ts#L156-L193)（签名门控）、[main.ts:321-330](src/main.ts#L321-L330)（自动快照）、[config.ts:12](src/config.ts#L12) / [services.ts:86](src/services.ts#L86) / [motd.ts:49](src/motd.ts#L49)（forcePersist）

### 问题描述

自动快照的去重完全基于**目录结构签名**（`computeListingSignature`：递归 `readdir` 树，输出 `path=name:type`）。**WebContainer 的 `DirEnt` 没有文件 size / mtime**，因此签名只能捕捉目录结构变化（增/删/改名），对**「内容变化但字节数不变」的编辑完全不可见**。

快照的保存路径有两条，覆盖不对称：

1. **浏览器侧写入**（`env` / `settings` / `motd` / `workspace switch` / 服务定义）→ 各自调用 `forcePersist()`（`saveSnapshot(fs, true)`）强制落盘 → **安全**。
2. **用户经 Lifo / shell 的编辑**（`sed -i`、`vi` 改成同长度、`echo x > f` 恰好同长）→ 不在任何 force 路径里 → 门控不命中 → 自动快照跳过写 → **仅剩 `pagehide`/`beforeunload` 的 flush 兜底**。

### 触发场景 / 失败场景

1. 用户在终端执行 `sed -i 's/foo/bar/' /workspace/app.ts`（`foo` 与 `bar` 同长）。
2. 目录结构无变化 → 下一个 2.5s 自动快照的门控比对命中 → 复用上次结果，**不写 IndexedDB**。
3. 在下次结构变化 / 页面关闭之前，**浏览器标签页被 OOM 杀掉 / 系统崩溃 / OS 回收**（这些都不触发 `beforeunload`）。
4. 刷新后快照恢复到的是编辑前的旧内容 → **该次等长编辑永久丢失**。

### 为什么重要

这是项目「刷新不丢数据」核心承诺的一个真实（虽窄）漏洞。项目已多处打补丁（H1 forcePersist、N2 emptyDirs 纳入签名），但根因未除：**签名维度缺「内容」**。

### 建议方案

- **首选**：签名升级为「结构签名 + 顶层小文件内容哈希」。对根目录下少量配置文件（`/etc/succinix.*`、`/ws/.current`、`/browser-wrote.txt` 等）与用户可见的小文件做内容哈希并入签名；文件量级在几 KB 内，遍历代价可忽略。缺点：无法覆盖任意深度的用户大文件。
- **可选补充**：给自动快照加「最大年龄强制」——即使签名一致，超过 N 秒（如 30s）也强制全量写一次，把丢失窗口收敛到「等长编辑发生在最近 30s 内且 tab 恰好崩溃」。代价：空闲时每 30s 一次全量遍历（比现在 2.5s 一次还要稀疏，反而省）。
- **兜底**：在 README 的 Known Boundaries 里如实标注该窗口（当前文档只写了浏览器侧 force 覆盖，容易误导用户以为任意编辑都受保护）。

### 验收标准

- 构造一个「同字节数内容编辑」的 e2e：编辑 → 模拟崩溃（不开 pagehide）→ 刷新 → 断言内容保留。
- 或至少：`sed -i` 等长编辑后 2.5s 内，IndexedDB 快照的 content 确实更新。

### 工作量

- 顶层哈希方案：约 2-4 小时。
- 最大年龄强制方案：约 1 小时。

---

## P0-2 [x] host 重启后陈旧 `/cmd.json` 可能被执行一次

- **优先级**：P0 · **类别**：正确性
- **相关文件**：[host.ts:711-724](src/engine/host.ts#L711-L724)（轮询循环 + `processedId` 去重）、[main.ts:368-425](src/main.ts#L368-L425)（看门狗重启）

### 问题描述

host 轮询 `/cmd.json` 用 `processedId` 去重（只跳过 `id === processedId`），但 **host 处理完请求后从不删除 `/cmd.json`**；每次浏览器写入都是覆盖。`processedId` 是 host 进程内的模块级变量，**新 host 启动时是全新的 -1**。

### 触发场景 / 失败场景

1. 浏览器写入 `/cmd.json`（含某请求 A）。
2. host 尚未读取 / 刚读到尚未处理完时，看门狗判定失联（或 boot 重试），kill 旧 host，spawn 新 host。
3. 磁盘上残留的 `/cmd.json`（请求 A）被新 host 读到，`processedId` 从 -1 开始 → **不重复，直接执行**。
4. 新 host 写 `/result-<idA>.json`。浏览器对 idA 的等待早已超时放弃，结果被忽略 → **多数时候无害**。
5. 但若浏览器恰好在同一窗口又发出新请求、且 id 复用/文件写入交错，存在不确定性；且**陈旧命令确实被真实执行了一次**（副作用可能发生两次）。

### 为什么重要

属于「无害但不确定」的隐患。看门狗/重启是项目已投入大量精力打磨的稳定路径（TASK16/18/19 双 host 竞态），这个窗口与「单 host 不变量」的追求相悖，应低成本关闭。

### 建议方案

- **首选**：host 每处理完一个请求后 `fs.unlinkSync('/cmd.json')`（吞掉不存在/删除失败）。浏览器侧下一拍仍会覆盖写入，行为不变。
- **或**：看门狗重启路径（`restartHost` / `waitForHostReadyWithRetry` 的 beforeRetry）在 spawn 新 host 前删除 `/cmd.json`，把陈旧命令窗口关掉。
- 二选一即可，推荐前者（host 侧自愈，覆盖所有重启来源）。

### 验收标准

- 单测/自检：写入一个伪造的 `/cmd.json` → kill+respawn host → 断言新 host 不会处理它（或处理前已被清理）。
- 现有 `?test=1` 与场景套件回归通过。

### 工作量

- 约 0.5 小时。

---

# P1 — 架构层面

## P1-3 [x] `createTerminalExecutor()` 门面未被主应用使用，两条执行路径并行

- **优先级**：P1 · **类别**：架构
- **相关文件**：[engine/index.ts:132-206](src/engine/index.ts#L132-L206)（门面）、[main.ts:107-301](src/main.ts#L107-L301)（主应用直接用 `TerminalClient`）、[boot.ts:362-378](src/boot.ts#L362-L378)

### 问题描述

引擎对外宣称「主应用与生态消费者统一走 `createTerminalExecutor()`」，但**主应用实际走低层路径**：

- `TerminalClient` + `bootEngineHost` + `waitForHostReady`（[boot.ts:362-378](src/boot.ts#L362-L378)）
- 看门狗用 `client.pingDirect()`（绕过互斥队列的直接探活，[main.ts:341-363](src/main.ts#L341-L363)）
- 重启路径需要 `hostProc` 句柄（`respawnWithKillFirst`，[main.ts:368-425](src/main.ts#L368-L425)）

门面 API 缺少这三样：**`pingDirect()`、`getHostProc()`、respawn 支持**。因此主应用的看门狗/重启无法在门面上表达 → 主应用只能绕过门面。

### 为什么重要

- **两条路径同时维护**：低层路径（主应用在用、有测试覆盖）与门面路径（生态在卖、零测试）。
- README/SDK 把门面描述成「引擎 API」与「未来 `@succinix/engine`」，实际主应用都没用它 → **宣传面与实现面不一致**，生态消费者照着文档用可能踩到文档没写的差异。

### 建议方案（二选一，推荐前者）

1. **把门面补全，主应用整体消费**：
   - 门面增加 `pingDirect()`、`getHostProc()`、`respawn()`（内部 `respawnWithKillFirst`）。
   - `main.ts` / `boot.ts` 改为构造 `createTerminalExecutor()`，把看门狗与重启迁到门面之上。
   - 兑现「单一执行面」愿景，生态与主应用同源。
   - **工作量**：1-2 天（含迁移 + 补门面单测）。
2. **明确分工**：文档（README/SDK/PROTOCOL）注明「门面 = 生态最小面；主应用 = 完整面（含看门狗/重启），两者不是同一接口」，避免误读。低成本，但遗留双路径维护成本。

### 验收标准

- 采用方案 1：`grep -rn "TerminalClient" src/ --include=*.ts` 只剩 engine 内部与门面；`?test=1` + 场景套件全过。
- 采用方案 2：文档增加显式段落，无代码改动。

---

## P1-4 [x] 最复杂的 `host.ts`（740 行）是测试盲区

- **优先级**：P1 · **类别**：架构 / 测试
- **相关文件**：[host.ts](src/engine/host.ts)（740 行）、[vitest.config.ts:12-24](vitest.config.ts#L12-L24)（覆盖门禁不含它）、对照：[host-procs.test.ts](tests/host-procs.test.ts)、[tokenize.test.ts](tests/tokenize.test.ts)

### 问题描述

`host.ts` 集中了全部最容易出错的逻辑，**但没有一个单测**，只靠浏览器 e2e / `?test=1` 兜底：

- 统一路由决策（node / python / lifo 三路，`dispatchRun`）
- shell 元字符回退（`hasShellMetaToken` → Lifo shell 转发）
- spawn 确认窗口（`SPAWN_CONFIRM_MS`，早退判定）
- 输出上限截断（`capOutput` / 2 倍增量截断）
- 超时兜底（`timer` kill）
- 会话 cwd 的三套映射：`vfsToReal` / `spawnCwd` / `lifoSpawndCwd` / `resolveBrowserPath` / `pythonRuntimeArgs`（TASK24 双根修复的产物）
- EACCES hint（`withEaccesHint`）
- 陈旧结果文件清理（`pruneStaleResults`）

而它引用的 `host-procs.ts`、`tokenize.ts`、`boot-retry.ts`、`host-restart.ts` 都已有单测——**恰恰是更简单的被测了，最复杂的没被测**。e2e 每跑一次要起 WebContainer + headless Chrome，无法在正常开发循环里高频执行。

### 为什么重要

这些逻辑已在 e2e 里验证过正确，但**回归保护脆弱**：任何一次重构（如 P2-8 抽重复）如果只依赖 e2e，改错一行要在 CI/nightly 才能发现。

### 建议方案

把 host.ts 里**无副作用的纯逻辑**提取成独立模块（项目已有这个模式：`boot-retry.ts` 的可测重试、`host-restart.ts` 的可测重启、`tokenize.ts` 的可测分词），补单测：

- 路由判定：`node|npm|npx` / `python|pip` 前缀 + shell 元字符 → 应走哪条路
- 路径映射：`vfsToReal` / `spawnCwd` / `resolveBrowserPath` / `pythonRuntimeArgs` / `lifoSpawndCwd`
- 字符串处理：`capOutput` / `withEaccesHint` / `commandSignature`（services 同款归一可复用）
- spawn 确认窗口的决策函数（把「early exit」判定提纯）

### 验收标准

- 新模块单测覆盖上述纯逻辑，纳入 vitest 覆盖门禁。
- 现有 e2e 回归通过（行为不变）。

### 工作量

- 约半天。

---

## P1-5 [x] 进程归属判定是「命令串 + cwd」启发式，可被伪装

- **优先级**：P1 · **类别**：架构
- **相关文件**：[host-procs.ts:39-71](src/engine/host-procs.ts#L39-L71)（`SYSTEM_PROCESS_PATTERNS` / `classifyProcess`）

### 问题描述

`classifyProcess` 判定 system 的依据是**命令串正则匹配**：`/(?:^|\s)(?:node|npm|npx)\s+(?:\S*\/)?host\.js(?:\s|$)/`、`/\/usr\/lib\/succinix\//`。任何用户进程只要命令串长得像（例如 `node /usr/lib/succinix/fake.js` 或 `npx host.js`）就会被标为 `system`。

该字段是为 SunamAI 侧的**容器隔离语义**（`scope=container` → 查询过滤 / kill 拦截）设计的。对单用户沙箱本身无害，但既然是"隔离的依据"，它就不是安全边界。

### 为什么重要

- 文档/README 目前措辞偏"判定"，未强调**启发式、可伪造、非安全边界**。
- 未来若该字段被信任用于安全决策（kill 拦截），存在被绕过的风险。

### 建议方案

- 在 [host-procs.ts:7-9](src/engine/host-procs.ts#L7-L9) 的模块注释与 README 的进程管理小节里**明确标注**：「scope 判定是启发式（命令串 + cwd），面向 UI 展示与查询过滤，**不是安全边界**；不能作为权限/隔离的信任依据」。
- 可选：把进程登记改为**显式声明制**（`spawn` 时调用方显式传 scope，而不是事后猜），让宿主方自己决定语义。

### 验收标准

- 文档明确标注；`?test=1` 的归属断言用例仍通过。

### 工作量

- 文档标注：约 0.5 小时。显式声明制：约半天。

---

# P2 — 代码质量 / 重复代码

## P2-6 [x] 跨模块重复辅助函数（sleep / forcePersist / ensureParentDir / ANSI 常量）

- **优先级**：P2 · **类别**：重复代码
- **相关文件**：
  - `sleep` **7 处**：[main.ts:26](src/main.ts#L26)、[boot.ts:31](src/boot.ts#L31)、[commands.ts:65](src/commands.ts#L65)、[services.ts:58](src/services.ts#L58)、[tests.ts:68](src/tests.ts#L68)、[engine/index.ts:63](src/engine/index.ts#L63)、[engine/client.ts:36](src/engine/client.ts#L36)
  - `forcePersist` **3 处**：[config.ts:12](src/config.ts#L12)、[services.ts:86](src/services.ts#L86)、[motd.ts:49](src/motd.ts#L49)
  - `ensureParentDir` **4 处**：[config.ts:60](src/config.ts#L60)、[services.ts:96](src/services.ts#L96)、[motd.ts:12](src/motd.ts#L12)、[persist.ts:321](src/persist.ts#L321)
  - ANSI 常量 `AMBER/RED/GRAY/RESET` **4 处**：[main.ts:21-24](src/main.ts#L21-L24)、[commands.ts:60-63](src/commands.ts#L60-L63)、[boot-ui.ts:34-37](src/boot-ui.ts#L34-L37)、[tests.ts](src/tests.ts)

### 问题描述

四处辅助逻辑在各文件里重复定义，**实现完全一致**（`sleep` 每个都是同一行 `const sleep = (ms) => new Promise(...)`；`forcePersist` 每个都是 `saveSnapshot(fs,true)` + try/catch + `console.warn`）。ANSI 颜色常量 4 份拷贝，任何一处调色（如暗橙改色）要同步改 4 个文件，漏一个就出现终端颜色不一致。

### 建议方案

- 新建 `src/util.ts`：导出 `sleep` / `ensureParentDir` / `forcePersist`（forcePersist 可接受 `fs` 参数，签名保持 `saveSnapshot(fs, true)` 语义）。
- 新建 `src/theme.ts`：导出 `AMBER/RED/GRAY/RESET`（以及 xterm 主题色、`KIND_COLOR` 等，供 main/boot-ui/tests 复用）。
- 逐文件替换为 import；`forcePersist` 的 `console.warn` 前缀文案（`[config]`/`[services]`/`[motd]`）可改为一个 `tag` 参数或统一去前缀。
- 注意：`src/engine/*` 自包含原则（引擎不依赖系统层）——`sleep` 若放 `src/util.ts`，engine 引用它会破坏「引擎零依赖系统层」的边界。**建议 `sleep` 放一个 engine 内共享模块**（如 `src/engine/sleep.ts` 或并入 `tokenize.ts` 旁），或保留 engine 内的小重复。

### 验收标准

- `grep -rn "const sleep = (ms" src/` 归零（engine 内最多一处共享）。
- 颜色常量单文件定义；lint / typecheck / 单测通过。

### 工作量

- 约 1-2 小时（纯机械，零风险）。

---

## P2-7 [x] 版本号硬编码 4 处，升级必漂移

- **优先级**：P2 · **类别**：一致性
- **相关文件**：
  - [commands.ts:67](src/commands.ts#L67)：`const VERSION = 'Succinix 0.2.0 (browser-native Linux)'`
  - [commands.ts:1185](src/commands.ts#L1185)：`unameFields().version = '0.2.0'`
  - [main.ts:32](src/main.ts#L32)：`WELCOME_BANNER` 内含 `Succinix 0.2.0`
  - [motd.ts:10](src/motd.ts#L10)：`DEFAULT_MOTD` 内含 `Succinix 0.2.0`

### 问题描述

下次升版本要改 **4 个文件**，漏一个就出现「`motd` 说 0.2.0、`uname` 说 0.2.1、`version` 说 0.2.2」的不一致——而项目恰恰很在意「不输出假数据」（uname 不冒充 Linux 版本就是为此）。**构建期注入已经在用了**：[vite.config.ts:22](vite.config.ts#L22) 的 `__UNAME_RUNTIME__` 从 `node_modules` 读 `@webcontainer/api` 版本注入。

### 建议方案

- 复用同款模式：`vite.config.ts` 从根 `package.json` 读 `version`，`define` 一个 `__SUCCINIX_VERSION__`，替换上述 4 处的硬编码字面量。
- `package.json` 已是版本单一事实来源；升版本只改一处。

### 验收标准

- `grep -rn "0\.2\.0\|0\.1\.2" src/` 归零（除测试断言/文档）。
- `version` / `uname` / `motd` / `help` 输出一致。

### 工作量

- 约 1 小时。

---

## P2-8 [x] `host.ts` 内三份「spawn + 输出收集 + 进程登记」逻辑

- **优先级**：P2 · **类别**：重复代码
- **相关文件**：
  - `forward`（Lifo 混合链转发）：[host.ts:216-252](src/engine/host.ts#L216-L252)
  - `spawnChild`（run node/python）：[host.ts:515-576](src/engine/host.ts#L515-L576)
  - `dispatchSpawn`（后台 spawn）：[host.ts:582-633](src/engine/host.ts#L582-L633)

### 问题描述

三处都在做同一件事的变体：`spawn(prog, args, {cwd, env})` → `registerProcess` → stdout/stderr 数据累积 + 2 倍上限增量截断 + `appendProcessOutput` → close/error 结算。差异仅在：确认窗口（spawn 有）、结果文件形态（run 写 result、spawn 立即回 ok:true+pid）、以及 `withEaccesHint` 的应用位置。

### 建议方案

- 抽一个共享的 `spawnCaptured(prog, args, opts)`：
  - 输入：`prog`、`args`、`cwd`、`env`、`label`、`onSettle(payload)`、`confirmMs?`
  - 内部：spawn → 登记 → 输出累积/截断 → 超时兜底 → close/error 结算 → `onSettle`。
  - `forward` 的差异（写 Lifo ctx 流 + abort 监听）可经一个可选的 `onChunk(s, isErr)` 或 `outputSink` 注入。
- 与 P1-4 联动：抽出后顺便把输出累积/截断逻辑提纯，方便单测。

### 验收标准

- 三处行为不变（e2e 回归）；host.ts 行数下降。
- `?test=1` 的 spawn 早退 / run 超时 / 混合链进程登记断言全过。

### 工作量

- 约半天（建议与 P1-4 合并做）。

---

## P2-9 [x] `dbStart` 4 段几乎相同的失败输出块

- **优先级**：P2 · **类别**：重复代码
- **相关文件**：[commands.ts:186-274](src/commands.ts#L186-L274)

### 问题描述

`tinbase: failed to start (engine wasm): ...` 这组 `term.writeln(RED...)` 在 `dbStart` 里重复了 **4 次**，区别只是行尾文案（`check container network.` / `check container compatibility.` / `process exited (pid=...)` / `WebContainer may not run WASM servers.`）。同时 install 失败路径还有一套几乎相同的双层 `writeln`。

### 建议方案

- 抽局部 `fail(why: string)` 辅助：`term.writeln(RED + 'tinbase: failed to start (engine wasm): ' + why + RESET)`。
- 把「install 失败 / spawn 失败 / 早退 / 超时」四路的差异化文案收敛到各自的 `why` 字符串，重复骨架只留一处。

### 验收标准

- `db start` 各失败路径输出与现有一致（文案拼接结果不变）；无行为回归。

### 工作量

- 约 0.5 小时。

---

## P2-10 [x] `execute()` 与 `scenarioRun()` 是同一管线的两个拷贝

- **优先级**：P2 · **类别**：重复代码
- **相关文件**：[main.ts:195-255](src/main.ts#L195-L255)（`execute`）、[main.ts:262-301](src/main.ts#L262-L301)（`scenarioRun`）

### 问题描述

两者执行路径完全一致：「`tryHandleLocalCommand` → python/pip 预注入（`ensurePythonRuntime`）→ `client.terminal` → 协议响应 / stdout+stderr / exit 码 呈现」，差异只在**输出目标**（xterm `term` vs capture shim）和**协议响应是否渲染**。`scenarioRun` 甚至已经用了 `{...ctx, term: shim}` 传 shim，只差把 `execute` 里 `printProtocolResponse` 等渲染分支也走注入的 term。

### 建议方案

- 抽公共 `runPipeline(ctx, cmd, {term, protocolRender: boolean})`：
  - `execute` = `runPipeline(ctx, cmd, {term, protocolRender: true})`
  - `scenarioRun` = `runPipeline(ctx, cmd, {term: shim, protocolRender: false})`，返回捕获行。
- 消除 `ensurePythonRuntime` 注入逻辑与 try/catch 呈现的双份拷贝。

### 验收标准

- `?test=1` 与 `?scenario=1`（`scripts/scenarios.mjs` 的 14 场景）回归全过。

### 工作量

- 约半天。

---

# P3 — 测试覆盖缺口

## P3-11 [x] 覆盖率门禁只覆盖 6 个纯逻辑文件

- **优先级**：P3 · **类别**：测试
- **相关文件**：[vitest.config.ts:12-24](vitest.config.ts#L12-L24)、[commands.ts](src/commands.ts)（1409 行，最大文件）、[host.ts](src/engine/host.ts)（740 行）、[main.ts](src/main.ts)（548 行）、[boot.ts](src/boot.ts)（449 行）、[client.ts](src/engine/client.ts)（209 行）

### 问题描述

`vitest.config.ts` 的 ≥70% 门禁仅覆盖 `log/persist/services/pkg/motd/config` 6 个文件。**最大的 `commands.ts`（1409 行）、以及 `boot.ts` / `client.ts` 完全不在门禁内**。其中：

- `commands.ts` 有大量纯逻辑：`commandMentionsPort`（端口匹配正则）、`processLabel`、`buildNetstatRows`、`buildUnameLine` / `buildUnameAllLine` / `unameCmd`、`detectUnameArch`、`buildWorkspaceList`、`workspaceCreate/Switch/Remove`、`fmtUnit`、`snapshot` 分支——多数已导出，直接可测。
- `client.ts` 的 `READONLY_PROTO` 重试语义、`pingDirect` 通道忙判断是纯逻辑，可注入 fake FS 测。

### 建议方案

- 把 `commands.ts` 的纯函数（表格构建 / 正则匹配 / uname / workspace）补单测，纳入门禁。
- `client.ts` 用 mock `wc.fs`（`tests/helpers/fakes.ts` 已有 fake FS）测：串行队列、只读命令重试、`pingDirect` 的通道忙跳过。

### 验收标准

- 新增文件 ≥70% 覆盖（与现有门禁一致）；`npm run test:coverage` 通过。

### 工作量

- 约 1 天。

---

## P3-12 [x] 引擎门面 `TerminalExecutorImpl` 零测试

- **优先级**：P3 · **类别**：测试
- **相关文件**：[engine/index.ts:132-206](src/engine/index.ts#L132-L206)

### 问题描述

`createTerminalExecutor()` 门面（`boot/exec/spawn/listProcesses/kill/ping/dispose`）没有任何测试。它是 `@succinix/engine` 生态包的对外契约面；若采纳 P1-3 让主应用消费它，这条路径**必须有测试**。

### 建议方案

- 用 `tests/helpers/fakes.ts` 的 fake wc + fake client 测门面：`boot` 的资产注入与 host 拉起顺序、`exec` 超时返回 `{timedOut:true}` 而非抛异常、`dispose` 幂等、未 boot 调用抛错。
- `exec` 的异常收敛路径（`catch → {ok:false, timedOut:true}`）尤其值得测——它吞掉了所有原始错误，容易掩盖 host 侧 bug。

### 验收标准

- 门面方法全部有断言；`?test=1` 回归通过。

### 工作量

- 约 0.5 天。

---

# P4 — 性能

## P4-13 [x] 空闲时每 2.5s 全量递归 readdir 签名

- **优先级**：P4 · **类别**：性能
- **相关文件**：[main.ts:321-325](src/main.ts#L321-L325)（`setInterval(..., 2500)`）、[persist.ts:156-193](src/persist.ts#L156-L193)（`computeListingSignature` / `collectWithGate`）

### 问题描述

自动快照每 2.5s 跑一次 `computeListingSignature`：**递归 readdir 整个容器 FS 树**（路径 + name:type，排除规则命中剪枝）。即使签名一致跳过读文件，**递归 readdir 本身每 2.5s 发生一次**。对一个数千目录的 workspace，这是虚拟化 FS 上每秒约 400 次 readdir 的空闲开销；结构变化时还要叠加全量文件读取 + 全量写 IDB。

### 建议方案

- **间隔指数退避**：目录签名连续 N 次不变 → 拉长到 5s / 8s / 15s；有变化立即复位到 2.5s。空闲时大幅降频，活跃时保持灵敏。
- 或把空闲间隔直接提到 5-8s（用户很少依赖「5 秒内的崩溃恢复」），结构/内容变化经 forcePersist 仍即时落盘。

### 验收标准

- bench（`scripts/bench.mjs` 的 snapshot 指标）空闲期开销下降；不引入新的丢数据窗口。

### 工作量

- 约 1 小时。

---

## P4-14 [x] 日志追加是 O(文件大小) 的读改写

- **优先级**：P4 · **类别**：性能（backlog）
- **相关文件**：[log.ts:65-80](src/log.ts#L65-L80)（`doLog`）

### 问题描述

`doLog` 每次追加 = 读整个 `/var/log/succinix.log` + 拼一行 + 写回整个文件（**WebContainer 1.6.4 的 FileSystemAPI 没有 `appendFile`**，注释已说明）。200KB 上限内单次可接受，但命令高峰（npm install 期间每条命令都记 INFO）会：

- 串行写链排队（`writeChain`），每条 O(n) 读改写 → 总体 O(n²)。
- 大文件时读改写放大明显，且每次读回整个文件占用虚拟化 FS 带宽。

### 建议方案（backlog，不紧急）

- WebContainer 提供 `appendFile` 时切换为真正追加。
- 或改**分片文件**：`/var/log/succinix.log.<ts>` 按大小滚动，读旧片 + 写新片，避免反复读回整个尾部。
- 至少把这条记入 backlog，标注为「日志系统未来最先扛不住的部位」。

### 工作量

- 依赖上游能力，暂不可做；先记录。

---

# P5 — 功能 / UX 缺口

## P5-15 [x] 无法中断运行中的命令（Ctrl+C 空转）

- **优先级**：P5 · **类别**：UX
- **相关文件**：[main.ts:140-147](src/main.ts#L140-L147)

### 问题描述

`Ctrl+C` 在 `busy` 时只打印 `^C\r\n running, not interrupted`。一个挂起的 `npm install` / `curl` / 长 `python -c` 只能等 host 侧超时（node 30s / lifo 25s / python 150s）自然返回。对 shell 使用者这是**最违反直觉的行为**——真实终端里 Ctrl+C 是基本盘。

### 建议方案

- `busy` 时 `Ctrl+C`：发送一个 host 的 `kill`（给当前在途命令的进程）或新增协议命令 `interrupt`（kill 当前在途子进程的进程组）。`spawnChild` 里 child 已在进程表（`registerProcess`），可经 `killProcess(pid)` 复用现有链路。
- 需区分「前台 run 的子进程」与「后台 spawn 的服务」：Ctrl+C 只该中断当前 run，不动后台服务。
- 若做到，`db start` 装包 / `npm install` 挂起时用户不再只能干等。

### 验收标准

- 起一个 `sleep`-类长命令 → Ctrl+C → 命令立即返回且进程表中被 kill；后台服务不受影响。
- 现有场景套件回归。

### 工作量

- 约半天到 1 天（涉及协议扩展 + 进程表查询当前在途命令的 pid）。

---

## P5-16 [x] 无命令历史 / 上下箭头 / Ctrl+R / Tab 补全

- **优先级**：P5 · **类别**：UX
- **相关文件**：[main.ts:107-160](src/main.ts#L107-L160)（`handleData`）、[main.ts:154](src/main.ts#L154)（Tab `continue`）

### 问题描述

`handleData` 未处理：

- **上/下箭头**：xterm 会把 `\x1b[A`/`\x1b[B` 作为 data 传入，被 `ch >= ' '` 当作普通字符显示（终端会输出转义序列乱码）。
- **Tab 补全**：`if (ch === '\t') continue;` 直接忽略。
- **Ctrl+R 反向搜索**：无。
- 也没有命令历史缓存——REPL 连「重复上一条」都做不到。

对于一个自称「浏览器原生 Linux」的交互式 shell，这是显著缺失。

### 建议方案

- 用 xterm 的 `onKey` + `_parser`（或 `onData` 里识别 `\x1b[A` 等序列）实现：
  - 上下箭头浏览 `history[]`（回显时先清当前行再写历史行）。
  - 历史在 `sessionStorage`/内存中持久（`/etc/succinix.history` 可选）。
- Tab 补全：从内置命令表（`tryHandleLocalCommand` 的 case 列表）+ 当前目录条目（经 host `ls` 或 wc.fs readdir）做简单前缀补全。
- Ctrl+R 可作为后续项。

### 验收标准

- 上箭头调出上一条并可直接回车执行；Tab 能补全内置命令名与文件路径。

### 工作量

- 历史：约半天。Tab 补全：约半天到 1 天。

---

## P5-17 [x] 命令队列无法清空

- **优先级**：P5 · **类别**：UX
- **相关文件**：[main.ts:78](src/main.ts#L78)（`queue`）、[main.ts:117-124](src/main.ts#L117-L124)（入队逻辑）

### 问题描述

busy 时连续输入的命令排进 `queue`，**没有任何方式丢弃它们**。`Ctrl+C` 在非 busy 时清空当前行，但 busy 时既不中断当前命令也不清队列。用户误输入一串命令后只能等全部执行完（或刷新页面）。

### 建议方案

- `Ctrl+C` 在 busy 时：中断当前命令（P5-15）并**清空 queue**（提示 `queued commands discarded (N)`）。
- 或加一个 `Ctrl+C` 连按 / `^C` 语义：第一次中断当前，后续丢弃队列。

### 验收标准

- busy 时连按 Ctrl+C：当前命令中断且队列清空，回到提示符。

### 工作量

- 与 P5-15 合并做，增加约 0.5 小时。

---

# P6 — 安全加固（轻量）

## P6-18 [x] 无 CSP 响应头

- **优先级**：P6 · **类别**：安全
- **相关文件**：[index.html](index.html)、[vercel.json](vercel.json)、[vite.config.ts:24-39](vite.config.ts#L24-L39)

### 问题描述

页面没有任何 `Content-Security-Policy`。纯静态部署（Vercel）时没有 CSP 是最容易被忽略的一层。注意 WebContainer 需要 worker / blob / wasm，**直接上严格 CSP 有破坏风险**，需谨慎评估。

### 建议方案

- 评估一个**基础 header**：`default-src 'self'` + 明确允许 `worker-src blob:`、`script-src 'self'`、`wasm-unsafe-eval`（Lifo/Pyodide 需要）、`connect-src 'self' https://*`（npm registry / Pyodide CDN 按需）。先在 dev 验证 `?test=1` 全过再上 prod。
- 若 WebContainer 内部强依赖无法满足，则**明确记录「CSP 与 WebContainer 兼容性未评估」**，不要强行上造成功能回归。

### 验收标准

- 加上 CSP 后 `?test=1` + `verify-deploy` 仍全过；或文档记录不兼容原因。

### 工作量

- 半天（含兼容性验证）。

---

## P6-19 [x] `?test=1` / `?bench=1` / `?scenario=1` 把内部句柄挂到 `window`

- **优先级**：P6 · **类别**：安全
- **相关文件**：[main.ts:438-459](src/main.ts#L438-L459)

### 问题描述

- `?bench=1` → `window.__succinixBench`（client / wc / term / saveSnapshot）
- `?scenario=1` → `window.__succinixScenario`（client / wc / ports / term / run）
- `?test=1` → 自检结果 `window.__succinixResult`

这些仅在带 query 参数时暴露，生产正常访问不会触发，**风险可接受**。但 `window.__succinixScenario.run` 能驱动任意真实命令、`__succinixBench` 能访问容器 FS——若有人诱导用户打开带参数的 URL（如钓鱼 `succinix.example.com/?bench=1`），页面会把完整容器控制权交给注入脚本。

### 建议方案

- 保持现状（风险很低），但在 README 明确标注这些是测试钩子、不应在生产链接中出现。
- 或：`run` 只保留在 `location.hash` 或本地环境变量门控下（成本较高，可能不划算）。

### 验收标准

- README/AGENTS 增加一句说明；无代码改动。

### 工作量

- 约 0.5 小时（文档）。

---

# 附录：建议执行顺序

| 阶段 | 事项 | 累计成本 |
| --- | --- | --- |
| **第一波 · 快速胜利** | P0-2（清 cmd.json）、P2-6（抽 util/theme）、P2-7（版本号注入）、P2-9（dbStart 失败块合并） | ~1-2 小时 |
| **第二波 · 高价值** | P1-4（host.ts 抽纯函数 + 单测）、P2-8（spawnCaptured 合并）、P5-15 + P5-17（Ctrl+C 中断 + 清队列）、P5-16（命令历史）、P2-10（execute/scenarioRun 合并） | ~2 天 |
| **第三波 · 中价值** | P0-1（快照最大年龄强制）、P4-13（空闲快照退避）、P3-11（commands/client 补测）、P3-12（门面补测） | ~1.5 天 |
| **第四波 · 架构项** | P1-3（门面补全 pingDirect/respawn + 分工文档）、P1-5（进程归属文档标注） | ~1-2 天 |
| **backlog** | P4-14（日志 appendFile 化）、P6-18（CSP 评估）、P6-19（测试钩子文档） | 记录待办 |

> 保持本文件与代码同步：每完成一项，把 `[ ]` 改为 `[x]` 并（可选）附上完成 commit 的哈希。

# 附录：完成记录（2026-08-10 一次性批次）

> 全部 19 项在一次提交批次内完成；下方标注每项的实际方案与范围决策（与上文的「建议方案」可能有出入）。
> 基线：`tsc --noEmit` 0 错 · `vitest run` 221 全过（15 文件）· lint 0 error · 覆盖门禁 94.5%（含新增 host-route.ts + client.ts）。

| 编号 | 实际完成方式 |
| --- | --- |
| P0-1 | 采用「最大年龄强制」：`persist.AUTO_SNAPSHOT_FORCE_INTERVAL_MS = 30000`，`isAgeForced` 纯函数 + 假定时器单测；README Known Boundaries 如实标注残余窗口（等长 shell 编辑发生在最近 ~30s 且 tab 恰好崩溃）。未做顶层内容哈希（遍历代价与收益权衡后放弃，30s 兜底已收敛窗口）。 |
| P0-2 | host 轮询循环处理完（或失败）请求后 `fs.unlinkSync('/cmd.json')`（吞不存在），时序安全论证写入注释；PROTOCOL 文档补充。 |
| P1-3 | 门面补全：`pingDirect()`（绕过互斥队列的看门狗探活）+ `respawn()`（kill-before-spawn 单 host 不变量，就地实现不依赖系统层），`boot` 接受 EngineBootHooks。主应用命令路径仍走 `TerminalClient`（commands/services/pkg 依赖协议原始语义与超时抛异常，~80 处调用点迁移风险高）——README Ecosystem 增加「两个执行面、同一 host」分工段落。 |
| P1-4 | 抽 `src/engine/host-route.ts`：路由判定（classifyPrefix/classifyRoute）、路径映射（vfsToReal/spawnCwdFor/resolveBrowserPath/pythonRuntimeArgs/lifoSpawndCwd/isUnderWorkspace）、capOutput、withEaccesHint、parseKillPid、路由前缀常量。`tests/host-route.test.ts` 23 用例，进入 vitest 覆盖门禁（100%）。 |
| P1-5 | host-procs.ts 模块注释 + README 标注「scope 是启发式（命令串 + cwd），面向 UI 展示与查询过滤，不是安全边界」。 |
| P2-6 | 新建 `src/theme.ts`（ANSI 色单一来源）、`src/util.ts`（sleep/ensureParentDir）、`src/engine/sleep.ts`（引擎自包含 sleep）。`forcePersist` 收敛到 `persist.ts`（带 tag 参数；不放进 util.ts 以免 persist↔util 循环依赖）。ANSI / sleep / forcePersist / ensureParentDir 重复全部归零。 |
| P2-7 | vite.config 从根 package.json 注入 `__SUCCINIX_VERSION__`，`src/version.ts` 消费（vitest 回落 '0.0.0'）；commands（VERSION + uname version）、main（welcome 横幅）、motd（DEFAULT_MOTD）统一替换；uname 运行时版本加 typeof 守卫（vitest 回落空串）。 |
| P2-8 | 抽 `attachOutputCollector`（accumulate/append/both 三模式）+ `spawnTracked`（spawn+登记+接线）；forward / spawnChild / dispatchSpawn 三处共用，行为逐字节不变。 |
| P2-9 | dbStart 抽局部 `fail(why)`，四路失败块收敛，输出逐字节一致。 |
| P2-10 | 抽 `callHostRpc`（python 预注入 + client.terminal，phase 区分注入/RPC 失败）；execute / scenarioRun 变薄包装，日志文案与返回形状逐一保持。 |
| P3-11 | commands 纯函数补 21 用例（workspace/uname/netstat/port 匹配/label/fmtUnit/分发冒烟），导出 processLabel/fmtUnit；client 补 20 用例（串行队列/只读重试/pingDirect/interruptDirect）并进入覆盖门禁。**commands.ts 未入门禁**：1409 行纳入会把聚合拉低到 70% 以下（vitest 无按文件分档阈值），纯函数已单测、处理器由 e2e/自检覆盖。 |
| P3-12 | `tests/engine-facade.test.ts` 14 用例：boot 注入顺序、exec 超时收敛为 `{ok:false,timedOut:true}`、spawn/listProcesses/kill/ping/pingDirect/respawn/dispose 幂等、未 boot 抛错。 |
| P4-13 | 自动快照改为递归 setTimeout 指数退避（2.5s → 5/10/15s，首个间隔后每 2 tick 翻倍、仅 `reason='changed'` 时复位）；与 P0-1 年龄强制解耦（年龄强制不打断退避）。`SaveResult` 增加 `reason` 字段。 |
| P4-14 | backlog：WebContainer FileSystemAPI 无 appendFile（已在 log.ts 注释与 README Known Boundaries 标注），暂不可做。 |
| P5-15 | host 增加 `interrupt` 协议命令（currentRunPid 跟踪前台 run，SIGTERM，后台 spawn/纯 Lifo 不碰）；client 增加 `interruptDirect()`（绕过队列直接写 cmd.json）；main Ctrl+C busy 时中断当前命令。PROTOCOL 文档补充。 |
| P5-16 | 上下箭头历史（内存）+ Tab 补全（内置命令 + 文件路径 readdir，多候选列出 + 共同前缀）；未知转义序列丢弃不产生乱码。 |
| P5-17 | Ctrl+C busy 时先清空队列（提示 discarded N）再发中断，runCommand finally 回到提示符。 |
| P6-18 | 评估后按「不兼容不强行上」：README Known Boundaries 记录 CSP 评估结论（worker-src blob / wasm-unsafe-eval / connect-src 依赖 WebContainer 内部行为，需 ?test=1 验证后启用，暂缓）。 |
| P6-19 | README Testing 小节标注 ?test/?bench/?scenario 是测试钩子，生产链接不得出现。 |

# 附录：后续复审修复（2026-08-10，同批次提交后独立复查）

> 复查 b5bda8b 批次时发现 2 个代码缺陷 + 若干文档缺口，已全部修复并补回归测试。基线重验：
> `tsc` 0 错 · lint 0 error · vitest 全过（host-route 27 / persist 19 新增用例）· 覆盖门禁 ≥70% · 完整 e2e（verify-deploy + bench + 14 scenarios + lang-verify 32 项）全过。

| 编号 | 发现的问题（原始批次偏差） | 修复 |
| --- | --- | --- |
| P0-1 | **年龄强制在快照恢复后失效**：`loadSnapshot` 未初始化 `lastFullSaveAt`（仍是 0），而空闲时内容未变一直 dedup 又永不更新 → `isAgeForced` 恒 false，**刷新后等长编辑的 30s 兜底永不触发，丢失窗口无界**。README 边界描述因此偏乐观。 | `loadSnapshot` 末尾 `lastFullSaveAt = Date.now()`（恢复的这张快照视为刚落盘，30s 窗口重新计时）。回归测试直接向 IndexedDB 种子快照模拟「刷新后恢复」，断言间隔后 `reason=age`。 |
| P0-2 | **finally 盲目删 `/cmd.json` 吞掉带外请求**：处理期间看门狗 `pingDirect` / Ctrl+C `interruptDirect`（绕过队列）写入的新请求被一并删除 → 看门狗等不到 pong 误计失败（连续 2 次误重启 host）、中断丢失。原始注释的时序安全论证只覆盖了串行链，没覆盖带外直接写入。 | 删除前读回校验：仅当文件内容仍是刚处理请求的 id 才删（`host-route.shouldRemoveCmdFile` 纯函数 + 5 用例）；更新的带外请求保留待下轮轮询。 |
| P1-5 | **README 进程管理小节缺 scope 启发式标注**（完成记录称"README 标注"，实际只改了 host-procs.ts + PROTOCOL.md 且 PROTOCOL 缺「非安全边界」）。 | README / PROTOCOL（中英）补「启发式、非安全边界、仅 UI 展示与查询过滤」。 |
| P4-14 | **README 缺日志读改写 backlog 标注**（完成记录称"已在 README 标注"，实际 README 未提）。 | README Known Boundaries（中英）补 O(n) 读改写说明。 |
| P5-15/16/17 | **新交互特性未入文档**：README 特性清单与 `help` 输出都没提 Ctrl+C 中断 / 历史 / Tab 补全。 | README（中英）特性清单 + `help` 输出补 terminal keys 段。 |
| P5-16 复审 | **Tab 补全不随会话 cwd**：无斜杠 token 一律读根目录，`cd /workspace/proj` 之后 `cat fi<Tab>` 补的是根条目而非当前目录。 | `handleTab` 无斜杠 token 经 `client.exec('cwd')`（不经 onCommand，无日志噪音）取会话 cwd，`sessionCwdToBrowserPath`（host-route.ts 纯函数，双根映射 + 3 断言）映射到浏览器可读路径；busy 时回落根目录。顺带删除 `handleData` 里冗余的 `if (ch === '\t') continue;`（单个 Tab 已在循环前处理，嵌入式 tab 由 `ch >= ' '` 守卫一并丢弃）。 |
| 文档同步 | **中文文档滞后**：`docs/README.zh-CN.md`、`docs/PROTOCOL.zh-CN.md`、`docs/SDK.zh-CN.md` 均未同步批次改动（提交只改了英文）。 | 中英双语文档全部对齐（含测试钩子 P6-19、CSP P6-18、两个执行面 P1-3、快照边界 P0-1）。 |
| CHANGELOG | **批次未记入 CHANGELOG**（提交文件列表无 CHANGELOG）。 | `CHANGELOG.md` + `CHANGELOG.zh-CN.md` [Unreleased] 补 19 项批次 + 本附录 2 个修复。 |
| 陈旧注释 | vitest.config「6 个文件」→ 8 个；main.ts 退避「5s/8s/15s」→ 实际 5s/10s/15s。 | 已修正。 |
