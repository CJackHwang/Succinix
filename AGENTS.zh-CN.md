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

## 明确未实现（不要硬造）

浏览器环境限制照单全收。不构建无真实价值的模拟；某项能力确实无法工作时，省略或明确降级：

- **多用户 / 登录 / 权限隔离（multi-user）。** 组织性隔离（嵌入模式可用）：目录·状态·进程视图按实例/用户分割（`?instance=<id>` / `?user=<id>`）；**非安全边界** —— 无真内核/权限位。没有真实隔离的登录仪式仍无价值；独立应用 `guest` 仍为唯一用户；权限位 / `chmod` 语义仍不做。
- **权限位管理（`chmod` 语义）。** 模拟模式无实际价值；不伪造。
- **真实内核 / apt / 原生二进制。** 沙箱内物理不可行。Succinix 是浏览器原生 Linux（JS 运行时 + Lifo 用户态）。
- **入站外部网络（inbound networking）。** 端口是虚拟 preview；隧道是出站桥接，不是真实入站。
- **无 CORS 的直接外部 `curl`。** 请用 `https://r.jina.ai/<url>` 风格代理。
- **交互式 stdin（REPL 风格进程）。** WebContainer 中不可靠（已实测）；以文件 RPC 替代。
- **符号链接 / 硬链接（symlink）。** Lifo VFS 不支持。
- **Firefox / Safari / 移动端。** WebContainers 不支持它们；环境检查错误页说明要求而非降级。
- **精确的 OS 级内存/CPU 统计。** 仅有估算值；始终标 `~` 并加 `(estimated ...)` 脚注。绝不把估算当精确值。

## 质量门禁（完成前必须全部通过）

- `npx tsc -p tsconfig.json --noEmit` → 0 errors
- `node scripts/build-host.mjs` → succeeds
- `npm run build` → succeeds
- 开发服务器在 `localhost:7892` 启动并带 COOP/COEP 头
- 静态自检：对 `src/` 与 `index.html` 执行禁用的 emoji 字形与 `GREEN` 常量的 `grep` 检查 → 无匹配
