# WebUnix — TASK2：产品化（全屏终端 + 启动画面 + 端口管理 + 数据库）

## 背景

WebUnix 已验证 TerminalExecutor v1（PASS 14/0）：单一 `terminal()` API，`node|npm|npx` → 真 Node 子进程，其余 → Lifo，统一进程表 ps/kill，文件型 RPC（`/cmd.json` → `/result-<id>.json`，**每请求独立结果文件，不要改回单文件**）。
现在把它产品化：从"测试页"变成"打开即用全屏黑色终端的浏览器 Linux"。

## 现状文件

- `src/host.ts` v4.1：协议 run/ps/kill/cwd/ping/exit；文件 RPC 轮询；路由 node|npm|npx→child_process、其余→Lifo sandbox；result-<id>.json；pruneStaleResults 每 60s
- `src/host-procs.ts`：进程表 registerProcess/listProcesses/killProcess
- `src/main.ts`：TerminalClient（文件 RPC 客户端）+ 14 项自动测试（页面自动跑）
- `index.html` / `vite.config.ts`（端口 7892 + COOP/COEP）/ `scripts/build-host.mjs`（esbuild 打包 host，external: @lifo-sh/ui）

## 新需求

### 1. 协议新增 `spawn` 命令（host.ts）

端口管理和数据库都需要"后台长驻进程"。新增：

```
{ cmd: 'spawn', opts: { command: 'node server.js ...' } }
→ 立即返回 { ok, pid, runtime: 'node' }（进程登记进进程表，后台运行）
→ 子进程输出追加到进程表条目（可选：ps 时附带最近输出尾部）
```

- 只支持 node 系（spawn 用于服务器；Lifo 侧没有后台概念，明确返回"不支持"）
- 沿用 runNode 的超时/收集逻辑改造：spawn 不写最终结果文件，只返回 pid；子进程输出持续收集并存入进程表条目（`outputTail` 字段，ps 返回最近 ~500 字符）
- `kill <pid>` 已有，直接能杀 spawn 的进程

### 2. 浏览器端命令拦截（main.ts 或拆出新文件 src/commands.ts）

以下命令在**浏览器侧**处理，不进容器：

- `help` → 打印命令列表（含 WebUnix 专有命令）
- `clear` → xterm 清屏
- `sysinfo` → 重新打印系统信息（浏览器检测）
- `ports` → 打印已检测到的服务端口列表（来自 WebContainer 的 server-ready 事件注册表）
- `db start` / `db status` / `db stop` → tinbase 管理（见下）
- `version` / `whoami` → 简单信息（webunix / guest）
- 其余命令 → 原样发 host（terminal 路由）

### 3. 端口管理（P2）

- 浏览器启动时：`wc.on('server-ready', (port, url) => registry.set(port, url))`，并且终端打印 `[preview] 端口 <port> 就绪 → <url>`（绿色）
- `ports` 命令列出 registry：`端口   URL` 表格
- 进程被杀/容器重载时 registry 自然清空（每次 boot 重建）

### 4. tinbase 数据库（P3）

`db` 命令族（浏览器侧包装）：

- `db start` → 检查容器里 node_modules 是否有 tinbase（`ls node_modules/tinbase`），没有则 `terminal('npm install tinbase --no-audit --no-fund')`（真 Node 路由，可能 30-90 秒，期间打印进度）；然后用 `spawn` 启动 `npx tinbase start --port 3001`（端口选 3001，避免常见冲突）；等 server-ready 事件后打印 `[preview] 数据库 → <url>` 和访问提示
- `db status` → 查看 3001 端口是否在 registry、进程表里有没有 tinbase 进程
- `db stop` → kill tinbase 进程
- **失败必须优雅**：tinbase 在 WC 里如果跑不起来（WASM/网络问题），打印清晰的中文错误和原因（例如 "tinbase 需要 PGlite/WASM 模式，安装或启动失败：<原因>"），绝不能崩掉整个终端

### 5. 前端：全屏黑色终端 + 启动画面（重点）

`index.html` + `src/main.ts` 重构：

- **全屏黑色**：html/body 黑底、无 margin、无滚动条；xterm 填满视口；等宽字体（默认 monospace 即可）；可选深绿/亮绿主题色
- **依赖**：`npm install @xterm/xterm @xterm/addon-fit`（必须）；xterm CSS 引入
- **启动画面**（页面加载即显示，像 Ubuntu/Arch 启动）：
  1. 清屏 → 打印大号 ASCII art "WebUnix"（figlet 风格，比如 "ANSI Shadow" 字体效果，字符画自己做，绿色）
  2. 版本行：`WebUnix 0.1.0 — browser-native Linux`
  3. 系统信息（**浏览器检测，有的写、没有的不写**）：
     - `平台: navigator.userAgentData?.platform ?? navigator.platform`
     - `浏览器: UA 里提取的 Chrome/xxx`
     - `CPU 核数: navigator.hardwareConcurrency`
     - `内存: navigator.deviceMemory GB`（没有就不写）
     - `语言: navigator.language` / `时区: Intl.DateTimeFormat().resolvedOptions().timeZone`
     - 屏幕分辨率（可选，有就写）
  4. 启动日志（systemd 风格，`[  OK  ]` 绿色、`[...]` 灰色）：
     - `[  OK  ] Started WebContainer runtime`
     - `[  OK  ] Mounted shared filesystem`
     - `[  OK  ] Started Lifo kernel`
     - `[  OK  ] TerminalExecutor ready`
     - 每行在真实完成时打印（异步，别一次性全打）
  5. 横幅：`WebUnix 0.1.0 (kernel: JS runtime + WebContainer; userland: Lifo; exec: TerminalExecutor)` + `Type 'help' to see available commands.` + 空行 → 提示符
- **提示符**：`guest@webunix:~$ `（固定即可，不追踪 cwd）
- **终端交互**：输入 → 浏览器侧命令拦截 → 否则发 host；结果 stdout 直接打印，stderr 用 ANSI 红色包裹，exit≠0 时打印 `[exit <code>]`（灰色）；输出前加空行分隔，可读性好
- **输入体验**：回车即执行；Ctrl+L 清屏（xterm 内置或自行处理）；粘贴支持（xterm 默认）
- 页面标题：`WebUnix — browser-native Linux`

### 6. 保留测试（`?test=1`）

默认进入终端；URL 带 `?test=1` 时自动跑测试套件（现有 14 项 + 新增），结果打印到终端：
- T15：spawn 一个后台 http 服务（`node -e "http.createServer((q,s)=>s.end('hello-port')).listen(3456)"`）→ ps 能看到 running → `ports` 里出现 3456 的预览 URL → 浏览器 fetch 该 URL 得到 'hello-port' → kill → 进程表变 exited
- 测试输出格式沿用现有 verdict 风格（✅/❌ + 名称 + 详情）

### 7. README 更新

架构图更新（加 spawn/ports/db）、新命令表、启动画面说明、`?test=1` 说明、已知边界（tinbase 在 WC 的表现按实测记录、交互式 stdin 不支持、CORS）。

## 质量门禁（全部通过再收工）

- `npx tsc -p tsconfig.json --noEmit` 0 错误
- `node scripts/build-host.mjs` 成功
- `npm run build` 成功
- dev server 起得来（localhost:7892，COOP/COEP 头在位）
- 你自己的静态检查：main.ts 别超过 ~400 行（拆文件）、没有 console.log 残留、注释中文、标识符英文

## 约束

- **不要改**：vite.config.ts 端口/COOP-COEP、文件 RPC 通道、result-<id>.json 协议、@lifo-sh/ui external、node|npm|npx 路由规则
- 新依赖只有 @xterm/xterm + @xterm/addon-fit（tinbase 不装到本地 node_modules，运行时在容器里按需 npm install）
- 保持 TypeScript strict；POC 风格但结构清晰（拆 src/boot.ts、src/commands.ts、src/terminal-client.ts 之类）
- 完成后输出总结：改了哪些文件、协议变更、门禁结果、浏览器里需要人工看什么（启动画面效果、db 命令表现）

## 开始

先读 `src/host.ts`、`src/main.ts`、`index.html`、`README.md`、`package.json`，然后实现。
