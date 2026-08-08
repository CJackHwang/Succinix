# TASK-BOOTGATE — Boot 门禁（未启动完禁止输入）+ 实时进度 + 失败自动重试（最多 3 次）

## 背景（用户明确要求，2026-08-09）

用户在 Succinix 提出三项启动期体验要求：
1. **系统没启动之前不允许输入内容**：当前 `main.ts` 的 `term.onData(handleData)` 在 boot 前就已绑定，boot 期间用户敲键会进 `line` 但 `ctx` 未初始化（`let ctx: CommandContext` 未赋值），回车会因 `ctx` undefined 抛错或行为异常。要求 boot（含可选 ?test=1 自检）完成前输入被忽略（不 echo、不排队、不执行），boot 完成后才响应。
2. **实时显示自检/功能准备进度**：boot 日志目前逐行实时输出（`[  OK  ] Started WebContainer runtime` 等），但每行不带进度计数，用户不知道总体有多少步、当前第几步。要求 boot 日志每行带步骤计数（如 `[  OK  ] 3/12 Started WebContainer runtime`），让"功能准备进度"一目了然。
3. **自检失败自动重试，累计三次**：boot 关键步骤失败（WebContainer.boot 失败、host 就绪失败）目前直接失败退出。要求自动重试最多 3 次，每次重试有可见日志，3 次全败才真正失败。

## 物理边界（保留项，不许改）

- **不改引擎**（src/engine/、PROTOCOL、host 逻辑——纯浏览器侧 boot/main/boot-ui 层改动）
- **?test=1 / ?bench=1 / ?scenario=1 模式兼容**：自检断言逻辑（tests.ts）、bench 打点（__bootTimes）、场景驱动（__succinixScenario）全部不能破坏
- **boot-ui.ts 的 MARKERS 解析**：`[  OK  ]` / `[ FAIL ]` / `[SKIP]` / `[ .... ]` 前缀匹配逻辑不能破坏（进度计数加在 marker 之后、消息文本之前，不改变行首 marker）
- UI 规范：英文、无 emoji、暗橙主题、`[  OK  ]` ASCII 标记
- 不新增依赖
- 环境检测失败（checkEnvironment）**不重试**——浏览器不支持重试无意义，直接错误页

## 需求

### R1. Boot 门禁（未启动完禁止输入）

- `main.ts`：新增 `let booted = false`（或等价状态）。`handleData` 开头：`if (!booted) return;`（**静默忽略**，不 echo、不排队、不显示提示——用户要"不允许输入内容"，不是"提示后再输入"）
- boot 成功完成、motd + 提示符输出**之前**置 `booted = true`（位置：`main()` 内 `prompt()` 调用前；?test=1 自检模式下在自检结果输出后、motd 前）
- **注意 `queue` 交互**：boot 期间输入的字符不应进入 `line`；Ctrl+L/Ctrl+C 等控制键在 boot 期间也应忽略
- boot 失败路径（`catch` → `ui.fail`）不置 booted（错误页常驻，无输入需求）
- 验证：boot 期间连敲 `ls` + Enter → 无任何回显/执行；boot 完成后提示符出现且可正常输入执行

### R2. 实时进度计数（boot 日志带 N/M 步骤）

- `boot.ts`：为 boot 流程维护步骤计数。**总步骤数** = 主启动流程里 `ok()`/`note()` 的调用点数量（含 autostart 循环内每个服务一行）。实现方式任选但输出形态必须一致：
  - 每行日志格式：`[  OK  ] 3/12 Started WebContainer runtime`（marker 后空格 + `N/M` + 空格 + 原文）——**行首 marker 保持原样**，boot-ui.ts 的 parseLogLine 才能继续识别
  - `ok(ui, msg)` / `note(ui, msg)` 内部自动加计数（不逐个调用点手改），计数在模块级递增
- **注意**：`restartHost`（host 失联重启）的 WARN/FAIL 日志**不参与** boot 步骤计数（那是运行期事件，不是 boot 步骤）
- **注意**：`ui.fail()` 的错误页文本不带进度计数（错误场景不适用）
- 自检模式（?test=1）：`tests.ts` 的 verdict/boundary 输出**保持原样不加计数**（那是测试结果不是 boot 进度；boot 阶段的 ui.log 行才加计数）
- 验证：正常 boot 日志每行可见 `N/M` 计数，最后一行 `M/M` 是 TerminalExecutor ready 或最后一个 autostart 服务

### R3. 失败自动重试（最多 3 次）

两个重试点，模式一致：

**R3.1 WebContainer.boot() 失败重试**
- `boot.ts` 的 `WebContainer.boot()` catch 分支：改为重试循环——最多 3 次尝试（含首次），每次失败输出 `[ WARN ] WebContainer boot failed (attempt N/3), retrying...`（经 ui.log），间隔 1s 退避；3 次全败才 `ui.fail([...])` 返回 null
- 重试日志带进度计数（若已开始计数）

**R3.2 host 就绪（waitForHostReady）失败重试**
- `boot.ts` 的 `waitForHostReady(client)` 失败：重试整个 `bootEngineHost`（**必须先 kill 旧 hostProc 再重新 spawn——防双 host 竞态，复用 `respawnWithKillFirst` 模式**，见 main.ts restartHost 的 TASK19 提取），最多 3 次尝试（含首次）
- 每次失败输出 `[ WARN ] TerminalExecutor not ready (attempt N/3), respawning host...`
- 3 次全败才抛错/失败（走现有 main.ts catch → ui.fail 错误页路径）
- **注意**：重试 bootEngineHost 前检查 host.js/lifo-core.js 仍在容器（重新 ensureAsset 幂等可接受）；重试期间进度计数不重复累计（同一 boot 步骤的计数只显示一次或按重试次数显示 attempt）

**不重试清单**（明确不做）：checkEnvironment 失败（错误页）、loadSnapshot 失败（现有 note 继续）、service files/motd 初始化失败（现有 note 继续）、autostart 单个服务失败（现有 FAIL 日志继续）、?test=1 自检断言失败（那是测试结果，不是 boot 步骤）

### R4. 兼容性验证

- `?test=1` 自检全过（tests.ts 断言不变）
- `?bench=1` 的 __bootTimes 打点仍触发
- `?scenario=1` 的 __succinixScenario 仍暴露

## 质量门禁（节选，不跑全量）

1. `npx tsc -p tsconfig.json --noEmit` 0 错
2. `npm run build` 成功（改到 src/ 需 rebuild；不改引擎则 build:host 可跳过——**若改了 boot.ts 之外的 src 文件则跑 build:host**）
3. `npx vitest run` 全绿
4. 浏览器实测（dev server 7892，端口占用双探测）：
   - boot 期间输入完全无效（连敲命令无回显无执行）
   - boot 日志每行带 N/M 计数，逐步递增到 M/M
   - boot 完成提示符出现后可正常执行命令
   - `?test=1` 自检仍通过（≥76 passed）
5. 静态自查 `grep -n '✅\|❌\|🎉\|GREEN' src/ index.html` 0 匹配
6. `git diff --check` 干净

## 提交

- `feat: boot 门禁（未启动完禁止输入）+ boot 日志步骤计数 + 关键步骤失败自动重试（最多 3 次）`

## 开始先读

- `src/main.ts`（onData/handleData、main 流程、restartHost 的 respawnWithKillFirst 用法）
- `src/boot.ts`（主启动流程、ok/note 辅助、waitForHostReady 调用点）
- `src/boot-ui.ts`（parseLogLine 的 MARKERS 前缀匹配——计数加在 marker 后不得破坏）
- `src/host-restart.ts`（respawnWithKillFirst 签名）
