# Succinix — Agent 与设计规范

> 中文翻译。英文版为准：见 [AGENTS.md](AGENTS.md)

面向所有修改本项目的人（人类或 AI agent）的设计规则。英文为规范文本；中文为说明性文本。

## 设计规范

- **界面语言：仅英文。** 渲染给用户的每个字符（启动画面 splash、系统信息、帮助、命令输出、错误、自检、端口/数据库信息）都必须为英文。代码注释可保留中文（开发者文档），但绝不可面向终端字符串。
- **禁用 emoji。** UI 全范围内禁用 emoji 与图形字形（如对勾、叉号、彩带、火箭、火焰等图形符号）。仅使用 ASCII 状态标记：`[  OK  ]` / `[ FAIL ]` / `[SKIP]`。用户可见文本中的 Unicode 省略号 `…` 一律替换为 `...`。**适用范围：终端/UI 文本与代码输出** —— 文档（`docs/*.md`）可在表格中使用状态图形以利阅读；下方的静态自检仅扫描 `src/` 与 `index.html`。
- **主题：暗琥珀色（无绿色）。** `background: #0a0a0a`，前景暖白 `#d6cfc4`，光标/强调色暗橙 `#c2702a`，选区 `#3a2a1a`。ANSI 调色板为低饱和暖色系：红 `#c0543a`、黄/金 `#c98a2e`、绿（暗橄榄）`#7a8a5a`、暗灰 `#6b6560`，亮色变体再浅一档。`[  OK  ]` 标记与 ASCII art 启动画面使用琥珀色（`\x1b[33m`），而非绿色。永不引入 `GREEN` 强调常量。
- **字体：JetBrains Mono。** 字体经 `@fontsource/jetbrains-mono` 本地打包（无 CDN）。xterm `fontFamily`：`'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`。
- **专业克制，非玩具感。** 遵循 Linux 惯例：提示符 `guest@succinix:~$ `、`bash: xxx: command not found` 风格错误、灰色 `[exit N]` 标记、`PID  STATUS  COMMAND` ps 表、英文 `unknown command: xxx`。

## 技术约束（不可更改）

- **文件 RPC 通道（file RPC channel）：** `/cmd.json` → `/result-<id>.json`，每次请求一个独立结果文件。不得回退到单一共享结果文件。
- **统一路由（unified routing）：** 以 `node|npm|npx` 开头的命令交给真实 Node 子进程；其余命令交给 Lifo 沙箱。不得更改此分流。
- **开发服务器（dev server）：** Vite 运行于端口 `7892`，带 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: credentialless`（WebContainer 需要跨源隔离 cross-origin isolation）。
- **tinbase：** 必须以 `--engine wasm` 启动（不要 `--memory` —— 数据持久于工作区快照 snapshot；浏览器内安装超时为主机侧 `{ timeout: 120000 }`，客户端等待 `150000`）。
- **`scripts/build-host.mjs`：** `@lifo-sh/ui` 保持外部依赖。产出两个容器内 bundle：`public/host.js`（轻量 host 守护进程 daemon —— RPC 循环、进程表、node 子进程）与 `public/lifo-core.js`（约 1 MB 的 `@lifo-sh/core` 内核，首个 Lifo 命令时经 `import('./lifo-core.js')` 懒加载 lazy-inject）。改动 `src/engine/host/` 下文件、`src/engine/host-procs.ts` 或 `src/engine/lifo-core.ts` 后用 `node scripts/build-host.mjs` 重新构建。

## WebContainer 原生架构（规范性）

- **WebContainer 是执行世界和能力的唯一事实源。** Lifo 不是浏览器侧的仿制层：`lifo-core.js` 由 WebContainer 内的 `node host.js` 动态加载，它的 `/workspace` 挂载与真实 Node/Python 运行时共用同一棵虚拟化 `node:fs`。
- **补充执行世界，不在浏览器外层并行拼装 Linux。** 只要环境物理上可行，新 shell、命令、包、服务、运行时、编辑器、TUI 与第三方扩展都必须存在于 WebContainer/Lifo userland，并共用文件系统、cwd/env、实例、进程、服务、包、持久化与 capability 模型。
- **浏览器只是控制/设备平面。** 浏览器代码可启动 WebContainer、渲染 xterm、采集键盘/resize 事件、暴露必要 Web API，并运输浏览器↔WebContainer 数据。运输必须保持轻薄，不得在执行世界外另造命令实现、文件系统、进程表、服务 registry、包状态或编辑器状态。
- **标准 Unix 名称属于执行世界。** 不得新增覆盖标准命令的浏览器本地实现。纯浏览器管理功能使用 `succinix ...` 命名空间；v0.7 必要时将现有标准名称 local handler 迁入 Lifo/host adapter。
- **交互应用使用 Lifo 原生终端 seam。** `@lifo-sh/core` 根入口导出 `ITerminal`，并通过 `CommandContext.stdin` 与 `setRawMode` 公开命令输入/raw mode；内部 `TerminalStdin` 为该公开契约提供实现。Succinix 必须通过轻薄终端运输将浏览器 xterm 接入 WebContainer 内 seam，并保留流式输出与实时 `cols`/`rows`；不得将 `vi`、`nano` 或第三方 TUI 实现为并行浏览器应用。第三方 package 不得直接导入未从根入口导出的 `TerminalStdin` 实现。
- **内置与第三方交互工具走同一条路径。** `vi`、`nano`、未来 REPL/TUI 与第三方 Lifo package 都运行于 WebContainer userland，使用同一终端 session 协议和生命周期，并进入同一进程/capability 视图。禁止另设 UI-only package 类型。

## Cordis 单轨（0.7.0+）

- `@succinix/engine@0.7.0` 是唯一的 Cordis 插件，根导出为
  `{ name: 'succinix', apply, Config }`。没有独立 SDK 线或第二个
  `plugin-*` 包。
- 普通消费插件只显式声明需要的 dsh 服务：`fs`、`sandbox`、`terminals`、
  `sessionPersistence`。可选服务用 `ctx.get('<key>', false)` 探测；不依赖
  隐式全局或顶层 `ctx.mixin`。
- `ctx.get('succinix', false)` 是同一 Cordis 上下文中的宿主入口，用于生命
  周期、实例、端口、服务、快照和默认执行器；它不替代四个 dsh 服务。接入见
  `docs/SDK.md`，可执行契约见 `docs/cordis-contract.md`。
- 只有 `src/plugin/` 可以 import `cordis`；`src/engine`、`src/terminal`、
  `src/instance`、`src/persist`、`src/services` 必须保持 Cordis-free。
- `./terminal` 与 `./instance` 不是包导出。取得宿主入口后使用
  `host.terminal.open(...)` 和 `host.ensureInstance(...)`。
- 端口和命令回调不是配置字段。使用 `host.onServerReady`、
  `host.onServerClosed` 或有类型的 `succinix/*` 事件订阅。
- 页面级 HostManager 是模块单例；fiber reload 不得重启 host。只有
  `shutdown()` 或页面卸载会硬关闭 host。
- 改动 `src/plugin/` 后用 `node scripts/build-engine-package.mjs` 重建引擎包；
  它会重新生成 `packages/engine/assets/sha256.json` 并校验包导出。
- 当前集成文档为 `docs/SDK.md`、`docs/PLUGIN.md`、`docs/MIGRATION.md`、
  `docs/cordis-contract.md`。
- 实际 npm publish 与旧版本 deprecate 属 release-owner 动作；用户未明确
  要求时不发布。

## 明确未实现（不要硬造）

浏览器环境限制照单全收。不构建无真实价值的模拟；某项能力确实无法工作时，省略或明确降级：

- **多用户 / 登录 / 权限隔离（multi-user）。** 组织性隔离（嵌入模式可用）：目录·状态·进程视图按实例/用户分割（`?instance=<id>` / `?user=<id>`）；**非安全边界** —— 无真内核/权限位。没有真实隔离的登录仪式仍无价值；独立应用 `guest` 仍为唯一用户；权限位 / `chmod` 语义仍不做。
- **权限位管理（`chmod` 语义）。** 模拟模式无实际价值；不伪造。
- **真实内核 / apt / 原生二进制。** 沙箱内物理不可行。Succinix 是浏览器原生 Linux（JS 运行时 + Lifo 用户态）。
- **入站外部网络（inbound networking）。** 端口是虚拟 preview；隧道是出站桥接，不是真实入站。
- **无 CORS 的直接外部 `curl`。** 请用 `https://r.jina.ai/<url>` 风格代理。
- **通用子进程 stdin 当前不可用。** 现有 Succinix host 使用文件 RPC 与 headless `Sandbox.commands.run()`，因此任意真实 Node/Python 子进程 REPL 仍不支持。这是当前运输限制，不是在浏览器侧造替代品的理由：交互 userland 必须使用上述 WebContainer 原生 Lifo 终端 seam。通用子进程 PTY 未独立实现并验证前，不得宣称支持。
- **符号链接 / 硬链接（symlink）。** Lifo VFS 不支持。
- **Firefox / Safari / 移动端。** WebContainers 不支持它们；环境检查错误页说明要求而非降级。
- **精确的 OS 级内存/CPU 统计。** 仅有估算值；始终标 `~` 并加 `(estimated ...)` 脚注。绝不把估算当精确值。

## 质量门禁（完成前必须全部通过）

- `npx tsc -p tsconfig.json --noEmit` → 0 errors
- `node scripts/build-host.mjs` → succeeds
- `npm run build` → succeeds
- `npm run lint` → 0 errors
- `npm run test` → 全部单测通过
- `npm run check:docs` → 无坏本地引用
- `npm run check:plugin-boundaries` → 核心目录无 `cordis` import，且每个
  `src/plugin/` 文件带 invariant 标记
- `npm run check:engine-package` → 构建包、写
  `packages/engine/assets/sha256.json`、校验 exports，并执行
  `npm pack --dry-run`
- `npm run test:e2e` → 完整浏览器流水线（含外部 `examples/cordis-app`
  契约；需要浏览器权限时在沙箱外运行）
- 开发服务器在 `localhost:7892` 启动并带 COOP/COEP 头
- 静态自检：对 `src/` 与 `index.html` 执行禁用的 emoji 字形与 `GREEN` 常量的 `grep` 检查 → 无匹配
