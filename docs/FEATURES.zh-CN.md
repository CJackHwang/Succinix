# SuccinixOS — 支持的功能与能力

> **SuccinixOS 当前支持能力的权威清单。** 每一项都已实现并验证——此处绝无愿景或臆测。
> **来源（Source）** 列标注实现它的 TASK（详见 CHANGELOG）或记录它的权威文档。
> 英文版：[FEATURES.md](FEATURES.md)

## 1. 系统概览

SuccinixOS 是**浏览器原生 Linux**：浏览器标签页内的全屏 Unix 终端，由 WebContainer + Lifo 驱动，
带**真实 Node.js 运行时**（`node|npm|npx`）与 **Lifo Unix 用户态**（其余一切），两者共享**同一
文件系统**。零安装、无后端——Chromium 浏览器标签页启动即进入环境，提供 Unix 工具、Node.js、
进程管理、端口转发、Postgres 数据库（tinbase）与持久化。

| 项 | 值 | 来源 |
| ---- | ----- | ------ |
| 产品 | SuccinixOS（原 WebUnix）—— 统一品牌，零功能改动 | TASK26 |
| 引擎 | TerminalExecutor（统一路由：`node|npm|npx` → 真实 Node 子进程；其余 → Lifo 沙箱） | TASK1 |
| 运行时 | WebContainer + Lifo，共享虚拟化 `node:fs`（浏览器 `wc.fs`、Node 子进程、Lifo —— 同一棵树） | TASK1, README |
| 版本 | **0.3.0** | CHANGELOG |
| 许可 | **MIT** © 2026 CJackHwang | README |
| 浏览器 | 仅 Chromium 系（Chrome/Edge）+ COOP/COEP 跨源隔离 + SharedArrayBuffer | TASK4, README |

## 2. 内置命令族

浏览器侧命令（浏览器内处理，需要时路由到 host）。每个命令族的状态持久于各自的 `/etc/succinix.*`
状态文件，全部随工作区快照持久。

| 命令 | 作用 | 来源 |
| ------- | ------------ | ------ |
| `help` / `clear` | 命令帮助 / 清屏（`Ctrl+L`） | TASK1, TASK3 |
| `sysinfo` | 浏览器检测的系统信息 | TASK3 |
| `version` / `whoami` | 版本 / 当前用户（`guest`；`?user=` 模式显示用户 id） | TASK3, U1 |
| `ports` | 列出就绪服务端口与预览 URL（来自 `server-ready` 注册表） | TASK2 |
| `db start` / `db status` / `db stop` | tinbase（PGlite/WASM）生命周期；首次启动自动安装 | TASK2 |
| `snapshot` | 持久化状态 / 手动保存（`snapshot now`）/ 重置（`snapshot clear --yes`） | TASK5 |
| `free` / `top` | 内存概览（设备 + JS heap；诚实 `~` 沙箱估算）/ 进程表快照 | TASK6 |
| `reboot` / `shutdown` | 浏览器重载（持久化数据存活）/ 关机 | TASK6 |
| `cache` / `cache clear` | 报告 / 清理仅可重建缓存（绝不触碰 `/workspace`） | TASK6 |
| `workspace` | 隔离工作区（`create`/`switch`/`rm`）；当前记录在 `/ws/.current` | TASK7 |
| `env` | 持久环境变量（`/etc/succinix.env`，spawn 时合并进真实 Node 子进程） | TASK10 |
| `settings` | 持久系统设置（`/etc/succinix.settings`：tinbase `preview-port` 3001、`default-workspace`、实时生效 `font-size`） | TASK10 |
| `service` | 声明式后台服务（`list`/`start`/`stop`/`status`/`enable`/`disable`；`/etc/succinix.services` + boot 自启 `/etc/succinix.autostart`） | TASK11 |
| `log` | journald 风格系统日志（`/var/log/succinix.log`；`log`、`log -n <count>`、`log boot`、`log clear`） | TASK12 |
| `pkg` | 统一包管理（`list`/`search`/`install`/`remove`/`info`），lifo + npm 双通道 | TASK13 |
| `netstat` | 端口注册表的虚拟监听端口表（`netstat -p` 附加关联进程） | TASK14 |
| `ip addr` | 诚实的虚拟网络身份（`lo: virtual loopback`、`eth0: <preview-domain> (virtual)`） | TASK14 |
| `uname` | 诚实的系统身份（`Succinix <v> js-runtime+webcontainer <api-version> <arch>`；`-a`/`-r`/`-m`） | TASK15 |
| `motd` | 查看 / 设置 / 重置持久登录横幅（`/etc/succinix.motd`） | TASK15 |
| `lang` | 列出内置语言运行时与版本 | TASK23 |

持久状态文件（全部随快照跨刷新持久）：`/etc/succinix.env`（TASK10）、`/etc/succinix.settings`
（TASK10）、`/etc/succinix.services`（TASK11）、`/etc/succinix.autostart`（TASK11）、
`/etc/succinix.motd`（TASK15）、`/etc/succinix.cwd`（TASK23）、`/etc/succinix.engine.json`
（结果 TTL 覆盖，TASK21/TASK26）、`/ws/.current`（TASK7）、`/var/log/succinix.log`（TASK12）。

## 3. 语言运行时

在真实浏览器/容器内实测——权威、以实测为准的矩阵见 [docs/LANGUAGES.md](LANGUAGES.md)（英文版：
[docs/LANGUAGES.zh-CN.md](LANGUAGES.zh-CN.md)）。状态图例：`[OK]` 实测可用 · `[x]` 确认为缺失 ·
文字 = 部分/探测。

| 语言 | 命令 | 运行时 | 版本（实测） | 装包能力 | 状态 | 来源 |
| -------- | ------- | ------- | ------------------ | --------------- | ------ | ------ |
| **Python** | `python`、`python3` | 常驻 **Pyodide 314.0.4** daemon（node 子进程，实例复用） | 3.14.2 | `[OK]` **pip** 经 micropip —— 纯 Python wheel 刷新后仍在；编译 wheel 刷新后需重装 | `[OK]` | TASK23, TASK27, `LV·P1–P9`, `S11` |
| **pip** | `pip`、`pip3` | 映射到 Pyodide micropip（`python -m pip` 也可用） | micropip 0.11.1 | `[OK]` install / uninstall / list / show | `[OK]` | TASK27, `LV·P6` |
| **Node.js** | `node` | 真实 Node.js（WebContainer 运行时） | 22.22.3 | `[OK]` npm，本地按项目安装 | `[OK]` | TASK1, TASK24, `LV·N1–N5` |
| **npm** | `npm` | 真实 npm（随 node 自带） | 10.8.2 | `[OK]` 本地；`[x]` 全局（`/usr/local` 只读 → EACCES + hint） | `[OK]` | TASK24, `LV·N4` |
| **TypeScript** | `npx tsc`、`tsx`、`vitest` | npm 安装工具链；node 22 `--experimental-strip-types` | npm 最新版 | `[OK]` 经 npm | `[OK]` | TASK25, `LV·N3`, `S13`, `S14` |
| **Ruby** | （未内置） | `@ruby/wasm-wasi` v2 + `@ruby/head-wasm-wasi`（仅探测） | head ruby.wasm | `[OK]` npm 安装；`[x]` **无 gem** | 探测——可跑、未集成 | TASK25, `LV·R1` |
| **C** | `gcc` | 无 | — | — | `[x]` 确认缺失 | TASK25, `LV·R2` |
| **Rust** | `rustc`、`cargo` | 无 | — | — | `[x]` 确认缺失 | TASK25, `LV·R2` |
| **Go** | `go` | 无 | — | — | `[x]` 确认缺失 | TASK25, `LV·R2` |
| **WASI** | `node:wasi` | Node.js WASI（preview1） | node 22 | — | `[OK]` 可运行预编译 WASI 模块 | TASK25, `LV·R3` |

关键实测事实：

- **Node.js 是真实二进制**，不是模拟：`node -e "console.log(21*2)"` → `42`（`runtime=node`）；
  `npm --version` 报真实 npm 版本。**Shell 融合（TASK24）：** 含 shell 元字符（`&&`、`|`、`>`、
  `2>&1`……）的 node 系命令整条链经 Lifo shell 执行，链中每个 `node`/`npm`/`npx` 段转发回
  **真实二进制** —— `node -e "console.log(21*2)" | grep 42` → `42`（`runtime=lifo`）。
  Tokenizer 保留转义引号；未闭合引号报 `unterminated quote in command`。
- **Python** 运行于常驻 Pyodide daemon：11/11 标准库 import 全绿
  （json/csv/re/math/os/sqlite3/subprocess/collections/datetime/hashlib/urllib），sqlite3 + json
  实测可用，`python -c` / `python <script.py>` / `python -m <module>` 语义保留，
  **pip 经 micropip**（install/uninstall/list/show/--version）。边界：无交互式 REPL（请用
  `python -c`）、`subprocess` 可导入但无法 spawn（`OSError: [Errno 138] ...`）、编译 wheel
  （如 numpy）刷新后需一次 `pip install`。
- **TypeScript 生态闭环**：`npm i -D typescript tsx vitest` → `npx tsc` → `node dist/*.js` →
  `npx vitest run`（1 passed）——场景 S13/S14 实测。
- **Ruby** 仅探测：v2 `@ruby/wasm-wasi` API 在容器内运行 Ruby WASM（`6*7` → 42），但未接入
  路由/内置运行时，且无 gem 安装器。**C/Rust/Go** 编译器确认缺失；预编译 **WASI** 模块可经
  `node:wasi` 运行。

## 4. 持久化

- **工作区快照 → IndexedDB。** 容器文件系统（文件、`/etc` 状态、工作区）快照到 IndexedDB 数据库
  `succinix-persist`（约每 2.5 s 自动保存 + `pagehide` 回退），boot 时恢复。刷新永不丢用户文件。
  `snapshot` 查看状态 / 手动保存 / 重置。 | TASK5, TASK26, README
- **文本优先快照，诚实边界。** 二进制/不可读文件跳过（在保存日志中计数报告）；超过 ~50 MB 的
  快照跳过并告警（`skipped (over 50MB limit)`）而非写入。空目录记录并重建。 | TASK16, TASK19
- **排除项。** `.tinbase` 树（二进制 PGlite store）整体排除——tinbase 数据在会话内跨
  `db stop`/`db start` 持久，但**不**跨浏览器刷新（已文档化）。`/usr/lib/succinix` 运行时资产
  （约 13 MB Python）排除并在首用重新注入。日志文件排除在变更检测签名之外（仍随快照）。
  | TASK19, TASK23, TASK18
- **pip 持久化（尽力而为，诚实）**。Pyodide 的 site-packages 目录经 NODEFS 挂载到
  `/.pyodide/site-packages`（快照内）；`/.pyodide/installed.json` 记录 pip 安装。
  **纯 Python wheel（如 `pyparsing`）刷新后仍可用**；**编译 wheel（如 `numpy`）刷新后需一次
  `pip install <pkg>`**（其 `.so` 是二进制、快照仅文本）。 | TASK27
- **按 origin 数据分域。** IndexedDB 按 origin 隔离——更换部署域 = 全新系统；同域刷新恢复快照。
  | TASK22

## 5. 进程与服务

- **统一进程表** 带 `ps` / `kill`：每个真实子进程注册为 `{ pid, cmd, status, startTime,
  exitCode?, outputTail? }`；表上限 100 条；`kill` 向表条目发 SIGTERM。Lifo 侧进程仅可列出
  （kill 报不在表中）。 | TASK1, PROTOCOL.md
- **后台 `spawn`** 支持 node 系长驻进程（Lifo 无后台概念），带 **2 s 启动确认窗口**：2 s 内非零
  退出的 spawn 进程报告为失败（`ok:false`）。 | TASK1, TASK2, TASK19
- **服务管理**：`service` 定义具名声明式服务（`/etc/succinix.services`，`name|command|port`，
  `${PORT}` 从 `preview-port` 解析），管理 `start`/`stop`/`status`/`enable`/`disable`，`enable`
  写入 `/etc/succinix.autostart` 供 boot 声明式重启（非守护进程——无崩溃自愈）。 | TASK11
- **端口注册表**：WebContainer `server-ready` 事件注册预览 URL；`ports` 列出它们，`netstat`
  渲染虚拟 `Proto  Local Address  State` 表（`netstat -p` 匹配关联进程）。 | TASK2, TASK14

## 6. 网络

- **出站 HTTP** 受 CORS 限制：对无 CORS 头站点的直接 `curl` 失败（`exit 7`）；请用 CORS 友好
  代理，如 `curl https://r.jina.ai/<url>`。Python `urllib` 共享同一边界。 | README, AGENTS.md,
  LANGUAGES.md
- **端口是虚拟 preview。** 服务仅经虚拟预览 URL 可达；没有物理入站网络路径——诚实接受的边界。
  | TASK14, README
- **虚拟网络身份**：`ip addr` 报告 `lo: virtual loopback` 与 `eth0: <preview-domain> (virtual)`；
  不编造任何东西（无假接口、IP 或连接）。 | TASK14

## 7. 会话

- **会话 cwd 同步（融合基石）**：Lifo 在 `/workspace` 下成功 `cd` 同步 host 维护的会话 cwd
  （持久化到 `/etc/succinix.cwd`，host 启动时恢复）；每个真实 Node/Python 子进程以
  `cwd = 会话 cwd` spawn。`pwd` 显示会话 cwd；失败 `cd` 保持原值。存在显式 `setCwd <dir>`
  协议命令。 | TASK23, PROTOCOL.md
- **`/workspace` 路径映射**：Lifo 的 `/workspace` 是浏览器 FS 根的 VFS 视图；真实 node/python
  子进程 spawn 在映射后的真实路径（TASK24 修复了 `cd /workspace` 后 spawn 卡住）。 | TASK23,
  TASK24
- **持久环境变量合并**：`env KEY=value` 写 `/etc/succinix.env`，spawn 时合并进真实 Node 子进程
  （`process.env`）；env 从未到达子进程的双根 bug 已修复并自检。 | TASK10, TASK24
- **Shell 融合**：含 shell 元字符的 node/python 命令经 Lifo shell 执行，每段转发到真实运行时
  —— 真实管道、链、重定向。 | TASK24

## 8. 部署

- **纯静态站，无后端**：Vite 构建 → `dist/`；所有状态在浏览器 IndexedDB。任何能发自定义响应头
  的静态宿主都可部署；一键路径是 Vercel。 | TASK22, README
- **COOP/COEP 头**：`vercel.json` 在**每个**路径（含 `assets/*` 与 `host.js`）下发
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless`——
  WebContainer 跨源隔离所需。 | TASK22
- **部署就绪门禁**：`scripts/verify-deploy.mjs` build → `vite preview` → 断言 `/`、`/host.js`
  与 JS bundle 的 COOP/COEP → headless Chrome 跑 `?test=1` 自检（门禁 `>=57` passed、0 failed）。
  | TASK22
- **按 origin 数据**：更换部署域 = 全新系统（IndexedDB 按 origin 分域）；Vercel preview 部署
  各自独立数据分域。 | TASK22

## 9. 生态 / SDK

- **解耦引擎**：命令执行引擎位于 `src/engine/`，带干净公开 API（`TerminalClient`、
  `createTerminalExecutor()`、`bootEngineHost`、`waitForHostReady`），无应用层依赖泄漏
  （日志经 `onCommand` 注入）。 | TASK21
- **权威协议**：`docs/PROTOCOL.md` 是文件 RPC 线上契约（版本 1）——请求/响应形态、命令路由、
  进程模型、端口事件、超时；生态使用方可仅凭它构建替代客户端/host。 | TASK21, PROTOCOL.md
- **已发布包 —— `@succinix/engine`**（npm；SDK 形态设计的形态 A —— 同页内嵌、共享文件系统、
  最佳 UX）。导出：`.`（`createTerminalExecutor`、`TerminalClient`、`bootEngineHost`、
  `waitForHostReady`）、`./host.js` + `./lifo-core.js`（容器内资产）、`./terminal`（无 UI 会话 +
  boot 编排，0.4.0）与 `./instance`（聚合工厂，0.4.0）。形态 B（iframe `@succinix/sandbox-page`
  + postMessage 桥）仍是硬隔离回退；形态 C（`create-succinix-app` 脚手架）为规划中的上手阶段。
  | TASK21, TASK26, E1–E4, M5
- **TerminalExecutor 门面**：`boot(wc, opts)` / `exec(command, opts)` / `spawn(command, opts)` /
  `listProcesses()` / `kill(pid)` / `ping()` / `pingDirect()` / `respawn()` / `dispose()`。 | TASK21
- **终端 SDK（0.4.0）** —— `SuccinixTerminalSession` 是无 UI 终端交互核心（历史 / Tab 补全 /
  真 Ctrl+C 中断 / 命令队列 / cwd 跟随提示符），基于窄契约 `TerminalRpc`/`TerminalOutput`；
  `createTerminalBoot` 参数化 boot 流程（步骤 / 重试 / testMode）。本地命令处理器可注入；
  不依赖 xterm。 | E1, E2
- **多实例（0.4.0）** —— `createSuccinixInstance({ wc, instanceId })` 一次调用组装 executor +
  会话 + 每实例快照/服务/端口。`?instance=<id>` 以命名实例启动应用：状态文件
  （`/workspace/.succinix-<id>`）、IndexedDB 快照键、env、服务/端口视图与进程视图均按实例；
  跨实例 `kill` 拒绝。不同 id 的双 tab 完全隔离（独立 host —— 已 e2e 验证）；同页共享 host
  路由（ps 过滤 / kill 授权）以协议级单测为证。 | M1–M5, PROTOCOL.md
- **多用户（0.4.0）** —— `?user=<id>`（`?instance=<id>` 的别名）种子每用户 home
  （`/workspace/users/<id>`）：会话在 home 内启动（提示符 `~`、node/python spawn 从 home 起步），
  `whoami`/提示符显示用户；状态/快照/进程视图按用户，含 `ps` 过滤 + `kill` 授权（组织性隔离，
  非安全边界）。 | U1, SDK.md

## 10. 诚实边界表

接受的环境约束——不是 bug，也从不模拟：

| 边界 | 详情 | 来源 |
| -------- | ------ | ------ |
| 无真实内核 / `apt` / 原生二进制 | 沙箱内物理不可行；Succinix 是浏览器原生 Linux | README, AGENTS.md |
| 多用户仅为组织性隔离 | 嵌入模式按实例/用户分割目录·状态·进程视图（`?instance=`/`?user=`）；**非安全边界**；独立应用仍是 `guest` 单用户，不伪造 `chmod` 语义 | AGENTS.md, SDK.md |
| 无入站网络 | 端口是虚拟 preview；隧道是出站桥接，不是真实入站 | TASK14 |
| 无交互式 REPL stdin | 文件 RPC 替代 stdin；`log -f` 与 REPL 风格进程不支持 | TASK1, README |
| 无符号链接 / 硬链接 | Lifo VFS 不支持 | README |
| Firefox / Safari / 移动端不支持 | WebContainers 要求 Chromium；环境检查错误页说明要求 | TASK4 |
| C 扩展 pip 包刷新后不持久 | 文本快照不带 `.so`；numpy 等刷新后需重装 | TASK27 |
| 外部 `curl` 需 CORS 代理 | `https://r.jina.ai/<url>` 风格 | README |
| `npm i -g` → EACCES | `/usr/local` 对 `guest` 只读；追加可操作 hint | TASK24 |
| 1 MB 输出上限 | stdout/stderr 超过 1 MB 仅保留尾部（约束容器内存） | TASK18 |
| 首次 `python` 命令慢 | ~13 MB Pyodide 运行时懒注入；后续命令复用 daemon | TASK27 |
| 无精确 OS 级内存/CPU 统计 | 仅估算，始终标 `~` 并加 `(estimated ...)` 脚注 | TASK6, AGENTS.md |

## 11. 自检与测试

- **`?test=1` 自检** —— 浏览器内跑完整诊断套件：**76 passed, 0 failed, 5 skipped**（5 个 skip
  是已文档化的已知边界，绝非静默失败）。 | TASK1, TASK3, TASK20, TASK25
- **场景套件** —— `scripts/scenarios.mjs`（headless Chrome + CDP）：14 个真实工作流 S1–S14
  （npm 开发循环、lifo-pkg-git 的 git、tinbase 生命周期、服务自启、工作区隔离、队列串行化、
  大输出、持久化压力、错误路径、reboot 边界、python 工作流、cd 同步安装、TS 生态、语言防回归）。
  | TASK19, TASK23, TASK25
- **语言验证** —— `scripts/lang-verify.mjs`：28 项 CDP 驱动检查（`LV·P1–P9`、`N1–N5`、
  `R1–R3`），支撑 LANGUAGES 矩阵。 | TASK25
- **基准** —— `scripts/bench.mjs`：可复现 headless-Chrome 基准（boot、命令往返、快照、大输出），
  JSON 输出供 CI 复用。 | TASK18
- **CI** —— GitHub Actions（`.github/workflows/ci.yml`）：`check` job（lint → typecheck → 单测
  + 覆盖率 → build → `verify-deploy` headless 自检）push/PR 触发，外加定时 `nightly-scenarios`
  job。 | TASK20
- **单测** —— Vitest（node）覆盖纯逻辑模块，用内存 mock FS / fake IndexedDB；v8 覆盖率门禁
  **>=70%**（核心文件）。 | TASK20
- **e2e 流水线** —— `npm run test:e2e` 构建一次，然后依次跑 `verify-deploy` → `bench` →
  `scenarios` → `lang-verify`。 | TASK20, TASK25

## 12. 快速开始 + 文档索引

```bash
npm install
npm run dev          # 启动 Vite dev server（COOP/COEP 已预配置）
# 打开 http://localhost:7892
```

在 shell 里输入 `help` 查看完整命令列表。文档全家福（英文 · 中文）：

- **README** —— 概览、用法、架构：[英文](../README.md) · [中文](README.zh-CN.md)
- **FEATURES** —— 本文档：[英文](FEATURES.md) · [中文](FEATURES.zh-CN.md)
- **LANGUAGES** —— 实测语言支持矩阵：[英文](LANGUAGES.md) · [中文](LANGUAGES.zh-CN.md)
- **PROTOCOL** —— 文件 RPC 线上契约（v1）：[英文](PROTOCOL.md) · [中文](PROTOCOL.zh-CN.md)
- **SDK** —— 引擎内嵌形态设计：[英文](SDK.md) · [中文](SDK.zh-CN.md)
- **AGENTS** —— Agent 与设计规范：[英文](../AGENTS.md) · [中文](../AGENTS.zh-CN.md)
- **CHANGELOG** —— 变更历史：[英文](../CHANGELOG.md) · [中文](../CHANGELOG.zh-CN.md)
- **CONTRIBUTING** —— 如何贡献：[英文](../CONTRIBUTING.md) · [中文](../CONTRIBUTING.zh-CN.md)
