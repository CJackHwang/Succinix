# TASK-BOOTUI — 启动界面精简：去掉大标题/系统信息，boot 日志全程终端显示

## 背景（用户明确要求）

当前启动流程：DOM 覆盖层显示大标题（ASCII art）+ 系统信息网格 + systemd 风格自检日志 → 淡出 → 终端显示 motd + 提示符。用户要求：
1. **去掉花里胡哨的大标题和系统信息**（覆盖层上那两个元素）
2. **启动直接从自检日志那一行开始向下加载展示**（`[  OK  ] Started WebContainer runtime` 等）
3. **正式进入系统时不清屏**——自检内容留在终端滚动历史里，正式界面（motd + 提示符）接在自检后面，**向上滚动可回看自检**

**核心方案**：去掉 DOM 覆盖层（boot splash），boot 日志全程直接写入 xterm 终端——自检日志滚动显示 → motd + 提示符接在后面（不清屏）。天然满足"滚动回看自检"。

## 物理边界

- **不改引擎**（src/engine/、PROTOCOL、host 逻辑——呈现层改动）
- **?test=1 / ?bench=1 / ?scenario=1 模式兼容**（自检输出路径、测试断言不能破坏）
- UI 设计规范保持（英文、无 emoji、暗橙主题、[  OK  ] ASCII 标记）
- 不新增依赖

## 需求

### R1. 去掉覆盖层（大标题 + 系统信息 + DOM splash）

- `index.html`：移除/精简 `#boot-overlay` 结构（boot-title、boot-sysinfo、boot-log 区域）——或保留最小加载态（评估：直接去掉覆盖层 DOM，或保留极简"Loading..."占位）
- `boot-ui.ts`：BootUI 渲染器改造——`log()` 输出从覆盖层日志区改为**写 xterm**（Terminal.write）；`systemInfo()` 改为 no-op（或显示为 boot 日志行，用户说去掉，就 no-op）；`fail()` 环境错误页保留（那是错误场景，需要可见）
- `main.ts`：`createBootUI()` 构造改为终端版（log → term.writeln）

### R2. boot 日志进终端（从自检开始）

- `[  OK  ] Started WebContainer runtime` / `[  OK  ] Restored workspace...` / `[  OK  ] TerminalExecutor ready` 等全部直接写 xterm（现有 boot.ts 的 ui.log 调用不动，只改输出目标）
- 颜色保持：`[  OK  ]` 暗橙、`[ FAIL ]` 暗红（复用现有 MARKER 映射）
- 环境错误页（fail）仍在 DOM 显示（错误场景保留）

### R3. 进入系统不清屏（滚动回看自检）

- 移除任何 boot 完成时的 `term.clear()`（检查 main.ts 144 行的 clear 是什么场景——若是 log clear 命令保留，boot 完成清屏必须移除）
- motd + 提示符**直接接在自检日志后面**（不另起新屏）
- 滚动（scrollback 3000 已配置）可回看全部自检日志

### R4. 自检模式兼容（?test=1）

- `?test=1` 自检输出：现在走 overlayTerminalShim → 覆盖层。改为直接写终端（shim 改指 term 或去掉 shim）
- 自检结果行（"Self-test result: N passed..."）接在自检日志后，符合新流程
- **tests.ts 断言逻辑不动**（只改输出目标）

### R5. 视觉确认

- 启动后终端内容从上到下：boot 日志（[ OK ] 行）→ motd/横幅 → 提示符
- 无大标题、无系统信息网格
- 主题/字体/颜色不变

## 质量门禁

1. `npx tsc -p tsconfig.json --noEmit` 0 错
2. `npm run build` 成功
3. `node scripts/build-host.mjs` 不涉及（不改引擎，无需重建——**除非确认**）
4. 浏览器实测：打开 → 终端直接显示 boot 日志滚动 → motd + 提示符 → **向上滚动能看到完整自检** → 无大标题/系统信息
5. `?test=1` 自检仍通过（tests.ts 断言）
6. 静态自检 `grep -n '✅\|❌\|🎉\|GREEN' src/ index.html` 0 匹配
7. `git diff --check` 干净

## 提交

`feat: 启动界面精简（去大标题/系统信息，boot 日志全程终端，不清屏可回看）`
