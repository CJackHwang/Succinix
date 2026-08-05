# WebUnix — TASK3：生产级界面（英文 / 暗橙主题 / 专业自检 / 禁 emoji）

## 背景

TASK2 已交付并验证（PASS 18/1，唯一失败为已知 CORS 边界）。当前状态：
- `index.html`：全屏黑 + `#terminal`（vite 端口 7892，COOP/COEP 头在位）
- `src/main.ts`：xterm 终端 + REPL（绿色主题、中文输出）+ `?test=1` 测试模式
- `src/boot.ts`：启动画面（ASCII WebUnix + 中文系统信息 + systemd 风格 [ OK ] 日志）
- `src/commands.ts`：浏览器侧命令（help/clear/sysinfo/ports/db start|status|stop/version/whoami，中文输出）
- `src/tests.ts`：14+4 项测试（✅/❌ emoji 风格输出）
- `src/terminal-client.ts`：文件 RPC 客户端
- `src/host.ts` v4.1：run/ps/kill/cwd/ping/exit/spawn 协议，node|npm|npx → 真 Node，其余 → Lifo
- `src/host-procs.ts`：进程表

**用户明确要求：面向生产，专业设计，不要玩具感。** 本次任务全部重做界面/文案/主题/测试表现形态。

## 需求

### 1. 全界面英文（硬性）

启动画面、系统信息、help、所有命令输出、错误信息、测试输出、端口/数据库信息——**全部英文**。
代码注释可以保留中文（开发文档），但终端呈现给用户的每一个字符必须是英文。
错误信息要像 Linux 风格（简洁、可操作），例如 `tinbase: failed to start (engine wasm): <reason>`，`command not found: xxx`（Lifo 侧本来就英文，确认即可）。

### 2. 字体：JetBrains Mono（严谨、好看）

- 安装 `@fontsource/jetbrains-mono`（本地打包，不依赖 CDN）
- `main.ts` 引入 `@fontsource/jetbrains-mono/400.css` 和 `700.css`
- xterm fontFamily：`'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

### 3. 主题：低调高级的暗橙色（禁用绿色）

xterm theme 与整体配色改为暗橙系：
- 背景：`#0a0a0a`（纯黑近黑）
- 前景：暖白 `#d6cfc4`（不要纯白刺眼）
- 光标/强调：暗橙 `#c2702a`
- 选择背景：`#3a2a1a`
- ANSI 色板整体调成暖色系暗色调（red → 暗红 #c0543a，yellow → 暗金 #c98a2e，green → 暗橄榄 #7a8a5a 或直接不用绿色做强调，bright 系列对应亮一档）
- 启动画面/自检的 `[  OK  ]` 用暗橙（不是绿色）；`[FAIL]` 用暗红；普通信息用暖白；次要信息用暗灰 `#6b6560`
- 界面所有地方不得出现绿色（当前代码里 GREEN 常量全部替换为 AMBER 暗橙）

### 4. 内置测试 → 行业专业"系统自检"流程

`?test=1` 模式不再是"✅/❌ 测试列表"，而是**专业的系统自检流程**（POST/内核自检风格），英文。参考形态：

```
WebUnix self-test — boot diagnostics
[  OK  ] Filesystem: virtual FS mounted (read-write)
[  OK  ] Filesystem: bidirectional I/O (browser <-> lifo)
[  OK  ] Kernel: Lifo userland loaded (60+ commands)
[  OK  ] Executor: node child process (stdout/stderr/exit propagation)
[  OK  ] Executor: npm resolution (PATH ok, version 10.8.2)
[  OK  ] Executor: lifo routing (grep/cat/wc)
[  OK  ] Process table: spawn/ps/kill lifecycle
[  OK  ] Port registry: server-ready detection
[ FAIL ] Network: direct fetch (CORS — expected boundary, skipped)
...
Self-test result: 18 passed, 1 skipped (known boundary)
```

- 每行 `[  OK  ]` / `[ FAIL ]` + 英文描述 + 关键值（pid/版本/端口）
- 边界项（CORS/symlink）标 `[SKIP]` 或 `[ OK ] (known boundary)`，不算失败
- 自检结束打印汇总行：`Self-test result: N passed, M failed, K skipped`
- **自检跑完自动进入终端**（同默认模式，出现提示符，用户可继续操作）
- 默认模式（无 ?test=1）：启动自检是**精简版**（内核/FS/执行器就绪即可，保持 boot 的 [ OK ] 日志），不要跑完整测试

### 5. 启动后进入系统首页（终端主界面）

自检/启动完成后进入系统主界面：提示符 + 一行欢迎信息（英文、专业、克制）：
```
WebUnix 0.1.0 — kernel: JS runtime + WebContainer | userland: Lifo | exec: TerminalExecutor
Type 'help' to see available commands.
guest@webunix:~$
```
不要显示任何 emoji、不要花哨符号。

### 6. 禁止 emoji（硬性，全前端）

- 界面、文案、输出、测试结果、错误信息——**不得出现任何 emoji 或图形符号**（✅❌🎉🚀🔥 等全禁）
- 状态一律用 ASCII：`[  OK  ]` / `[FAIL]` / `[SKIP]`
- 检查现有代码，把 `✅`/`❌`/`🎉`/`…` 等全部清掉（`…` 是省略号字符，界面里换成 `...`）

### 7. 新建 AGENTS.md（设计规定文件，项目根）

内容包含（英文写规范、中文可作解释）：
- 设计规范：界面全英文；禁止 emoji；暗橙主题（给出色值）；JetBrains Mono；专业克制不玩具；与 Linux 用户习惯对齐（提示符/错误格式/exit code/ps 表格）
- 技术约束：文件 RPC `/cmd.json` → `/result-<id>.json` 不许改回单文件；`node|npm|npx` → 真 Node、其余 → Lifo 的路由不许改；vite 端口 7892 + COOP/COEP 头不许改；tinbase 必须 `--engine wasm`（无 `--memory`，数据落工作区快照持久）；db 安装超时必须 host 侧 `{timeout:120000}`
- 质量门禁：`npx tsc -p tsconfig.json --noEmit` 0 错误；`node scripts/build-host.mjs`；`npm run build`；dev server 可起

### 8. Linux 对齐的小设计

- 提示符：`guest@webunix:~$ `（保持）
- 命令错误：`bash: xxx: command not found` 风格的英文提示（Lifo 侧已有则确认，浏览器侧拦截的命令如 `foo` 未知命令 → 原样发 host，由 host 报错，不要浏览器自己编错误）
- exit code 标注：`[exit 1]` 灰色（已有，改英文/灰色系）
- ps 表格：`PID  STATUS  COMMAND`（英文表头）
- 未知协议命令：host 返回英文 `unknown command: xxx`

## 保留项（不许改）

- `vite.config.ts`（端口 7892、COOP/COEP）
- 文件 RPC 通道（`/cmd.json` → `/result-<id>.json`，每请求独立结果文件）
- host 路由规则（node|npm|npx → child_process；其余 → Lifo sandbox）
- `spawn` 协议、进程表、`kill`
- `db start` 的 `--engine wasm`（无 `--memory`）和安装超时 `{ timeout: 120000 }, 150000`
- `scripts/build-host.mjs`（@lifo-sh/ui external）
- 测试逻辑本身（断言不变，只改输出表现形态为自检风格）

## 质量门禁（全部通过再收工）

- `npx tsc -p tsconfig.json --noEmit` 0 错误
- `node scripts/build-host.mjs` 成功
- `npm run build` 成功
- dev server 起得来（localhost:7892，COOP/COEP 头在位）
- 静态自查：代码里无 emoji 字符、界面文案全英文、无 GREEN 常量残留（用 AMBER）
- 用 grep 自查：`grep -n '✅\|❌\|🎉\|GREEN' src/ index.html` 应无结果（GREEN 常量名本身可以改成 AMBER 后无残留）

## 约束

- 新依赖只允许 `@fontsource/jetbrains-mono`
- TypeScript strict 保持；结构沿用现有拆分（boot/commands/terminal-client/tests），需要可再拆
- 注释中文、标识符英文（沿用）
- 完成后输出总结：改了哪些文件、每处改了什么、门禁结果、浏览器里需要人工看什么（启动画面视觉效果、自检流程、主题观感）

## 开始

先读 `src/main.ts`、`src/boot.ts`、`src/commands.ts`、`src/tests.ts`、`index.html`、`AGENTS.md`（若已存在），然后实现。
