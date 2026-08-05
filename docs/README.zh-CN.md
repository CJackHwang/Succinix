# Succinix

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-black.svg)](../package.json)
[![CI](https://github.com/CJackHwang/Succinix/actions/workflows/ci.yml/badge.svg)](https://github.com/CJackHwang/Succinix/actions/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../CONTRIBUTING.md)

> 语言：[English](../README.md) | **简体中文**

**一个浏览器原生的 Linux：由 WebContainer + Lifo 驱动的全屏 Unix 终端，通过统一的 TerminalExecutor 把 `node|npm|npx` 路由到真实 Node.js 运行时，其余命令路由到 Lifo Unix 用户态——两者共享同一个文件系统。**

打开一个浏览器标签页，启动进入类 Linux 环境，无需安装任何东西即可使用 Unix 工具、Node.js、进程管理、端口转发和 Postgres 数据库（tinbase）。

---

## 特性

- **全屏终端体验** — 居中的 DOM 启动画面（boot splash）带系统自检与环境不适配优雅退出（显示专业错误页而非降级），随后进入交互式 Shell（`guest@succinix:~$`）。
- **统一命令执行** — 单一终端入口：
  - `node`、`npm`、`npx` 及项目二进制运行在**真实 Node.js 进程**上（WebContainer）。
  - `python` / `python3` 运行在**内置 python-wasm 运行时**（Python 3.11）——作为系统资产打包（零安装、用户 `npm install` 无法装坏），首用懒注入。支持 `python -c "<code>"` 与 `python <script.py>`；交互式 REPL 不支持（WebContainer stdin 边界）。
  - 其余一切（`grep`、`sed`、`awk`、`cat`、`tar`、`curl`、管道、重定向……）运行在 **Lifo**——一个 TypeScript 实现的 Unix 用户态。
- **会话工作目录（融合基石）** — Lifo 里的 `cd` 现在驱动 host 维护的**会话 cwd**（持久化到 `/etc/succinix.cwd`，刷新恢复），并应用到每个真实 Node/Python 子进程（`spawn cwd`）。`pwd` 显示会话 cwd，`node`/`python` 看到同一目录——不再有 `cd /ws/proj && npm install` 装到容器根的问题。`cd` 到不存在目录时会话 cwd 不变。`lang` 列出内置运行时与版本。（TASK24：`/workspace` 是 Lifo 挂载视图，真实容器 FS 没有该路径；node/python 子进程实际 spawn 在映射后的 host 真实目录，子进程里 `process.cwd()` 报真实路径如 `/home/<wc-id>/proj`，`pwd`/`cwd` 仍显示 Lifo 视角 `/workspace/...`。）
- **共享文件系统** — 浏览器（`wc.fs`）与 Lifo 命令操作的是**同一份文件**。无需桥接代码：WebContainer 为进程虚拟化 `node:fs`，Lifo 通过 `NativeFsProvider` 消费它。
- **进程管理** — 统一进程表上的 `ps` / `kill`（真实子进程 + 状态跟踪），含后台 `spawn`。
- **端口管理** — 通过 WebContainer `server-ready` 事件探测服务，`ports` 列出端口与预览 URL。
- **数据库** — `db start` 在容器内启动真实 Postgres（tinbase，PGlite/WASM 引擎）；`db status` / `db stop` 管理它。
- **持久化** — 工作区（文件、配置、env、settings、工作区）快照到 IndexedDB，boot 时恢复；刷新永不丢用户文件。`snapshot` 命令查看状态 / 手动保存 / 重置。快照以文本为主：二进制/不可读文件跳过（在保存日志中计数报告）；收集大小超过 ~50 MB 的快照跳过并告警而非写入（`snapshot now` 报告 `skipped (over 50MB limit)`）。tinbase 数据库存储（`.tinbase`，PGlite/WASM）整体排除——它是二进制的，纯文本的部分恢复会损坏它；因此 tinbase 数据在会话内跨 `db stop`/`db start` 持久，但**不**跨浏览器刷新（刷新重建全新 store）。
- **内存管理** — `free` / `top` 提供内存概览（设备 + JS heap；沙箱估算诚实标注），`reboot` 以浏览器重载重启系统（持久化数据存活），`shutdown` 关机，`cache` / `cache clear` 报告与清理可重建缓存（绝不触碰 `/workspace`）。
- **工作区分拆** — `workspace` 管理多个隔离工作区：每个工作区在独立 `/ws/<name>` 目录，各有文件与状态；`create` / `switch` / `rm` 管理它们，当前工作区记录在 `/ws/.current`（跨刷新持久）。首次 boot 初始化默认 `main` 工作区。
- **系统配置** — `env` 管理持久环境变量（`/etc/succinix.env`，spawn 时合并进真实 Node 子进程）与 `settings` 管理持久系统设置（`/etc/succinix.settings`）：tinbase 端口（`preview-port`，默认 3001）、初始工作区（`default-workspace`，默认 `main`）、终端字号（`font-size`，实时生效）。两个文件随快照跨刷新持久。
- **服务管理** — `service` 在 `spawn`/`ps`/`kill` 与端口注册表之上声明式管理具名后台服务：定义在 `/etc/succinix.services`（`name|command|port`，`#` 注释，`${PORT}` 占位符从 `preview-port` 解析），`start`/`stop`/`status`/`enable`/`disable`。`enable` 记录服务到 `/etc/succinix.autostart`，boot 时声明式拉起——是声明式重启，不是守护进程（无崩溃自愈）。
- **系统日志（journald 风格）** — 持久日志写入容器 FS 的 `/var/log/succinix.log`（随快照跨刷新持久），格式 `2026-08-05T04:00:00Z [level] message`。采集 boot 事件（`BOOT`）、命令执行（`INFO` 含 `cmd`/`exit`/`runtime`）、服务事件（`INFO`/`WARN`）、快照事件（`INFO`）与错误（`ERROR`）。`log` 读取（`log` 最近 20 行、`log -n <count>` 最近 N 行、`log boot` 仅 BOOT、`log clear` 清空）；文件超 ~200 KB 自动截断保留尾部。交互式 `log -f`（tail -f）有意不实现（POC）。
- **包管理** — `pkg` 用 apt 风格接口统一两条真实包通道：**lifo**（`lifo list` / `lifo install` / `lifo remove` / `lifo search`——Lifo 扩展包如 `lifo-pkg-git`、`lifo-pkg-ffmpeg`）与 **npm**（真实 Node npm，全生态）。来源自动判定：`lifo-pkg-<name>` 在 npm 存在的包走 lifo 安装，否则走 npm；同名冲突 lifo 优先（工具包）。`pkg list` 合并两通道并带 `SOURCE` 列，`pkg search` 合并两个搜索，`pkg install`/`remove` 回显真实命令输出且绝不吞错。npm 已装列表只读 `node_modules` **顶层目录**（"顶层直装"简化——容器预装运行时依赖也会出现，不解析依赖树）。
- **虚拟网络视图** — `netstat` 把端口注册表渲染为虚拟监听端口表（`Proto  Local Address  State`，`tcp 127.0.0.1:<port> LISTEN`；`netstat -p` 附加关联进程，按进程命令中的端口号匹配，无匹配显示 `-`），`ip addr` 显示浏览器虚拟网络身份（`lo: virtual loopback`、`eth0: <preview-domain> (virtual)`）。一切诚实标注 `virtual`——不编造接口、IP 或连接。
- **系统信息与登录横幅** — `uname` 报告诚实的浏览器原生系统身份（`Succinix 0.2.0 js-runtime+webcontainer <api-version> <arch>`；内核标识 `js-runtime+webcontainer`，绝不冒充 Linux 内核；`-a` 追加主机名/OS，`-r` 是 `@webcontainer/api` 运行时版本，`-m` 是从 UA 提取的架构），`motd` 显示/编辑 `/etc/succinix.motd` 登录横幅（随快照持久；默认欢迎行每次 boot 打印，`motd reset` 恢复）。
- **自检模式** — `?test=1` 在浏览器中运行系统诊断自检。

## 架构

```
┌─────────────────────────── 浏览器标签页 ───────────────────────────┐
│  xterm.js（JetBrains Mono，暗橙主题）                              │
│    │  terminal(command)                                           │
│    ▼                                                              │
│  TerminalClient — 基于共享文件系统的文件 RPC                       │
│    /cmd.json  { id, cmd, opts }                                   │
│    /result-<id>.json  { id, ok, exitCode, stdout, stderr, runtime }│
└───────────────┬───────────────────────────────────────────────────┘
                │  WebContainer（COOP/COEP，虚拟化 node:fs）
┌───────────────▼───────────────────────────────────────────────────┐
│  node host.js — TerminalExecutor（常驻守护进程，PID 1）            │
│    ├─ node|npm|npx ...  → child_process.spawn  （真实 Node.js）    │
│    ├─ python|python3 ...→ node python-runtime.js（python-wasm）    │
│    ├─ 其余一切           → Lifo sandbox.commands.run（Unix 工具）  │
│    ├─ ps / kill         → 统一进程注册表                          │
│    ├─ cwd / setCwd      → 会话 cwd（cd 同步、持久化）             │
│    └─ spawn             → 后台长驻进程                            │
└───────────────────────────────────────────────────────────────────┘
```

关键设计决策：**文件系统是唯一事实源。** 因为 WebContainer 通过 `node:fs` 把容器文件系统暴露给进程，而 Lifo 通过 `NativeFsProvider` 挂载 `process.cwd()`，浏览器、Node 进程与 Lifo 看到的是同一个文件系统。没有需要维护的文件系统桥。

## 快速开始

要求：现代 Chromium 系浏览器（Chrome/Edge）+ 跨源隔离（COOP/COEP 头）+ `SharedArrayBuffer` 支持。本地开发无需任何服务端基础设施。

```bash
npm install          # 安装依赖
npm run dev          # 启动 Vite dev server（COOP/COEP 头已预配置）
# 打开 http://localhost:7892
```

页面启动 Succinix：系统自检，然后进入 Shell 提示符。输入 `help` 查看可用命令。

### 构建与检查

```bash
npx tsc -p tsconfig.json --noEmit   # 类型检查（要求 0 错误）
node scripts/build-host.mjs         # 打包容器内 host（host.js）
npm run build                       # 生产构建
node scripts/verify-deploy.mjs      # 部署就绪门禁（build + preview + COOP/COEP + ?test=1）
```

### 测试

Succinix 有分层测试体系，本地与 CI（GitHub Actions）一致。测试未引入任何新运行时依赖——e2e 复用现有 CDP 脚本（`verify-deploy` / `bench` / `scenarios`），单测用 mock 文件系统 / IndexedDB / 网络。

- **Lint** — `npm run lint`（`eslint.config.js` flat config）。`typescript-eslint` recommended + 项目规则：禁 `any`（error）、无遗留 `console.log`（warn；`console.warn`/`error` 按降级日志约定允许，host 侧文件豁免）、无未用变量/导入。门禁：**0 error**。
- **Typecheck** — `npm run typecheck`（`tsc -p tsconfig.json --noEmit`）。门禁：**0 error**。
- **单测** — `npm run test`（Vitest，node 环境）覆盖纯逻辑模块 `src/log.ts`、`src/persist.ts`、`src/services.ts`、`src/pkg.ts`、`src/motd.ts`、`src/config.ts`（内存 mock，见 `tests/`）。`npm run test:coverage` 追加 v8 覆盖率门禁：核心文件 **≥70%** statements/branches/functions/lines。
- **e2e** — `npm run test:e2e` 构建一次，然后在 headless Chrome 里对 `vite preview` 依次跑 CDP 脚本：
  1. `scripts/verify-deploy.mjs` — 部署就绪门禁 + `?test=1` 自检（门禁 **≥71 passed, 0 failed**）；
  2. `scripts/bench.mjs` — 性能基准（JSON 输出）；
  3. `scripts/scenarios.mjs` — 十四场景真实工作流套件（S1–S14）；
  4. `scripts/lang-verify.mjs` — 语言生态验证套件（TASK25）。
  有意不用 Playwright：CDP 脚本让流水线保持零依赖、与本地运行一致。
- **CI** — `.github/workflows/ci.yml` 每次 push/PR 跑 lint → typecheck → 单测（含覆盖率）→ build → `verify-deploy`（headless 自检）；定时 nightly job 跑重场景套件。见本文件顶部 CI 徽章。
- **pre-commit（可选，零依赖）** — `npm run setup:hooks` 写入 `.git/hooks/pre-commit`，对变更文件跑 `tsc --noEmit` 与 ESLint（`scripts/pre-commit.sh`）。**不强制**：跳过 `setup:hooks` 项目照常可提交。

### 依赖与审计

依赖策略：**只报告，不自动升级**（升级单独评估以避免回归）。TASK17 最终轮审计结果（2026-08-05）：

- `npm audit` → **0 漏洞**（全部直接/传递依赖干净）。
- `npm outdated` → 仅 **`@lifo-sh/core` 0.10.8 → 0.10.9** 有新版本；其余全部最新。不升级（策略），待单独评估。
- `public/host.js` 经 esbuild 压缩（`scripts/build-host.mjs` 中 `minify: true`）；体积从 1,965,361 B 降到 1,070,913 B（**-45.5%**）。`keepNames: true` 变体 1,106,353 B（**-43.7%**）；采用纯 `minify`，因为完整 `?test=1` 套件对压缩产物通过（Lifo 无依赖 `Function.name` 的会被名称压缩破坏的地方）。

### 自检模式

```bash
# 打开 http://localhost:7892/?test=1
```

在居中的启动画面覆盖层里跑完整诊断套件（文件系统、路由、进程生命周期、端口、配置、服务、日志、包、冒烟），随后把汇总打印进终端并进入 Shell。

### 部署（Vercel）

Succinix 是**纯静态站**（Vite → `dist/`）：无后端、无服务端状态——工作区、文件、配置与设置存在浏览器 IndexedDB 并随快照（tinbase 数据库存储排除；见持久化）。任何能发送自定义响应头的静态托管都可部署；一键路径是 Vercel。

**为什么 COOP/COEP 关键。** WebContainer 要求跨源隔离。没有 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: credentialless` 头，页面环境检查失败并显示错误页而非终端。`vercel.json` 为**每个**路径（含 `assets/*` 与 `host.js`）下发这些头，与 dev/preview server 一致。漏掉它们是部署时"白屏 + 环境错误页"的头号原因。

**一键部署（Vercel）：**

1. 把仓库推到 GitHub / GitLab / Bitbucket。
2. Vercel dashboard 里 **Import Project** → 选仓库。Vercel 自动识别 Vite（`vercel.json` 里的 `framework: vite`、`buildCommand: npm run build`、`outputDirectory: dist`）。
3. 部署。可选添加自定义域名，如 `succinix.alibicore.com` 或 `cjack.me` 子域。

CLI 等价操作（需要 Vercel 账号/token）：

```bash
npm i -g vercel
vercel login
vercel --prod
```

**本地部署就绪验证**（无需 Vercel token）。`vite preview` 以与 Vercel 相同的方式服务构建好的 `dist/`，所以这就是"静态产物可部署"的证明：

```bash
npm run build
node scripts/verify-deploy.mjs
# 启动 vite preview，断言 /、/host.js 与 JS bundle 的 COOP/COEP，
# 再在 headless Chrome 里跑 ?test=1 —— PASSED 要求 >=57 passed 且 0 failed
```

**数据分域。** IndexedDB 按 **origin** 隔离。更换部署域名 = 启动全新系统：工作区、文件与数据库数据**不**跨域迁移。同域刷新安全（快照恢复）；只有换域会重置系统。这也适用于 Vercel preview 部署：每个 preview 有独立 URL（不同 origin），每个 preview 环境有各自分域的 IndexedDB——preview 部署之间数据也不互通。

## 用法

### 内置命令（浏览器侧处理）

| 命令 | 说明 |
| ---- | ---- |
| `help` | 显示命令帮助 |
| `clear` | 清屏（`Ctrl+L` 也可） |
| `sysinfo` | 显示浏览器检测的系统信息 |
| `ports` | 列出就绪服务端口与预览 URL |
| `db start` | 启动 tinbase 数据库（缺失时自动安装） |
| `db status` | 显示数据库状态（端口注册表 + 进程表） |
| `db stop` | 停止数据库 |
| `version` | 显示版本 |
| `whoami` | 显示当前用户（`guest`） |
| `snapshot` | 持久化状态；`snapshot now` 保存、`snapshot clear --yes` 重置 |
| `free` | 显示内存概览（设备 + JS heap；沙箱估算标 `~`） |
| `top` | 实时进程表——间隔 2s 共 3 次快照后退出 |
| `reboot` | 重启 Succinix（浏览器重载；持久化数据存活） |
| `shutdown` | 关机（可关闭本标签页） |
| `cache` | 显示缓存占用；`cache clear` 清理可重建缓存 |
| `workspace` | 列出工作区；`create` / `switch` / `rm` 管理隔离工作区 |
| `env` | 列出 / 设置（`env KEY=value`）/ 删除（`env -u KEY`）环境变量，持久于 `/etc/succinix.env` |
| `settings` | 查看 / 设置 / 重置（`settings reset KEY`）系统设置，持久于 `/etc/succinix.settings` |
| `service` | 列出服务（状态 + 端口）；`start` / `stop` / `status` / `enable` / `disable <name>` 管理。定义在 `/etc/succinix.services`，boot 自启在 `/etc/succinix.autostart`（声明式重启，非守护进程） |
| `log` | 显示 `/var/log/succinix.log` 最近系统日志（20 行）；`log -n <count>` 最近 N 行、`log boot` 仅 BOOT、`log clear` 清空 |
| `pkg` | 包管理：`pkg list`（lifo + npm 合并带 `SOURCE`）、`pkg search <term>`（双通道）、`pkg install <name>`（`lifo-pkg-<name>` 存在走 lifo，否则 npm）、`pkg remove <name>`（按安装来源）、`pkg info <name>` |
| `netstat` | 列出虚拟监听端口（端口注册表为 `tcp 127.0.0.1:<port> LISTEN`）；`netstat -p` 附加关联进程（按进程命令中的端口号匹配，无匹配 `-`） |
| `ip addr` | 显示虚拟网络身份——`lo: virtual loopback`、`eth0: <preview-domain> (virtual)`；不编造接口或 IP |
| `uname` | 显示系统身份：汇总行（`Succinix <version> js-runtime+webcontainer <api-version> <arch>`）；`uname -a` 全字段、`-r` 运行时版本、`-m` 架构（UA 提取，缺失 `unknown`） |
| `motd` | 查看登录横幅（`/etc/succinix.motd`）；`motd <text>` 设置（持久）、`motd reset` 恢复默认 |

### Host 命令（TerminalExecutor，统一路由）

| 命令 | 路由 | 说明 |
| ---- | ---- | ---- |
| `node ...` / `npm ...` / `npx ...` | Node | 真实 Node.js 子进程；命令含 **shell 元字符**（`&&`、`\|`、`>`、`2>&1`……）时整条链经 **Lifo shell** 执行（管道/链/重定向由 shell 层解析，各 node/npm/npx 段再转回真二进制），结果 `runtime=lifo` |
| `grep`、`cat`、`tar`、`curl`、…… | Lifo | Unix 工具、管道、重定向 |
| `ps` | — | 列出统一进程表 |
| `kill <pid>` | — | 终止进程（SIGTERM） |
| `cwd` / `ping` / `exit` | — | 协议命令 |

## 已验证行为

浏览器运行时验证套件结果（见 `src/tests.ts`）：**75 passed, 0 failed, 5 skipped**（TASK25 轮，2026-08-05，针对压缩 host bundle；TASK24 → TASK25 新增语言生态检查：扩展标准库 import、共享 FS 读写、`python -m pip` 明确报错、`npm i -g` EACCES hint）。5 个 skip 是已知边界（外部网络、symlink 回退、设备内存统计），绝非静默失败。`?test=1` 模式下汇总行与失败列表（若有）在 boot 覆盖层淡出后额外打印到终端（自检结果保持可见）。

- 共享文件系统：浏览器 → Lifo 与 Lifo → 浏览器读写均工作。
- 路由：`node -e "console.log(21*2)"` → `42`（`runtime=node`）；`npm --version` → 真实 npm 版本；`grep`/`cat`/`wc` → `runtime=lifo`。
- Shell 融合（TASK24）：node 系命令含 shell 元字符时回退 Lifo shell —— `node -e "console.log(21*2)" | grep 42` → `42`（`runtime=lifo`），`node --version && npm --version` → 两行真实版本；链内各 node/npm/npx 段转回真二进制（非浏览器内 JS 解释器）。`node -e` 转义引号保真（`node -e "console.log(\"hi\")"` → `hi`）；未闭合引号报 `unterminated quote in command` 而非静默截断。
- 进程生命周期：`spawn` 后台服务 → `ps` 可见 → `kill` 转 `exited`。
- 端口注册表：`server-ready` 事件暴露预览 URL。
- 数据库：tinbase（PGlite/WASM）启动并服务。
- 内存：浏览器报告的设备内存 / JS heap 统计（`free` 可渲染）。
- 配置：`env` 设置/获取/删除生命周期与 `settings` 写/重置持久到 `/etc/succinix.*`。
- 服务：`service` 列出内置 tinbase 定义；临时 echo server 可启动、观察 `running`（进程表 + 端口注册表）、停止、零残留删除；`service enable`/`disable` 写入与移除 `/etc/succinix.autostart` 文件（去重）。
- 日志：命令执行记录含 `exit`/`runtime`，boot 事件记录为 `BOOT` 条目，`log clear` 清空日志文件（自检断言）。
- 包：`pkg list` 渲染双通道表（NAME / SOURCE / VERSION）；`pkg search git` 命中 `lifo-pkg-git`（依赖网络——失败按已知边界约定跳过）。
- 网络视图：`netstat` 把端口注册表渲染为虚拟监听端口表，`netstat -p` 关联 spawn 的 echo server（端口 3456）与进程；`kill` 后端口从表消失。`ip addr` 打印虚拟回环与预览域，诚实标注 `(virtual)`。
- 系统信息：`uname` 渲染诚实的系统行（`Succinix <version> js-runtime+webcontainer <api-version> <arch>`）与 `-a`/`-r`/`-m` 形态；`-r`/`-m` 参数解析额外经命令分发路径断言（不只 builder）。`motd` 设置 → 读回 → 重置使 `/etc/succinix.motd` 回到默认（零残留）。
- 冒烟：全部 23 个安全内置命令（help/clear/sysinfo/version/whoami/ports/db status/db stop/snapshot/free/top/cache/workspace/env/settings/service/log/pkg/netstat/ip addr/uname -a/motd/shutdown）经浏览器处理器分发无错误；`reboot` 与 `db start` 排除在自动化冒烟外（破坏性/重副作用）。
- 语言生态（TASK23 + TASK25）：`python -c "print(6*7)"` → `42`（内置 python-wasm）；完整标准库 import 矩阵（json/csv/re/math/os/sqlite3/subprocess/collections/datetime/hashlib/urllib）全绿且扩展标准库进入自检；`python3 --version` 报 Python 3.11；python 读写共享 FS（浏览器 + node 读到同一文件）；`python -m pip` 明确报错（`pip is not available in this embedded runtime`）。权威、以实测为准的矩阵见 **[docs/LANGUAGES.zh-CN.md](LANGUAGES.zh-CN.md)**（英文 **[docs/LANGUAGES.md](LANGUAGES.md)**）。
- 语言防回归（TASK25，场景 S14）：用户实测 5 坑逐条锁定 —— `node --version && npm --version` 链、`node -e` 嵌套引号写文件（穿透 tsc）、`npm i -g` EACCES + hint、cd 同步装包（进项目目录非根 node_modules）、python 真管道。
- 稳定性：RPC 客户端在单槽 `/cmd.json` 通道上串行化请求（无并行通道竞态），只读命令（ping/ps/cwd）传输失败重试一次，浏览器看门狗连续 2 次 ping 失败后重注入 + 重拉 `host.js`。

## 语言

Succinix 内置两个**语言运行时**（系统资产、零用户安装），并可执行预编译 WASI 模块；下列每项
都以 `scripts/lang-verify.mjs`（真实浏览器执行）**实测为准** —— 权威矩阵见
**[docs/LANGUAGES.zh-CN.md](LANGUAGES.zh-CN.md)**（英文 **[docs/LANGUAGES.md](LANGUAGES.md)**）。

| 语言 | 命令 | 状态 | 关键实测事实 |
| ---- | ---- | ---- | ----------- |
| **Python** | `python` / `python3` | ✅ 内置 | 3.11.1 python-wasm；11/11 标准库 import；sqlite3/json 真实可用；**无 pip**（明确报错）、无 REPL、subprocess 可导入但无法 spawn |
| **Node.js** | `node` | ✅ 内置 | 22.22.3；真实二进制；`node -e` 引号保真；完整 TS 工具链（typescript/tsx/vitest） |
| **npm** | `npm` | ✅ 内置 | 10.8.2；本地装进会话 cwd；全局 → EACCES + hint |
| **TypeScript** | `npx tsc` / `tsx` | ✅ 经 npm | tsc → node → vitest 全闭环（S13/S14） |
| **Ruby** | — | ⚠️ 仅探测 | `@ruby/wasm-wasi` v2 容器内可跑（`6*7` → 42）；未集成 |
| **C / Rust / Go** | — | ❌ 缺失 | 无编译器（`which gcc/rustc/go` → not found） |
| **WASI** | `node:wasi` | ✅ | 预编译 WASI 模块可经 `node:wasi` 运行 |

## 已知边界

这些是环境约束，不是 bug：

- **CORS**：对无 CORS 头的网站 `curl` 失败（`exit 7`）。用 CORS 友好代理，如 `curl https://r.jina.ai/<url>`。
- **Symlink**：Lifo VFS 不支持（`ln` 报告限制）。
- **无包管理器 / 原生二进制**：没有 `apt`；原生可执行文件无法运行。这层预留给未来 v86 后端。
- **交互进程的 stdin**：WebContainer 环境不可靠；设计改用基于文件的 RPC。
- **跨运行时流式管道**：跨运行时管道是缓冲的（对 agent 式"跑完再读"工作流足够）。
- **`/workspace` 是 Lifo VFS 视图；真实 node/python 子进程看到真实路径**：浏览器文件系统根（`wc.fs` `/`）与 Lifo 的 `/workspace` 都映射到 host 进程 cwd（`/home/<wc-id>`），而容器根 `/` 是只读系统视图。`pwd`/`cwd` 报 Lifo 视角（`/workspace/...`），node/python 子进程里的 `process.cwd()` 报真实映射路径（`/home/<wc-id>/...`）——指向同一目录。
- **`npm i -g` 到只读 `/usr/local` 会追加可操作提示**：`hint: /usr/local is read-only for guest. Install locally: npm i <pkg>  (or set a user prefix: npm config set prefix ~/.npm-global)`（权限语义不变）。
- **Python REPL 未实现**：内置 python 运行时面向命令（`python -c "<code>"`、`python <script.py>`）。交互式 `>>>` REPL 需要持久 stdin，WebContainer 不可靠 —— 请用 `python -c`。`pip` 也不可用（python-wasm 以 zip 打包标准库；装第三方 wheel 超出范围）。TASK25 起 `python -m pip ...` 明确报 `pip is not available in this embedded runtime`（此前 `-m` 被误当脚本文件），`python -m <module>` 被显式拒绝；`subprocess` 可导入但无法 spawn——WASI 沙箱无进程/管道 API（见 [docs/LANGUAGES.zh-CN.md](LANGUAGES.zh-CN.md)）。
- **首次 `python` 命令慢**：python-wasm 运行时（~13 MB JS + wasm + stdlib）首用懒注入容器，首个 `python` 命令需数秒；后续命令快。它是系统资产、不依赖用户 `npm install`，不会被用户操作装坏。
- **看门狗探针可能被排队命令吞掉**：host 存活看门狗向单槽 `/cmd.json` 通道写直接 `ping` 探针；若用户命令在 ~120 ms host 轮询窗口内入队会覆盖探针，该探针超时、看门狗跳过该轮（中性，不算失败）。这只是在罕见重叠时把存活检测推迟一个 30s 周期；不会误杀健康 host。
- **单命令输出上限 1 MB**：为约束容器内存与结果文件大小，每条命令 `stdout`/`stderr` 最多保留最后 ~1 MB（大输出截断到尾部）。正常使用（`seq 1 5000`、中等文件 `cat`、`npm install` 日志）远低于上限。
- **声明式自启（非守护进程）**：`service enable` 只记录服务供 boot 重启。无崩溃检测或自愈——服务 boot 后退出请手动重启（`service start <name>`）。
- **`log -f`（tail -f）未实现**：交互式流式输出延后（POC；WebContainer 中交互 stdin 不可靠）。用 `log` / `log -n <count>`。`log clear` 清空 `/var/log/succinix.log` 因此自身不记录进日志。
- **外部入站网络**：服务经虚拟预览 URL 可达，公网不可达。
- **服务按命令串认领进程**：`service stop`（与 `db stop`）按渲染命令匹配进程表定位服务，而非 PID 血缘。手动启动的同命令进程可能被匹配并终止。`service start` 同理，找到同命令进程即报 "already running"。
- **内置 tinbase 服务需一次安装步骤**：预置 `service` 定义（`tinbase`）跑 `npx tinbase start --port ${PORT} --engine wasm`，要求容器内已装 tinbase。先跑一次 `db start` 完成容器内安装，再 `service start tinbase`。
- **lifo 包会话级；npm 包持久**：`lifo install` 把包放进 Lifo 运行时的内存全局模块目录，因此只存在于当前 host 会话，host 重启重建（完整刷新启动全新 Lifo 内核）。npm 包装进共享文件系统的 `/node_modules` 并随工作区快照持久。`pkg list` 合并两者；来源规则"`lifo-pkg-<name>` 在 npm 存在走 lifo，否则 npm；同名冲突 lifo 优先"。
- **`pkg` 安装需要 registry 访问**：`pkg install`/`search`/`info` 访问 npm registry（经 `lifo search` / 真实 npm）。registry 不可达时命令报告原因，不假装成功。
- **单用户、无权限位**：Succinix 是单用户浏览器沙箱（`guest` 是唯一用户）；无多用户登录/隔离，权限位管理（`chmod` 语义）不模拟——模拟模式无真实价值。
- **仅 Chromium**：WebContainers 要求 Chromium 系浏览器（Chrome/Edge）。Firefox、Safari 与移动浏览器不支持；环境检查错误页说明要求而非降级。
- **部署宿主必须能发自定义响应头**：WebContainer 的跨源隔离要求 `vercel.json` 里配置的 COOP/COEP 头。不能设置自定义响应头的托管（如某些对象存储/CDN 静态托管）无法运行 Succinix。Vercel 免费版经 `vercel.json` 支持自定义头。

## 项目结构

```
src/
  main.ts            # 入口：xterm 终端、REPL、boot 编排
  boot.ts            # 启动序列、系统信息检测、环境预检
  boot-ui.ts         # 居中 DOM 启动覆盖层渲染器（splash/日志/环境失败页）
  commands.ts        # 浏览器侧命令（help/ports/db/free/top/cache/workspace/env/settings/service/log/pkg/netstat/ip/...）
  config.ts          # 系统配置：/etc/succinix.env + /etc/succinix.settings 读写与默认值
  motd.ts            # 登录横幅：/etc/succinix.motd 读写与默认
  services.ts        # 服务管理：/etc/succinix.services + /etc/succinix.autostart 读写、状态/启动/停止
  log.ts             # journald 风格系统日志：/var/log/succinix.log 追加/读取/清空/BOOT 过滤
  pkg.ts             # 包管理：pkg list/search/install/remove/info（lifo + npm 双通道）
  tests.ts           # 自检套件（?test=1）
  engine/            # TerminalExecutor 引擎——已解耦、可复用（见生态）
    index.ts         # 公开 API：createTerminalExecutor / bootEngineHost / waitForHostReady + 类型
    client.ts        # 文件 RPC 客户端，TerminalClient（原 terminal-client.ts）
    host.ts          # TerminalExecutor 守护进程，运行于 WebContainer 内（原 host.ts）
    host-procs.ts    # 统一进程注册表（原 host-procs.ts）
    lifo-core.ts     # 懒加载 @lifo-sh/core 内核入口（打包为 public/lifo-core.js）
scripts/
  build-host.mjs     # esbuild 打包容器内 host（host.js + 懒加载 lifo-core.js）
  verify-deploy.mjs  # 部署就绪门禁：build + preview + COOP/COEP + ?test=1 自检
  bench.mjs          # headless Chrome 性能基准（JSON 输出）
  scenarios.mjs      # 十四场景真实工作流套件（headless Chrome + CDP；S14 = 语言防回归）
  lang-verify.mjs    # 语言生态验证（TASK25；28 项检查，真实浏览器执行）
  run-e2e.mjs        # npm run test:e2e：构建一次 + 依次跑 verify-deploy/bench/scenarios/lang-verify
  pre-commit.sh      # 可选 pre-commit：变更文件跑 tsc + eslint（零依赖）
  setup-hooks.mjs    # npm run setup:hooks：把 .git/hooks/pre-commit 接到 pre-commit.sh
tests/
  log.test.ts        # src/log.ts 的 Vitest 单测（mock FS）
  persist.test.ts    # ... src/persist.ts（排除/签名/force/空目录，mock FS + fake IDB）
  services.test.ts   # ... src/services.ts（解析/端口渲染/状态，mock client）
  pkg.test.ts        # ... src/pkg.ts（来源判定/命令构造，mock 网络）
  motd.test.ts       # ... src/motd.ts
  config.test.ts     # ... src/config.ts
  helpers/fakes.ts   # 内存 FileSystemAPI / fake IndexedDB / 可脚本化终端客户端
eslint.config.js     # ESLint flat config（typescript-eslint recommended + 项目规则）
vitest.config.ts     # Vitest 配置 + v8 覆盖率门禁（核心纯逻辑模块 >=70%）
.github/workflows/
  ci.yml             # CI：lint → typecheck → 单测（覆盖率）→ build → verify-deploy；nightly 场景
public/
  host.js            # 轻量容器内 host 守护进程（生成物）
  lifo-core.js       # @lifo-sh/core 内核 bundle，host.js 懒加载（生成物）
```

## 生态

Succinix 的命令执行引擎（`src/engine/`）**与 Succinix 应用本身解耦**，因此其他前端项目可以把它作为浏览器原生 Unix 沙箱内嵌。使用方页面启动 WebContainer、调用 `createTerminalExecutor()`，即得共享文件系统的 Shell——带真实 Node 运行时（`node|npm|npx`）与 Lifo Unix 用户态（其余一切）——无需自己构建任何部分。

### 引擎 API

公开面是 `src/engine/index.ts`（未来的 `@succinix/engine` 包）。每行一句话：

| 符号 | 作用 |
| ---- | ---- |
| `createTerminalExecutor()` | 返回干净的 `TerminalExecutor` 门面供生态使用方——`boot(wc, opts)` 拉起 host，然后 `exec` / `spawn` / `ps` / `kill` / `ping` / `dispose`。 |
| `bootEngineHost(wc, client, hooks)` | 底层 boot 助手：缺失时注入 `host.js`、spawn host 守护进程、异步写入 `lifo-core.js`，并把 `server-ready` / `port` 事件接到 `onServerReady` / `onServerClosed`。 |
| `exec(command, opts)` | 经统一路由跑一条命令（`node|npm|npx` → 真实 Node 子进程，其余 → Lifo）。返回完整 `ExecResult`；RPC 等待超时返回 `{ ok: false, timedOut: true }` 而非抛异常。 |
| `spawn(command, opts)` | 启动后台长驻进程（node 系）并立即返回 pid；输出流入进程表。 |
| `listProcesses()`（`ps`） | 统一进程表快照——`{ pid, cmd, status, startTime, exitCode?, outputTail? }`。 |
| `kill(pid)` | 对表中真实子进程发 SIGTERM；成功返回 `true`。 |
| `ping()` | host 存活探针——host 应答 `pong` 时 resolve `true`。 |
| `dispose()` | 释放资源（kill host 进程、清引用）。幂等。 |

### 协议与 SDK 文档

- **[docs/PROTOCOL.md](PROTOCOL.md)** — 权威文件 RPC 线上契约：请求/响应形态、命令路由、进程模型、端口事件、超时。生态使用方可只凭本文档构建替代客户端或 host，无需读实现。
- **[docs/SDK.md](SDK.md)** — "把 Succinix 引擎内嵌到不同人的前端项目做沙箱"的 SDK 形态设计：对比 npm 包（同页内嵌、共享文件系统）、iframe 沙箱（硬隔离）与脚手架，并给出推荐路径。
- **[docs/LANGUAGES.zh-CN.md](LANGUAGES.zh-CN.md)** — 以实测为准的语言支持矩阵（Python 标准库、Node/TS 工具链、WASI、Ruby 探测、缺失的编译器）。

### 愿景

引擎与驱动 Succinix 终端的代码是同一份，只隔一道干净 API 边界：日志注入式（引擎发 `CommandLogEntry` 条目；宿主应用决定过滤与持久化什么）、线上协议有文档、无应用层依赖泄漏进 `src/engine/`。打包为 `@succinix/engine` 后，任何已启动 WebContainer 的 Chromium 前端都能加一个共享自己文件的 Unix 沙箱——打包阶段在 [docs/SDK.md](SDK.md) 有完整规划。

## 开发档案

`docs/tasks/TASK*.md` 记录本项目的增量开发历史（每个任务的规格、保留项与质量门禁）。保留在仓库中作为**历史开发档案**，不属于交付产品。

## 路线图

- [x] POC：Lifo 运行在 WebContainer 内 + 共享文件系统
- [x] TerminalExecutor v1：统一路由 + 进程表
- [x] 产品外壳：全屏终端、启动序列、端口、tinbase
- [x] 生产级界面：英文 UI、暗橙主题、JetBrains Mono、系统自检
- [x] 启动画面：居中 DOM 覆盖层、响应式布局、环境不适配优雅退出
- [x] 持久化层：文件/状态持久到 IndexedDB，boot 恢复（刷新不丢数据）
- [x] 内存管理：`free`/`top` 类命令、缓存清理、reboot 回收内存
- [x] 工作区分拆：多虚拟目录隔离状态（类似 Sunam 工作区）
- [x] 虚拟网络视图：`netstat` 虚拟监听端口表 + `ip addr` 诚实虚拟身份
- [ ] SunamAI 集成：`shell_run` 引擎换 TerminalExecutor——**暂缓**（计划为 TASK8；未排期）
- [ ] 可选：外部访问 WebSocket 隧道、v86 回退层

## 许可

MIT © 2026 [CJackHwang](https://github.com/CJackHwang)。见 [LICENSE](../LICENSE)。

## 致谢

- [Lifo](https://github.com/lifo-sh) — TypeScript Unix 用户态（MIT）。
- [WebContainers](https://webcontainers.io) by StackBlitz — 浏览器里的 Node.js 运行时。
- [xterm.js](https://xtermjs.org/) — 终端模拟（MIT）。
- [tinbase](https://github.com/tinbase/tinbase) — 浏览器 Postgres（PGlite/WASM）。
- [Vite](https://vitejs.dev/) — 构建工具（MIT）。
