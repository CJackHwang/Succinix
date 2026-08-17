# SuccinixOS — 支持的功能与能力

> **SuccinixOS 当前支持能力的权威清单。** 每一项都已实现并验证——此处绝无愿景或臆测。
> **来源（Source）** 列标注实现它的 TASK（详见 CHANGELOG）或记录它的权威文档。
> 英文版：[FEATURES.md](FEATURES.md)

## 1. 系统概览

SuccinixOS 是**浏览器原生 Linux**：浏览器标签页内的全屏 Unix 终端，由 WebContainer + Lifo 驱动，
带**真实 Node.js 运行时**（`node|npm|npx`）与 **Lifo Unix 用户态**（其余一切），两者共享**同一
文件系统**。零安装、无后端——Chromium 浏览器标签页启动即进入环境，提供 Unix 工具、Node.js、
进程管理、端口转发、Postgres 数据库（tinbase）与持久化。

执行世界原则：WebContainer/Lifo 拥有 userland 命令、运行时、包、服务、编辑器、TUI 与第三方扩展；浏览器只是控制/设备平面（boot、xterm、键盘/resize 事件、必要 Web API 与轻薄传输）。当前 host 使用 Lifo headless `commands.run()`；v0.7 将浏览器终端接入 WebContainer 内 Lifo 根入口导出的 `ITerminal` 与公开 `CommandContext.stdin`/`setRawMode` seam，不在浏览器侧实现并行应用。见 [PLAN-v0.7.0.md](PLAN-v0.7.0.md)。

| 项 | 值 | 来源 |
| ---- | ----- | ------ |
| 产品 | SuccinixOS（原 WebUnix）—— 统一品牌，零功能改动 | TASK26 |
| 引擎 | dsh Cordis 插件：`ctx.fs`、`ctx.sandbox`、`ctx.terminals`、`ctx.sessionPersistence`（统一路由：`node|npm|npx` → 真实 Node 子进程；其余 → Lifo 沙箱） | TASK1, C2 |
| 运行时 | WebContainer + Lifo，共享虚拟化 `node:fs`（浏览器 `wc.fs`、Node 子进程、Lifo —— 同一棵树） | TASK1, README |
| Succinix 应用版本 | **0.6.0** | CHANGELOG |
| 引擎包 | **`@succinix/engine` 0.6.0** — dsh Cordis 插件（`@deepseek-ai/cordis@4.0.1`） | CHANGELOG, cordis-contract.md |
| 许可 | **MIT** © 2026 CJackHwang | README |
| 浏览器 | 仅 Chromium 系（Chrome/Edge）+ COOP/COEP 跨源隔离 + SharedArrayBuffer | TASK4, README |

## 2. 内置命令族

以下是 **v0.7 浏览器控制命令**（浏览器内处理，需要时路由到 host）。状态持久于各自的
`/etc/succinix.*` 文件，全部随工作区快照保存。标准 Unix 命令与交互工具在
WebContainer/Lifo userland 中运行；纯浏览器管理功能收口到 `succinix ...` 命名空间。

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
| `service` | 声明式后台服务（`list`/`start`/`stop`/`status`/`enable`/`disable`；由 Lifo `ServiceManager` 管理 `/etc/systemd/system/*.service` unit，启用标记随快照保存） | TASK11 |
| `log` | journald 风格系统日志（`/var/log/succinix.log`；`log`、`log -n <count>`、`log boot`、`log clear`） | TASK12 |
| `pkg` | 统一包管理（`list`/`search`/`install`/`remove`/`info`），lifo + npm 双通道 | TASK13 |
| `netstat` | 端口注册表的虚拟监听端口表（`netstat -p` 附加关联进程） | TASK14 |
| `ip addr` | 诚实的虚拟网络身份（`lo: virtual loopback`、`eth0: <preview-domain> (virtual)`） | TASK14 |
| `uname` | 诚实的系统身份（`Succinix <v> js-runtime+webcontainer <api-version> <arch>`；`-a`/`-r`/`-m`） | TASK15 |
| `motd` | 查看 / 设置 / 重置持久登录横幅（`/etc/succinix.motd`） | TASK15 |
| `lang` | 列出内置语言运行时与版本 | TASK23 |
| `vi` / `nano` | Lifo 原生交互编辑器：raw-mode stdin、全屏重绘、保存/退出/搜索——与第三方 TUI 共用同一 `ITerminal` seam | v0.7 |
| `net` | 诚实网络视图：`net doctor` 能力报告、`net preview` 虚拟端口列表、`net tunnel` fail-closed（`unavailable`） | v0.7 |
| `succinix status` / `succinix plugins` | 插件状态 / Cordis 插件与 fiber 状态 | C4 |
| `succinix capabilities` | `succinix-linux-userland/0.7` profile：每个命令的状态/运行时/执行契约 + fail-closed denylist（exit 126） | v0.7 |
| `succinix doctor` | 自检：host RPC ping、持久化、userland profile、引擎状态（`[  OK  ]` / `[ FAIL ]` / `[SKIP]`） | v0.7 |
| `succinix net doctor` / `net preview` / `net tunnel` | 网络能力报告 / 虚拟 preview 端口 / 出站隧道（unavailable） | v0.7 |
| `succinix init` | 从 `package.json`、`pyproject.toml`、`requirements.txt`、Vite 配置、`index.html` 探测项目类型 | v0.7 |
| `succinix run` | 通过执行世界启动探测到的开发命令（`npm run dev` / `npm start` / `node <main>`） | v0.7 |
| `succinix serve` | 注册并启动匹配的声明式服务（`vite` / `static-http`）并打印 preview URL | v0.7 |
| `succinix open [port]` | 打印就绪端口的 preview URL | v0.7 |

持久状态文件（全部随快照跨刷新持久）：`/etc/succinix.env`（TASK10）、`/etc/succinix.settings`
（TASK10）、`/etc/systemd/system/*.service` unit 与 `/workspace/.succinix-service-state/*.enabled`（TASK11）、
`/etc/succinix.motd`（TASK15）、`/etc/succinix.cwd`（TASK23）、`/etc/succinix.engine.json`
（结果 TTL 覆盖，TASK21/TASK26）、`/ws/.current`（TASK7）、`/var/log/succinix.log`（TASK12）。

命令日志与 Cordis 命令事件默认脱敏：token、密码、npm auth（`_authToken` / `_auth`）、环境变量
secret 与 URL query secret 永不落入 `/var/log/succinix.log`、telemetry 事件或会话镜像。

## 3. 语言运行时

在真实浏览器/容器内实测——权威、以实测为准的矩阵见 [docs/LANGUAGES.md](LANGUAGES.md)（英文版：
[docs/LANGUAGES.zh-CN.md](LANGUAGES.zh-CN.md)）。状态图例：`[OK]` 实测可用 · `[x]` 确认为缺失 ·
文字 = 部分/探测。

| 语言 | 命令 | 运行时 | 版本（实测） | 装包能力 | 状态 | 来源 |
| -------- | ------- | ------- | ------------------ | --------------- | ------ | ------ |
| **Python** | `python`、`python3` | 常驻 **Pyodide 314.0.4** daemon（node 子进程，实例复用） | 3.14.2 | `[OK]` **pip** 经 micropip —— 纯 Python 与编译 wheel 刷新后仍在（v0.7 binary 快照） | `[OK]` | TASK23, TASK27, `LV·P1–P9`, `S11` |
| **pip** | `pip`、`pip3` | 映射到 Pyodide micropip（`python -m pip` 也可用） | micropip 0.11.1 | `[OK]` install / uninstall / list / show | `[OK]` | TASK27, `LV·P6` |
| **Node.js** | `node` | 真实 Node.js（WebContainer 运行时） | 22.22.3 | `[OK]` npm，本地按项目安装 | `[OK]` | TASK1, TASK24, `LV·N1–N5` |
| **npm** | `npm` | 真实 npm（随 node 自带） | 10.8.2 | `[OK]` 本地；`[x]` 全局（`/usr/local` 只读 → EACCES + hint） | `[OK]` | TASK24, `LV·N4` |
| **TypeScript** | `npx tsc`、`tsx`、`vitest` | npm 安装工具链；node 22 `--experimental-strip-types` | npm 最新版 | `[OK]` 经 npm | `[OK]` | TASK25, `LV·N3`, `S13`, `S14` |
| **Ruby** | `ruby` | 懒注入 WASM 运行时（浏览器资产桥 → 真实 Node 子进程内 `@ruby/wasm-wasi` adapter） | head ruby.wasm | `[OK]` npm 安装；`[x]` **无 gem** | `[OK]` 已集成、懒加载（首跑慢） | v0.7, `LV·R1` |
| **C** | `gcc` | 无 | — | — | `[x]` 确认缺失 | TASK25, `LV·R2` |
| **Rust** | `rustc`、`cargo` | 无 | — | — | `[x]` 确认缺失 | TASK25, `LV·R2` |
| **Go** | `go` | 无 | — | — | `[x]` 确认缺失 | TASK25, `LV·R2` |
| **WASI** | `wasi-run` / `wasi-info` | `node:wasi`（preview1）之上的 Lifo adapter，模块从 `/workspace` 加载 | node 22 | — | `[OK]` 已集成（`wasi-run <file>`，≤ 32 MB） | v0.7, `LV·R3` |

关键实测事实：

- **Node.js 是真实二进制**，不是模拟：`node -e "console.log(21*2)"` → `42`（`runtime=node`）；
  `npm --version` 报真实 npm 版本。**Shell 融合（TASK24）：** 含 shell 元字符（`&&`、`|`、`>`、
  `2>&1`……）的 node 系命令整条链经 Lifo shell 执行，链中每个 `node`/`npm`/`npx` 段转发回
  **真实二进制** —— `node -e "console.log(21*2)" | grep 42` → `42`（`runtime=lifo`）。
  Tokenizer 保留转义引号；未闭合引号报 `unterminated quote in command`。
- **Python** 运行于常驻 Pyodide daemon：11/11 标准库 import 全绿
  （json/csv/re/math/os/sqlite3/subprocess/collections/datetime/hashlib/urllib），sqlite3 + json
  实测可用，`python -c` / `python <script.py>` / `python -m <module>` 语义保留，
  **pip 经 micropip**（install/uninstall/list/show/--version）。当前 host 无通用 Python
  子进程 REPL（请用 `python -c`）、`subprocess` 可导入但无法 spawn（`OSError: [Errno 138] ...`）、
  编译 wheel（如 numpy）随 v0.7 binary 导出保留 `.so`，刷新后无需重装。
- **TypeScript 生态闭环**：`npm i -D typescript tsx vitest` → `npx tsc` → `node dist/*.js` →
  `npx vitest run`（1 passed）——场景 S13/S14 实测。
- **Ruby** 仅探测：v2 `@ruby/wasm-wasi` API 在容器内运行 Ruby WASM（`6*7` → 42），但未接入
  路由/内置运行时，且无 gem 安装器。**C/Rust/Go** 编译器确认缺失；预编译 **WASI** 模块可经
  `node:wasi` 运行。

## 4. 持久化

- **工作区快照 → IndexedDB v2。** 容器文件系统（文件、`/etc` 状态、工作区、pip site-packages）
  以 binary generation 导出到 IndexedDB 数据库 `succinix-persist-v2`（dirty 驱动、5 s 防抖、最长 30 s 强制落盘 +
  `pagehide` 回退），boot 时恢复。刷新永不丢用户文件。`snapshot` 查看状态 /
  手动保存 / 重置。 | v0.7（PLAN §7）、TASK5、TASK26、README
- **二进制快照，精确恢复。** generation 先写 ≤256 KiB chunk，再写 SHA-256 manifest，最后切
  活动指针（`current`）；撕裂写入不会切换活动 generation（保留 last-known-good）。v0.6
  旧库 `succinix-persist` 仅检测并报告 `legacy snapshot detected`——不迁移、不删除。默认配额
  256 MiB；空目录记录并重建。 | v0.7（PLAN §7.1）、TASK16、TASK19
- **排除项。** `node_modules` / `dist` / `.git` 树默认从二进制导出中排除；将 `defaultInstance.persistence.includeGit` 设为 `true` 才保留 Git 元数据。`.succinix-terminal`
  mailbox、host/RPC 产物（`host.js`、`lifo-core.js`、`cmd.json`、`result-*.json`）、`.tinbase`
  树（二进制 PGlite store——会话内跨 `db stop`/`db start` 持久，但**不**跨浏览器刷新）、
  `/usr/lib/succinix` 运行时资产（约 13 MB Python，首用重新注入）都不会进入恢复后的树。
  同页多实例另按自身状态根与用户 home 收窄范围。 | TASK19、TASK23、TASK18、M5
- **pip 持久化。** Pyodide 的 site-packages 目录经 NODEFS 挂载到 `/.pyodide/site-packages`
  （快照内）；`/.pyodide/installed.json` 记录 pip 安装。**纯 Python wheel（如 `pyparsing`）
  与编译 wheel（如 `numpy`）刷新后均可用**——二进制导出携带 `.so` 文件（`S11`）。 | TASK27
- **按 origin 数据分域。** IndexedDB 按 origin 隔离——更换部署域 = 全新系统；同域刷新恢复快照。
  | TASK22

## 5. 进程与服务

- **统一进程表** 带 `ps` / `kill`：每个真实子进程注册为 `{ pid, cmd, status, startTime,
  exitCode?, outputTail? }`；表上限 100 条；`kill` 向表条目发 SIGTERM。Lifo 侧进程仅可列出
  （kill 报不在表中）。 | TASK1, PROTOCOL.md
- **后台 `spawn`** 支持 node 系长驻进程（Lifo 无后台概念），带 **2 s 启动确认窗口**：2 s 内非零
  退出的 spawn 进程报告为失败（`ok:false`）。 | TASK1, TASK2, TASK19
- **服务管理**：`service`/`systemctl` 通过同一 Lifo `ServiceManager` 管理 `/etc/systemd/system/*.service`
  unit（官方模板中的 `${PORT}` 在执行世界解析），提供 `start`/`stop`/`status`/`enable`/`disable`。
  `enable` 将 marker 写入 `/workspace/.succinix-service-state/*.enabled`，boot 时恢复（非 PID 1
  守护进程——无崩溃自愈）。 | TASK11
- **端口注册表**：WebContainer `server-ready` 事件注册预览 URL；`ports` 列出它们，`netstat`
  渲染虚拟 `Proto  Local Address  State` 表（`netstat -p` 匹配关联进程）。 | TASK2, TASK14

## 6. 网络

- **Git HTTPS**：`git init/status/add/rm/commit/log/diff/branch/checkout/clone/fetch/pull/push`
  在 WebContainer 执行世界内通过 Isomorphic Git 运行。仅接受 HTTPS remote；SSH 固定返回
  `git: SSH transport is unsupported`，exit 126。`GIT_HTTP_TOKEN` 只存在于运行时环境，错误信息
  会脱敏，且绝不进入命令日志或快照。 | v0.7
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
- **Here-document**：`<<` 与 `<<-` 明确不支持（`succinix: here-document: unsupported`，exit 2）；引号或转义中的字面 `<<` 仍可使用。 | v0.7

## 8. 部署

- **纯静态站，无后端**：Vite 构建 → `dist/`；所有状态在浏览器 IndexedDB。任何能发自定义响应头
  的静态宿主都可部署；一键路径是 Vercel。 | TASK22, README
- **COOP/COEP 头**：`vercel.json` 在**每个**路径（含 `assets/*` 与 `host.js`）下发
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless`——
  WebContainer 跨源隔离所需。 | TASK22
- **部署就绪门禁**：`scripts/verify-deploy.mjs` build → `vite preview` → 断言 `/`、`/host.js`
  与 JS bundle 的 COOP/COEP → headless Chrome 跑 `?test=1` 自检（门禁 `>=71` passed、0 failed）。
  | TASK22
- **按 origin 数据**：更换部署域 = 全新系统（IndexedDB 按 origin 分域）；Vercel preview 部署
  各自独立数据分域。 | TASK22

## 9. 生态 / SDK

- **解耦引擎、dsh 单轨**：命令执行核心位于 `src/engine/` 且保持 Cordis-free；
  `src/plugin/` 是薄 Cordis 层。`@succinix/engine@0.6.0` 是唯一对外形态：
  插件注册名为 `succinix`，经 `ctx.fs` / `ctx.sandbox` / `ctx.terminals` /
  `ctx.sessionPersistence` 消费。 | C1–C6, AGENTS.md
- **权威协议**：`docs/PROTOCOL.md` 是文件 RPC 线上契约（版本 1）——请求/响应形态、命令路由、
  进程模型、端口事件、超时；生态使用方可仅凭它构建替代客户端/host。 | TASK21, PROTOCOL.md
- **发布包导出**：`.`（插件入口 `{ name, apply, Config }` + 类型）、`./host.js` +
  `./lifo-core.js`（容器内资产）、`./assets/*`（Pyodide + SHA 清单）、`./package.json`。
  0.4.0 的 `./terminal` / `./instance` 子路径已移除。 | C1, C6
- **dsh 服务面**：`ctx.fs`（12 原语、13 个 `FS_*` 错误码）、`ctx.sandbox`
  （同步 `confine`、node fail-closed）、`ctx.terminals`（owner 隔离 PTY
  registry）与 `ctx.sessionPersistence`（event-sourced JSONL）。内部生命周期
  facade（`executor`、`terminal`、`snapshot`、`persist`、`workspace`、
  `ports`、`services`、`capabilities`、`instance`、`boot` / `attach` /
  `ensureInstance`）位于 `succinix` seam 之后。 | C2, cordis-contract.md
- **类型化事件**：`succinix/state`（带 `reason` / `changed`）、`server-ready`、
  `server-closed`、`command` / `command-start` / `command-finish` telemetry、
  `runtime-ready`、`degradation`、`persistence`、`terminal-open` / `terminal-close` /
  `terminal-backpressure`、`instance`、`workspace`、`process`。 | C4, manageability.md
- **能力注册表**：`terminal.exec`、`terminal.spawn`、`terminal.kill`、`terminal.interrupt`、
  `fs.read`、`fs.write`、`workspace.restore`、`workspace.flush`、`workspace.list`；默认放行，
  可用规则覆盖。 | C2
- **生命周期语义**：页面级 HostManager 单例；fiber reload 不重启 host；`dispose()` 软收尾、
  `shutdown()` 完全关闭；`attach`/`boot` 模式互斥抛 `ERR_MODE_MISMATCH`；资产 SHA-256 完整性
  默认启用。 | C2, C5
- **多实例（0.6.0+）** —— `host.ensureInstance(id, opts)` 在共享页面 host 上
  创建或复用按实例栈。`?instance=<id>` 以命名实例启动应用：状态文件
  （`/workspace/.succinix-<id>`）、IndexedDB 快照键、env、服务/端口视图与
  进程视图均按实例；跨实例 `kill` 拒绝。不同 id 的双 tab 完全隔离（独立
  host —— 已 e2e 验证）。 | M1–M5, PROTOCOL.md
- **多用户（0.6.0+）** —— `?user=<id>`（`?instance=<id>` 的别名）种子每用户 home
  （`/workspace/users/<id>`）：会话在 home 内启动（提示符 `~`、node/python spawn 从 home 起步），
  `whoami`/提示符显示用户；状态/快照/进程视图按用户，含 `ps` 过滤 + `kill` 授权（组织性隔离，
  非安全边界）。 | U1, SDK.md
- **外部 demo / 契约快照**：`examples/cordis-app/` 只依赖打包后的引擎、
  `@deepseek-ai/cordis` 与 `@webcontainer/api`；`scripts/cordis-app-e2e.mjs`
  在 headless Chrome 跑契约。 | C5, cordis-contract.md

## 10. 诚实边界表

接受的环境约束——不是 bug，也从不模拟：

| 边界 | 详情 | 来源 |
| -------- | ------ | ------ |
| 无真实内核 / `apt` / 原生二进制 | 沙箱内物理不可行；Succinix 是浏览器原生 Linux | README, AGENTS.md |
| 多用户仅为组织性隔离 | 嵌入模式按实例/用户分割目录·状态·进程视图（`?instance=`/`?user=`）；**非安全边界**；独立应用仍是 `guest` 单用户，不伪造 `chmod` 语义 | AGENTS.md, SDK.md |
| 无入站网络 | 端口是虚拟 preview；隧道是出站桥接，不是真实入站 | TASK14 |
| 通用子进程交互 stdin | 当前 host 使用文件 RPC 和 headless Lifo，任意 Node/Python REPL 仍不支持；v0.7 为明确声明交互能力的 Lifo userland 命令提供 WebContainer 原生终端传输 | TASK1, README, PLAN-v0.7.0 |
| 无符号链接 / 硬链接 | Lifo VFS 不支持 | README |
| Firefox / Safari / 移动端不支持 | WebContainers 要求 Chromium；环境检查错误页说明要求 | TASK4 |
| 外部 `curl` 需 CORS 代理 | `https://r.jina.ai/<url>` 风格 | README |
| `npm i -g` → EACCES | `/usr/local` 对 `guest` 只读；追加可操作 hint | TASK24 |
| 1 MB 输出上限 | stdout/stderr 超过 1 MB 仅保留尾部（约束容器内存） | TASK18 |
| 首次 `python` 命令慢 | ~13 MB Pyodide 运行时懒注入；后续命令复用 daemon | TASK27 |
| 无精确 OS 级内存/CPU 统计 | 仅估算，始终标 `~` 并加 `(estimated ...)` 脚注 | TASK6, AGENTS.md |

## 11. 自检与测试

- **`?test=1` 自检** —— 浏览器内跑完整诊断套件：**76 passed, 0 failed, 5 skipped**（5 个 skip
  是已文档化的已知边界，绝非静默失败）。 | TASK1, TASK3, TASK20, TASK25
- **场景套件** —— `scripts/scenarios.mjs`（headless Chrome + CDP）：14 个真实工作流 S1–S14
  （npm 开发循环、lifo-pkg-git 的 git、tinbase 生命周期、服务启用、工作区隔离、队列串行化、
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
  `scenarios` → `lang-verify` → `instance-demo` → `instance-routing` → `cordis-app`。 | TASK20, TASK25

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
- **SDK** —— Cordis 插件集成：[英文](SDK.md) · [中文](SDK.zh-CN.md)
- **PLUGIN** —— 第三方 Cordis 插件开发：[英文](PLUGIN.md)
- **MIGRATION** —— 0.4.0/0.5.0 到 0.6.0 迁移指南：[英文](MIGRATION.md)
- **cordis-contract** —— 契约快照与验证器：[英文](cordis-contract.md)
- **AGENTS** —— Agent 与设计规范：[英文](../AGENTS.md) · [中文](../AGENTS.zh-CN.md)
- **CHANGELOG** —— 变更历史：[英文](../CHANGELOG.md) · [中文](../CHANGELOG.zh-CN.md)
- **CONTRIBUTING** —— 如何贡献：[英文](../CONTRIBUTING.md) · [中文](../CONTRIBUTING.zh-CN.md)
