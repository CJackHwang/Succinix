# WebUnix — TASK4：启动画面居中自适应 + 环境不适配优雅退出

## 背景

TASK3 已完成（PASS 18/0/5，全英文/暗橙/自检流程/AGENTS.md）。当前启动画面在 xterm 里流式输出（左上角起），用户要求：
1. **大标题和系统信息居中显示**，不同尺寸设备自适应（美化）
2. **环境不适配时简单处理**：必要组件自检没过就"退出"（显示错误停止，不做复杂降级）

## 现状文件

- `index.html`：全屏黑 + `#terminal` div（vite 7892，COOP/COEP 头）
- `src/main.ts`：xterm + REPL + boot 编排（`bootWebUnix(term)` 后建 ctx，`?test=1` 跑 runTests）
- `src/boot.ts`：`detectSystemInfo(): string[]`、`bootWebUnix(term)`（WC boot → 注入 host.js → spawn host → [ OK ] 日志写 xterm → 返回 { wc, client, ports }）
- `src/tests.ts`：自检套件（[ OK ]/[SKIP] 写 xterm）
- `src/commands.ts`：浏览器侧命令（help/ports/db/...）
- 主题：黑底 #0a0a0a、暗橙 #c2702a、暖白 #d6cfc4、JetBrains Mono（AGENTS.md 有完整规定）

## 需求

### 1. 启动画面改为"DOM 居中覆盖层"（核心）

不再在 xterm 里流式输出启动画面，改为一个 **CSS 居中的覆盖层**（`#boot-overlay`），视觉像 Ubuntu/真 OS 的 boot splash：

- 覆盖层：`position: fixed; inset: 0`，黑底 `#0a0a0a`，`display: flex; align-items: center; justify-content: center`，内容垂直水平居中
- 内容从上到下（间距克制、留白舒服）：
  1. **大标题**：ASCII art "WebUnix"（保留现有 figlet 风格字符画，`<pre>` 等宽显示），暗橙 `#c2702a`
  2. 版本行：`WebUnix 0.1.0 — browser-native Linux`（暖白，次要字号）
  3. **系统信息**（复用 `detectSystemInfo()`）：两列网格（`Platform / Browser / CPU / Memory / Language / Timezone`），对齐整齐，`display: grid; grid-template-columns: auto auto` 或 flex wrap，窄屏自动换行
  4. **自检日志区**：独立区块（固定高度 ~8 行，`overflow: hidden`，新行从底部追加、自动向上滚动），`[  OK  ]` 暗橙、`[SKIP]` 暗灰、`[FAIL]` 暗红，等宽字体
- **响应式**：标题字号 `clamp(18px, 4.5vw, 44px)`（等宽字符随字号等比缩放，字符画不变形）；容器 `max-width: min(92vw, 860px)`；窄屏（<640px）系统信息改单列；`@media` 查询处理
- **淡出过渡**：boot 全部完成 → 覆盖层 `opacity` 过渡淡出（~400ms）→ 移除/隐藏覆盖层 → 显示 xterm（提示符出现，用户直接可输入）
- 覆盖层期间 xterm 保持隐藏（或初始不可见），boot 完成才显示

### 2. 环境不适配 → 自检没过即"退出"

boot 开始时（任何 WebContainer 操作之前）做**最小必要检测**，不满足直接显示专业英文错误页（覆盖层内）并停止：

```
检测项：
1. window.crossOriginIsolated !== true
2. 非 Chromium 内核（UA 含 Firefox/Safari 且不含 Chrome/Chromium/Edg）
3. WebContainer.boot() 抛错（try/catch）

错误页形态（覆盖层居中，暗橙主题延续）：
WebUnix
Environment check failed

[FAIL] Cross-origin isolation: not enabled (requires COOP/COEP headers)
[FAIL] Browser: Firefox is not supported (WebContainers requires Chromium)

WebUnix requires a Chromium-based browser with cross-origin isolation.
See README for deployment requirements.
```

- 不做任何降级/兜底尝试，检测失败就停（`return`，不 spawn host、不进终端）
- 错误页文案英文、零 emoji、专业克制（按 AGENTS.md）

### 3. 呈现层重构约束（重要）

- `boot.ts` 的**业务逻辑不变**：WC boot、host.js 注入、spawn host、[ OK ] 步骤顺序、`detectSystemInfo()` 数据、返回的 services——全部保持
- 只改**输出目标**：boot 的日志从"写 xterm"改为"追加到覆盖层日志区"（通过回调或返回的渲染函数注入）；boot 完成信号从"写完最后一行"改为"通知 main.ts 淡出覆盖层并显示 xterm"
- `main.ts` 的 REPL/命令路由/测试逻辑**完全不动**；`tests.ts` 的自检逻辑不动——但 `?test=1` 时自检输出也显示在覆盖层日志区（或：自检跑在覆盖层，完成后再进终端）。二选一由你按实现简洁度决定，保持自检内容不变
- 建议：`boot.ts` 导出结构调整为接受"渲染接口"（如 `{ log(line, kind), done() }`）或返回一个可订阅的事件源；`main.ts` 构造覆盖层渲染器传入。保持 TS strict

### 4. 美化细节

- 覆盖层整体留白充足、行距 1.6、区块间距 24px+；标题与信息之间用一条暗灰分隔线（`border-bottom: 1px solid #2a2520`）或留白区分
- 系统信息键名固定宽度对齐（`min-width` 或 `text-align: right`），值暖白、键暗灰
- 日志区顶部小标题 `System self-check`（暗灰小字）
- 滚动条隐藏、`user-select: none`（覆盖层非交互）
- 字体全部 JetBrains Mono

### 5. 保留项（不许改）

- `vite.config.ts`（7892/COOP/COEP）、文件 RPC（`/cmd.json` → `/result-<id>.json`）、路由规则（node|npm|npx → 真 Node）、spawn/ps/kill 协议、tinbase `--engine wasm`、db 安装超时、`scripts/build-host.mjs`
- 暗橙主题色值、全英文界面、禁 emoji（AGENTS.md）
- 测试逻辑断言（只允许改输出呈现位置）

## 质量门禁

- `npx tsc -p tsconfig.json --noEmit` 0 错误
- `node scripts/build-host.mjs`、`npm run build` 成功
- dev server 起得来（localhost:7892，COOP/COEP 头在位）
- 静态自查：`grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 浏览器人工验证点（你在总结里列出）：启动画面居中观感、窄窗口（~400px 宽）自适应、正常进入终端、环境检测逻辑（可用 DevTools 模拟 crossOriginIsolated=false 或直接改条件测错误页）

## 约束

- 不新增依赖（纯 HTML/CSS/TS 实现）
- 注释中文、标识符英文、TS strict
- 结构沿用现有拆分，覆盖层渲染器可放 `src/boot-ui.ts`（新文件）或并入 boot.ts，你按清晰度决定
- 完成后输出总结：改了哪些文件、覆盖层结构说明、门禁结果、浏览器人工验证清单

## 开始

先读 `src/main.ts`、`src/boot.ts`、`src/tests.ts`、`index.html`、`AGENTS.md`，然后实现。
