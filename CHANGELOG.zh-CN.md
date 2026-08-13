# 更新日志（Changelog）

> 中文翻译。英文版为准：见 [CHANGELOG.md](CHANGELOG.md)

本文件记录本项目的全部重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循[语义化版本（Semantic Versioning）](https://semver.org/spec/v2.0.0.html)。

## [Unreleased]

### 破坏性变更（Breaking）

- **移除 `ctx.succinix` 单键服务面。** 引擎现按 dsh 0.1.0-rc.6 提供
  `ctx.fs`、`ctx.sandbox`、`ctx.terminals`、`ctx.sessionPersistence`
  四个服务键；旧键不再保留，也不提供弃用过渡期。
- **Cordis 基线切换为 `@deepseek-ai/cordis@4.0.1`。**
- **命令上下文中的 `ctx.succinixState` / `ctx.succinixPlugins` 重命名**
  为 `succinixState` / `succinixPlugins`，不再带 `ctx.` 服务前缀。
- **`ctx.fs` 对齐 dsh 错误与身份契约：** 12 个原语、13 个错误码、
  `sandboxMode`、`sandboxPolicy`、opaque `targetKey`、LF-normalized
  outcome，以及有上限且不截断的 `readBytes`。
- **`ctx.sandbox.confine` fail-closed：** 只接受 `read-only` 与
  `workspace-write`；受限模式下真实 `node|npm|npx` 子进程抛
  `SANDBOX_UNAVAILABLE`。
- **`ctx.terminals` 变为 owner-scoped registry：** 固定信号白名单、
  每会话单个 in-flight send、幂等且等待 quiescent 的 `kill`。
- **`ctx.sessionPersistence` 变为 event-sourced JSONL 镜像：** 连续 seq、
  仅截尾 repair、raw artifact 与 opaque revision。

### 新增（Added）

- 入库 dsh 0.1.0-rc.6 契约快照：`docs/contracts/dsh-0.1.0-rc.6/`。
- 新增 `scripts/check-dsh-shapes.mjs` 与 `scripts/check-dsh-keys.mjs`，
  并接入 `npm run check`。
- 四个 dsh 服务的单测与浏览器 e2e 覆盖，含外部
  `examples/cordis-app` 契约。

## [0.4.0] — 2026-08-10

### 新增（Added）

- **终端 SDK（E1–E4）** —— `SuccinixTerminalSession`：无 UI 终端交互核心（历史 / Tab 补全 /
  真 Ctrl+C 中断 / 命令队列 / cwd 跟随提示符），基于窄契约 `TerminalRpc` / `TerminalOutput`；
  `createTerminalBoot` 参数化 boot 流程（步骤 / 重试 / testMode），`BootUI` 进度 marker 复用。
  独立应用重构为 SDK 之上的薄组装层，行为零变化。新包导出 `@succinix/engine/terminal`
  （自包含，无 `node:` 引用）。
- **多实例（M1–M5）** —— `@succinix/engine/instance` 导出
  `createSuccinixInstance({ wc, instanceId, ... })`：一次调用聚合 executor + 终端会话 +
  每实例快照持久化、服务与端口视图。实例上下文是协议 **additive** 字段（`instanceId`）：
  状态文件移至 `/workspace/.succinix-<id>`、IndexedDB 快照按实例键分割、`ps` 按实例过滤、
  `interrupt` 按实例分键；`?instance=<id>` 以命名实例启动独立应用（双 tab demo，已 e2e 验证）。
- **多用户语义（U1）** —— `userId` 与 `instanceId` 是同一字段；`?user=<id>`
  （`?instance=<id>` 的别名）种子每用户 home（`/workspace/users/<id>`）：会话在 home 内启动
  （提示符 `~`、node/python spawn 从 home 起步）、`whoami`/提示符显示用户，状态 / 快照 /
  进程视图按用户。host 侧 `kill` 授权拒绝跨实例 kill
  （`permission denied: process <pid> is not owned by instance '<id>'`）与非默认实例的
  `system` 进程。文档化声明：**组织性隔离，非安全边界**（AGENTS.md / SDK.md / PROTOCOL.md）。

### 变更（Changed）

- `src/main.ts` 与 `src/boot.ts` 改为在终端 SDK 与实例工厂之上组装应用；boot 步骤 / demo
  路径共享同一实现（`runApplicationBootSteps`）。
- `?test=1` 自检增至 **76 passed, 0 failed, 5 skipped**；Vitest 套件增至 **320 用例 / 23 文件**
  （实例协议/路径、多用户 kill 授权、用户 home 种子、host 路由）。
- `scripts/instance-demo.mjs` 现覆盖双 tab `?instance=` 与双用户 `?user=` 隔离（27/27 检查）。

### 修复（Fixed）

- U1 demo 接线的 TypeScript 错误（未用导入 / 选项类型）在 commit 前被 tsc 门禁拦截。

### 性能（2026-08-10 本机实测）

- `public/host.js` 从 ~5 KB（0.3.0）增至 **15,037 B** —— 按实例/按用户路由（cwd/env/状态
  Map、`ps` 过滤、`kill` 授权）位于 host daemon；`public/lifo-core.js` 不变
  （**1,066,097 B**，首个 Lifo 命令懒加载）。
- `scripts/bench.mjs`：boot overlay → 提示符 **~6.1 s**（主要耗时在 `WebContainer.boot`
  5.35 s，环境相关），命令往返 **Lifo p50 ≈ 79 ms / Node p50 ≈ 79 ms**（0.3.0 基线 ~80 ms，
  无回归），快照 N=200 **13 ms**、N=1000 **193 ms**，`seq 1 5000` 渲染 **79 ms**。

## [0.3.0] — 2026-08-10

### Changed

- **TODO-optimizations 全量 19 项（架构审计批次）** ——
  - **P0**：自动快照新增 **30s 最大年龄强制**（`persist.isAgeForced` + `AUTO_SNAPSHOT_FORCE_INTERVAL_MS`），把等长编辑的丢失窗口收敛到有界；host 处理完请求后**删除 `/cmd.json`**，防陈旧命令被重启后的新 host 执行。
  - **P1**：`createTerminalExecutor()` 门面补全 `pingDirect()` + `respawn()`（单 host 不变量），`boot` 接受 `EngineBootHooks`；README 记录「两个执行面、同一 host」分工。host.ts 纯逻辑（路由判定 / 路径映射 / 输出截断 / EACCES 提示 / pid 解析）抽到 `src/engine/host-route.ts`（已单测 + 入覆盖门禁）。进程归属 `scope` 文档化标注为**启发式、非安全边界**。
  - **P2**：抽 `src/theme.ts`（ANSI 色）、`src/util.ts`（sleep/ensureParentDir）、`src/engine/sleep.ts`（引擎自包含 sleep），`forcePersist` 收敛到 `persist.ts`（带 tag）；版本号构建期注入 `__SUCCINIX_VERSION__`（`src/version.ts`，单一来源 = 根 package.json）；host 三处 spawn 经 `attachOutputCollector` + `spawnTracked` 合并；`dbStart` 失败块收敛为单个 `fail()`；`execute`/`scenarioRun` 共享 `callHostRpc`。
  - **P3**：`commands.ts` 纯函数（21 用例）与 `TerminalClient`（20 用例：串行队列 / 只读重试 / pingDirect 通道判定 / interruptDirect）补单测；`client.ts` + `host-route.ts` 入门禁（~94.5% lines）。门面 14 用例（`tests/engine-facade.test.ts`）。`commands.ts` 按范围决策不入聚合门禁（会把整体拉到 70% 以下）。
  - **P4**：自动快照空闲指数退避（2.5s → 5/10/15s，仅真实变化复位）；`SaveResult.reason` 新增。日志 appendFile O(n) 读改写记为 backlog。
  - **P5**：**Ctrl+C 中断当前命令并清空队列**（`interrupt` 协议命令 + 绕过队列的 `interruptDirect`）、**上下箭头命令历史** + **Tab 补全**（内置命令 + 文件路径）、未知转义序列丢弃不产生乱码。
  - **P6**：CSP 评估记录为暂缓（WebContainer 内部依赖 blob worker / wasm-unsafe-eval / npm 连接，未验证不强上）；`?test=1`/`?bench=1`/`?scenario=1` 文档化标注为仅供开发者的测试钩子。

- **进程归属标注（为宿主项目提供进程隔离）** —— `ps()` 响应新增 `scope` 字段（`system` / `container` / `unknown`）+ 可选 `containerId`，依据进程启动 cwd（`cd /workspace/c-<id>` 前缀）判定。协议兼容扩展：现有字段不变，新字段纯增量。宿主项目（SunamAI）据此按容器过滤进程并拦截跨容器 kill。

- **启动界面精简（去掉覆盖层，boot 日志直接进终端）** —— 移除 DOM 覆盖层（ASCII 大标题 + 系统信息网格）；boot 日志（`[  OK  ]` 行）直接写入 xterm，motd + 提示符接在自检后（不清屏，滚动可回看完整 boot 日志）。环境错误页保留 DOM。`?test=1` / `?bench=1` / `?scenario=1` 模式不受影响；`verify-deploy.mjs` 改读 `__succinixResult`。

- **品牌迁移（TASK26）：项目现更名为 Succinix（SuccinixOS）** —— 统一改名，零功能改动，无旧名兼容层。
  - 身份标识（Identity）：包名 `succinix`、`<title>` / boot 版本 / 环境错误页、boot 横幅（`Succinix 0.2.0 ...`）、boot-splash ASCII art（SUCCINIX）、终端提示符 `guest@succinix:~$`、`uname` 身份（`Succinix 0.2.0 ...`，主机名 `succinix`）、help / reboot / 自检字符串。
  - 状态文件（State files）`/etc/succinix.*`（`env` / `settings` / `services` / `autostart` / `motd` / `cwd` / `engine.json`）、日志 `/var/log/succinix.log`、python 运行时资产 `/usr/lib/succinix`。
  - 持久化（Persistence）：IndexedDB 数据库 `succinix-persist`；窗口钩子 `__succinixBench` / `__succinixScenario`；dev-tool 临时目录前缀 `succinix-*`。
  - 生态命名（Ecosystem naming，`docs/SDK.md`）：`@succinix/engine`、`@succinix/sandbox-page`、`create-succinix-app`。
  - `docs/tasks/*` 历史档案有意不改；版本保持 **0.2.0**。

- **内置 Python 从仅标准库的 python-wasm 运行时切换到常驻 Pyodide daemon（TASK27）** —— 内置 `python` / `python3` 现运行于 **Pyodide 314.0.4**（打包 **Python 3.14.2**），经 micropip 支持 **`pip` / 第三方包**：
  - 运行时（Runtime）：`src/engine/python-daemon.ts` 是 host 首用时拉起的常驻 node 进程（`src/engine/python-daemon-client.ts`）；它 `loadPyodide` 一次并跨命令复用实例——Python 状态（已导入模块、pip 安装的包）在会话内累积，与 Lifo 内核完全一致。命令协议 / 文件 RPC / shell 融合路由不变（纯 python/pip 命令路由到 daemon；含 shell 元字符的命令回退 Lifo shell，并把每个 python/pip 段转发到同一 daemon）。
  - 资产（Assets）：`scripts/build-host.mjs` 从 jsdelivr CDN 下载 **Pyodide 314.0.4 full** 发行版到 `public/pyodide/`（pyodide.mjs + pyodide.asm.mjs + pyodide.asm.wasm + python_stdlib.zip + pyodide-lock.json，版本固定）并打包 daemon；旧的 python-wasm 资产（python.wasm / kernel.wasm / python-stdlib.zip / termcap）及其懒注入逻辑已移除（`src/engine/python-assets.ts` 现把 Pyodide 资产组注入 `/usr/lib/succinix/python/`）。
  - **pip 持久化（尽力而为，诚实边界）**：Pyodide 的 site-packages 目录经 NODEFS 挂载到 `/.pyodide/site-packages`（工作区快照内）。**纯 Python wheel（如 `pyparsing`）刷新后仍可用** —— 已验证：`pip install pyparsing` → 重载 → `import pyparsing` 无网络可用。**编译 wheel（如 `numpy`）刷新后需再 `pip install <pkg>`**：其 `.so` 文件是二进制而快照仅文本，因此 daemon 启动时丢弃不完整包以免 `import` 损坏（文档化边界见 `docs/LANGUAGES.md`）。清单 `/.pyodide/installed.json` 记录 pip 安装。
  - 行为（Behavior）：`python -c` / `python <script.py>` / `python -m <module>` 语义保留（相对文件操作经 NODEFS cwd 挂载映射到容器根）；`python -m pip install <pkg>` 与裸 `pip`/`pip3` 命令映射到 micropip（install / uninstall / list / show / --version）。`subprocess` 可导入但 `subprocess.run` 抛 `OSError: [Errno 138] emscripten does not support processes`（Pyodide 无 OS 进程 API——重测，python-wasm 下原为 `NOT IMPLEMENTED`）。
  - 原因（Why）：TASK23 认为 Pyodide 314 无法运行在 WebContainer 的 node 22 的前提在 2026-08 **重测并推翻** —— `validate` + `instantiate` + `loadPyodide` + `micropip` 全部在容器 node 22.22.3 上工作，因此实现了用户要求的、支持 pip 的 Python 技术栈切换。
  - 验证（Verification）：`scripts/lang-verify.mjs` 的 LV·P1–P9 与场景 S11 针对 Pyodide 重测（3.14.2 版本、pip install pyparsing、numpy 安装 + matmul `[[7,10],[15,22]]`、刷新持久化 + 编译包边界）；自检 python 断言更新（版本、`python -m pip --version` 可用、pip install pyparsing + import）。

### Added

- **`pip` / `pip3` 命令**（host 路由 + Lifo shell 转发）与 `python -m pip` 子命令（install / uninstall / list / show / --version）。
- **`public/pyodide/PYODIDE_VERSION`** 构建产物（固定 314.0.4）与 `.pyodide/` daemon 持久化布局（site-packages + `installed.json` 清单）。

- TASK25 语言生态验证（真实浏览器，零新依赖）：
  - **`scripts/lang-verify.mjs`** —— CDP 驱动的多语言验证（28 项检查，id `P1–P8` / `N1–N5` / `R1–R3`）：python 版本/`-c`/脚本/管道、11 模块标准库 import 矩阵、`json.dumps`/`subprocess.run` 行为探针、pip 报错清晰度、跨 python/node/lifo 的共享 FS 读写；5 个 TS/Node 用户实测坑（链、嵌套引号写文件、完整 TS 工具链、EACCES hint、cwd 同步安装）；Ruby `@ruby/wasm-wasi` v2 探针（**可跑**：`6*7` → 42）、C/Rust/Go 编译器缺失、`node:wasi` 最小 wasm 执行。接入 `npm run test:e2e`（场景之后）。
  - **`docs/LANGUAGES.md` + `docs/LANGUAGES.zh-CN.md`** —— 权威、以实测为依据的语言支持矩阵；每个状态标注其实测来源（`LV·P1`…`LV·R3`、`ST`、`S13`/`S14`）。README（+ zh）新增 Languages 章节与链接。
  - **自检新增（门禁 71 → 75）**：python 扩展标准库（subprocess/collections/datetime/hashlib/urllib）、python 共享 FS 写/读、`python -m pip` 明确报错、`npm i -g` EACCES hint 行（网络不可达时回退为已知边界跳过）。
  - **场景 S14**（语言防回归）：5 个用户实测坑锁定防回归 —— `node && npm` 链、`node -e` 嵌套引号写文件穿透 `tsc`、`npm i -g` EACCES + hint、cwd 同步 npm install（装进项目目录）、python 真管道。现有 14 个场景。
  - **`python -m` 明确报错**（`src/engine/python-runtime.ts`）：`python -m pip ...` 报告 `pip is not available in this embedded runtime`（此前被误读为脚本文件）；`python -m <module>` 明确拒绝。

### Fixed

- **`cd /` 回到工作区根（`~`）** —— 会话 cwd 同步原本只认 `/workspace` 前缀，`cd /`（Lifo VFS 根）后会话 cwd 不更新，提示符/pwd/node 子进程留在旧目录（「回不到根目录」）。Lifo 根现在映射到工作区根（`lifoCwdToSessionCwd`：`/` → `/workspace`，`/workspace/...` 原样，Lifo 私有路径不同步；已单测）。刷新仍按设计恢复持久化 cwd；`cd /` 是一键回 `~` 的路径。
- **提示符随会话 cwd 更新（cd 现在会改提示符）** —— REPL 提示符原硬编码 `guest@succinix:~$`，`cd` 后不反映目录。浏览器现在跟踪会话 cwd（boot 后从 host `cwd` 协议取一次初值，刷新后持久化的 `/etc/succinix.cwd` 不再退化；成功的 `cd` run 结果带 `cwd` 字段时更新），并渲染目录：`/workspace` → `~`、`/workspace/proj` → `~/proj`（`sessionCwdPromptLabel`，已单测）。`cd /workspace/proj` 后提示符变为 `guest@succinix:~/proj$`。
- **P0-1 跟进：快照恢复后 30s 年龄强制不再重新武装** —— 新页面 `lastFullSaveAt` 为 0，恢复快照后空闲一直 dedup 又永不更新，`isAgeForced` 整个会话恒为 false，刷新后的等长 shell 编辑丢失窗口变成无界。`loadSnapshot` 现在把时钟归零到 `Date.now()`（回归测试直接向 IndexedDB 种子快照，断言间隔后 `reason=age` 触发）。
- **P0-2 跟进：处理后删除 `/cmd.json` 可能吞掉直接探活** —— `finally` 盲目删除文件内容；看门狗 `pingDirect` / Ctrl+C `interruptDirect`（绕过队列）在 host 忙于长 Lifo/Python 命令时写入的请求被删而非处理，看门狗可能误计失败（连续 2 次即误重启 host）。现在只在文件仍持有刚处理请求 id 时删除（`shouldRemoveCmdFile`，已单测）；更新的带外请求留给下一轮轮询。
- TASK24 复审（re-review fixes；自检门禁 67 → **71**）：四个新自检检查 ——
  `cwd persisted to /etc/succinix.cwd (browser view)`（证明会话 cwd 写入浏览器可见路径，
  即快照 + 刷新后仍存）、`env merged into node child (process.env)`（证明 `/etc/succinix.env`
  合并确实到达子进程）、`python pipe filters empty (grep 2)` 与 `python pipe keeps match (grep 42)`
  （证明 python 管道是真实的）。场景 S11 的管道检查升级为真管道断言（grep 命中保留、grep 未命中 → 空）。
- TASK24 shell 融合修复（三个真实浏览器 TS 生态坑 + TASK23 遗留）：
  - **含 shell 元字符的 node 前缀命令现在经 Lifo shell 执行**（管道/链/重定向在那里解析），链中每个 `node`/`npm`/`npx` 段从 Lifo shell 转回**真实二进制**（`src/engine/host.ts` 新增 `registerRealBinaryCommands` 覆盖浏览器内 JS 解释器 shim）。`node --version && npm --version` → 两个真实版本；`node -e "console.log(21*2)" | grep 42` → `42`（`runtime=lifo`）。纯 node 命令（无元字符）不变（直接 spawn）。
  - **Tokenizer 转义引号修复**（共享 `src/engine/tokenize.ts`，host 与浏览器自检共用）：引号内 `\"` → 字面 `"`，`\\` → `\`，单引号内 `\'` → `'`，未闭合引号抛 `unterminated quote in command`（不再静默截断）。`node -e "require('fs').writeFileSync('a.ts','import {x} from \"./m\"')"` 现写入完整引号。
  - **EACCES 可操作提示**：`npm i -g` 命中只读 `/usr/local` 时在错误输出追加 `hint: /usr/local is read-only for guest. Install locally: npm i <pkg>  (or set a user prefix: npm config set prefix ~/.npm-global)`（权限语义不变），直接 spawn 路径与 Lifo shell 转发路径均生效。
  - 自检 Shell 检查（门禁 65 → **67**）：`tokenize escape quotes`、`node pipe chain`（`... | grep 42`，runtime=lifo）、`node && chain`（两行版本）。场景 S13（TS 生态工作流：`npm i -D typescript tsx vitest` → `npx tsc` → `node dist/greet.js` → `npx vitest run` 1 passed）——现有 13 个场景。

### Fixed

- **会话 cwd 持久化双根**（TASK24 复审）：`CWD_FILE` 曾位于 node 虚拟系统根 `/etc/succinix.cwd`（只读）—— `cd` 刷新后从不存活。现为 `${process.cwd()}/etc/succinix.cwd`（与浏览器快照存放 `/etc/succinix.cwd` 的位置一致），写入前创建父目录，恢复时校验映射后的真实目录存在（`/workspace/...` → `process.cwd()/...`）。
- **`/etc` env + engine-config 双根**（TASK24 复审）：`ENV_FILE`（`/etc/succinix.env`）与 engine-config 读取（`/etc/succinix.engine.json`）也曾位于 node 虚拟根 → `env FOO=bar` 从未到达 node/python 子进程，`resultTtlMs` 覆盖从未生效。两者现在都读取 `${process.cwd()}/etc/...`。自检证明：`setEnvVar` 后，`node -e "console.log(process.env.TEST_VAR)"` 子进程能看到该值。
- **Python 假管道**（TASK24 复审）：含 shell 元字符的 python 命令静默吞掉管道/重定向段（`python -c "print(1)" | grep 2` 打印 `1` 而非空结果）。含 shell 元字符的 python 命令现经 Lifo shell 执行（同 node），每个 python 段转发到真实运行时（`node python-runtime.js`）。`python -c "print(1)" | grep 2` → 空；`python -c "print(42)" | grep 42` → `42`（runtime=lifo）。
- **Tokenizer fd 重定向形态**（TASK24 复审）：`hasShellMetaToken` 现标记粘连的 `1>` / `1>>` / `2>>` / `&>` / `&>>` 形态（此前仅 `>` / `>>` / `<` / `2>`）。
- **Python 资产路径双根**（TASK23 遗留，自检 `timeout: run`）：浏览器 `wc.fs` 根 `/` 映射到 host 进程 cwd，但 host 在 node 虚拟系统根 `/usr/lib/...` 处检查/加载 `PYTHON_RUNTIME_JS` → 一直 "assets not injected yet"，自检卡在 `cd /workspace` → node spawn。python 运行时路径现为 `${process.cwd()}/usr/lib/succinix/python/python-runtime.js`（与 `python-assets.ts` 注入位置一致），绝对脚本路径（`python /script.py`）按浏览器根解析。
- **`cd /workspace` 后 node/python spawn 卡住**（同一自检 `timeout: run` 根因，由 python 路径调查揭示）：`/workspace` 是 Lifo VFS 挂载，无真实容器路径（根只读），所以 `spawn(node, { cwd: '/workspace' })` 永不 resolve。host 现把 `/workspace/...` 映射到 `process.cwd()/...`（`spawnCwd()`）再 spawn 真实 node/python/npm 子进程；`pwd`/`cwd` 仍报 Lifo 视角 `/workspace/...`。

- TASK23 内置语言运行时系统：
  - **Python 运行时（系统资产，装不坏）**：`python` / `python3` 运行打包的 python-wasm 0.28 运行时（Python 3.11，标准库含 json/csv/re/math/os/sqlite3）作为真实 Node 子进程。`scripts/build-host.mjs` 产出 `public/python/python-runtime.js`（esbuild bundle，CommonJS 使 `__dirname` 能解析 wasm 资产）+ `python.wasm`/`python-stdlib.zip`/`kernel.wasm`/`termcap`。首用懒注入容器（`src/engine/python-assets.ts` 的 `ensurePythonRuntime`），绝不依赖用户 `npm install`，加载失败返回明确的 `python runtime failed to load: ...` 错误而不崩溃系统。交互式 REPL 与 `pip` 有意不支持（已文档化）。
  - **会话 cwd 同步（融合基石）**：host 维护会话 cwd（初始 `process.cwd()`，持久化到 `/etc/succinix.cwd`，host 启动时恢复）。Lifo 在 `/workspace` 挂载下成功 `cd` 会同步会话 cwd（`run` 结果携带 `cwd` 字段）；node/npm/npx **和** python 子进程以 `cwd = 会话 cwd` spawn（此前固定 `process.cwd()` —— `cd /ws/proj && npm install` 曾装进容器根）。`cd` 到不存在目录时会话 cwd 不变。新增 `setCwd <dir>` 协议命令用于显式同步。浏览器 `pwd` 现显示会话 cwd；Lifo 沙箱初始 cwd 是 `/workspace` 挂载，boot 时 `pwd` 一致。
  - **`lang` 命令**：列出内置语言运行时与版本（`lang` 表；`lang python` → `Python 3.11.1 (python-wasm 0.28)`；`lang node` 查询实时 node 版本；`lang typescript` 提示 `node --experimental-strip-types`）。
  - 自检新增（门禁 57 → **59**）：`python -c` 真实执行、python 标准库 import、`python3 --version`、`lang list` / `lang python` 经分发、cd 同步会话 cwd（node 子进程 cwd 跟随）、失败 cd 保持会话 cwd。实测 **65 passed, 0 failed, 5 skipped**。
  - 场景套件 S11（python 脚本工作流：`-c`、脚本文件、`python3` 标准库、管道 `python | grep`）与 S12（cd + `npm install` 落在会话 cwd；失败 cd 保持 node cwd）——现有 12 个场景。
  - **修复 dev 端口 7892**：`scripts/start-dev.mjs`（检查 7892 是否被占并先杀占用 PID 再启动 Vite）、`package.json` `dev` → `node scripts/start-dev.mjs`、`vite.config.ts` `server.strictPort: true` 防止端口漂移。
  - 快照排除 `/usr/lib/succinix`（约 13 MB python 运行时系统资产——首用重新注入，非用户数据）。

- TASK20 CI 与标准测试流水线：
  - ESLint flat config（`eslint.config.js`）—— `@eslint/js` + `typescript-eslint` recommended + 项目规则（`no-explicit-any` 为 error、无遗留 `console.log` warn 且 host 侧豁免、无未用变量/导入）；`npm run lint` 门禁为 0 errors。
  - Vitest 单测套件（`tests/`、`vitest.config.ts`）覆盖纯逻辑模块 `src/log.ts`、`persist.ts`、`services.ts`、`pkg.ts`、`motd.ts`、`config.ts`，用内存 mock FS / fake IndexedDB / 可脚本化终端客户端；v8 覆盖率门禁 **≥70%**（核心文件实测 90.62% stmts / 74% branches / 92.8% funcs / 93.46% lines）。
  - GitHub Actions CI（`.github/workflows/ci.yml`）：`check` job（lint → typecheck → 单测 + 覆盖率 → build → `verify-deploy` headless 自检）push/PR 触发，外加定时 `nightly-scenarios` job；CI 徽章加入 README。
  - `npm run test:e2e`（`scripts/run-e2e.mjs`）：构建一次，然后依次跑 `verify-deploy` → `bench` → `scenarios` —— 复用现有零依赖 CDP 脚本（无 Playwright）。
  - 可选的零依赖 pre-commit（`npm run setup:hooks` 写 `.git/hooks/pre-commit` → `scripts/pre-commit.sh`：仅对变更文件跑 tsc + eslint），README 已文档化。
- TypeScript 工具链固定到 `~6.0.3`（仅开发）：`typescript-eslint` parser 需要 TypeScript 7 移除的经典 compiler API，因此开发 typechecker 停留在 6.x 线（运行时不受影响）。

### Changed

- `verify-deploy.mjs` 自检门禁从 `>=51` 提升到 `>=57` passed（对应 TASK19 回归新增）。
- S6 场景更名为 "queue serialization correctness"——它演练的是单槽 `/cmd.json` 请求队列，不是真并发（诚实命名）。
- 新增 npm scripts：`typecheck`、`lint`、`test`、`test:coverage`、`test:e2e`、`setup:hooks`。

### Fixed

- N1：`ensureNpxPackage`（services）与 `dbStart`（commands）曾相对 Lifo VFS 根探测 `node_modules/<pkg>` 并一直报缺失 → 现探测绝对路径 `/workspace/node_modules/<pkg>`；冗余的 `npm install` + 假 WARN 消失。
- N2：persist 去重签名现包含空目录列表——仅 `mkdir` + 刷新（纯空目录变更）此前跳过 IDB 写入并丢失目录。
- N4：自检 `spawn('npx definitely-not-exist-xyz')` 现包在 try/catch 内并缩短为 2 s RPC 超时——离线 / registry 卡死不再崩溃整个自检；降级为文档化跳过。

### Added

- TASK19 场景套件：`scripts/scenarios.mjs` —— headless-Chrome/CDP 驱动的真实工作流测试套件（零新依赖，对标 `verify-deploy.mjs`/`bench.mjs`），对真实浏览器+容器跑 10 个真实场景：S1 npm 项目开发循环（预览端口真实 HTTP 200）、S2 git 操作（`pkg install lifo-pkg-git` → init/add/commit/log 带真实 commit hash）、S3 数据库全生命周期（经 tinbase `/admin/v1/sql` + `/rest/v1` 建表/插入/读取，数据跨 `db stop`/`db start` 持久）、S4 服务自启（`service enable tinbase` 刷新后仍在并 boot 为 `running`；disable 停止）、S5 多工作区隔离（文件按工作区隔离，刷新后状态保留）、S6 并发压力（3 个并行长命令——按 id 出结果不交错）、S7 大输出（`seq 1 10000` 完整、2 MB node 输出截到 1 MB、无 OOM）、S8 持久化压力（300 个文件过 `snapshot now` + 刷新，抽查内容验证）、S9 错误路径（未知命令/缺目录/CORS curl 均以英文干净报错）、S10 环境边界（`reboot` 保留文件且进程表干净）。`?scenario=1` 暴露 `window.__succinixScenario`（`run()` 镜像真实终端分发路径 + `client`/`wc`/`ports`/`saveSnapshot`）供驱动。
- `respawnWithKillFirst`（新 `src/host-restart.ts`）：先杀旧 host 再 spawn 的不变量抽成可测试助手；`main.ts` 的 `restartHost` 使用它，自检直接断言顺序。
- 自检回归（现 57 passed）：`spawn npx definitely-not-exist-xyz` 必须返回 `ok:false`（不得误报运行中进程），以及双 host 不变量（先杀后 spawn）。

### Changed

- `main.ts` 的 `?scenario=1` 驱动模式：仅场景模式暴露场景句柄，镜像 `execute()` 的分发（浏览器侧拦截 → host RPC），带结构化输出捕获。
- `startService` 在服务命令为 `npx <pkg> ...` 且 `<pkg>` 未安装时先跑 `npm install <pkg>` —— node_modules 不随快照，刷新后的自启曾与 npx 的即时下载在 30 s 端口等待内竞态（不稳定）。
- tinbase 持久化措辞诚实化：`db start` 报告数据在会话内跨 `db restart` 持久，浏览器刷新会重建 WASM store（二进制 db 文件不进入快照）；README 持久化章节同步更新。

### Fixed

- spawn 失败竞态（TASK19）：`dispatchSpawn` 现使用启动确认窗口——2 s 内非零退出的 spawn node/npm/npx 进程报 `ok:false`（如 `npx definitely-not-exist-xyz`、带语法错误的 node 脚本），而不是浏览器读到 `ok:true` + pid、稍后失败不可见。实测 npx 404 失败约 0.3–0.8 s，窗口内舒适；健康后台服务（tinbase、http 服务器）超过窗口且调用方无感知。
- 空目录现可持久化：`collectDir` 记录空目录、`loadSnapshot` 重建它们，默认 `main` 工作区（空目录）切到另一工作区再刷新后不再消失。
- 快照现整体排除 `.tinbase` 树：PGlite WASM 数据库（`/admin` `.tinbase/db`）是二进制，纯文本的部分恢复会损坏它——刷新后 tinbase 启动即崩。排除后服务可靠地建新 store（数据刷新后丢失，如实文档化）。

### Added

- Vercel 部署适配：根 `vercel.json` 在**每个**路径（`/(.*)` —— 含 `assets/*` 与 `host.js`）下发 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless`，配 `framework: vite`、`buildCommand: npm run build`、`outputDirectory: dist`；`scripts/verify-deploy.mjs` —— 本地部署就绪门禁（build → `vite preview` → 断言 `/`、`/host.js` 与 JS bundle 的 COOP/COEP 头 → headless Chrome 跑 `?test=1` 自检，门禁 `>=51 passed` 与 `0 failed`）；README **部署（Vercel）**章节（一键 dashboard 导入、`vercel deploy` CLI、自定义域名提示、COOP/COEP 理由、按 origin 的 IndexedDB 数据分域）+ 已知边界条目（部署宿主必须支持自定义响应头）。

### Changed

- 性能：`scripts/bench.mjs` —— 可复现的 headless-Chrome 基准（boot、Lifo/Node 命令往返、快照 N=200/1000、xterm 大输出），输出 JSON 供 CI 复用；实测 boot ~3.8s → ~2.5–2.9s（−25–35%）与命令往返 ~156 ms → ~80 ms（−48%）。优化：host.js 拆成轻量 daemon（`public/host.js`，5 KB）+ 懒加载 Lifo 内核（`public/lifo-core.js`，~1 MB），host 启动不再解析整个 bundle；host 轮询间隔 120→50 ms；浏览器 RPC 轮询 150 ms 固定 → 25 ms 自适应（长命令指数退避到 150 ms）；boot 覆盖层淡出 400→200 ms；boot ping 就绪重试 300→100 ms；`?bench=1` 仅测量用途暴露内部句柄。
- 单命令输出上限约 1 MB（保留尾部）以约束容器内存与结果文件大小；大输出截断。
- Boot 日志诚实化：Lifo 内核懒加载并在后台预热，因此 boot 行写 "Starting Lifo kernel"（而非 "Started"）直到首个 Lifo 命令确认就绪。

### Fixed

- Host 重启双 host 竞态：重拉 `host.js` 前先杀旧 host 进程（经保留的 `WebContainerProcess` 句柄），防止两个 host 同时轮询 `/cmd.json`。
- `spawn` 失败竞态：`dispatchSpawn` 把 `ok:true` 写入延后一拍，同步 spawn 错误（ENOENT）以 `ok:false` 呈现给浏览器，而非在浏览器已读到成功后覆盖；失败 spawn 也在进程表标记 `exited`（失败 spawn 不会触发 `close` 事件）。
- M1 残留：`findServiceProcess` 现以服务记录的启动端口（`activePorts`）渲染匹配针，而非当前 `preview-port`——服务运行时改 `preview-port` 不再误报 stopped。
- `boot-ui.ts` 标记映射：`[preview]` 标记的隐式 `'ok'` 回落现改为显式 marker→kind 查找表（移除冗余隐藏分支）。
- Host 重启先杀旧 host 进程（单 host 不变量）；spawn 失败及时报 `ok:false` 而非被掩盖。

## [0.2.0] — 2026-08-05

### Added

- 生产级界面：英文 UI、暗橙主题、JetBrains Mono、系统自检格式、AGENTS.md 设计规则。
- 内存管理：`free`/`top` 内存概览（诚实沙箱估算）、`reboot`（浏览器重载，持久化数据存活）、`shutdown`、`cache`/`cache clear`（仅可重建缓存——绝不触碰 `/workspace`）。
- 工作区分拆：多个隔离工作区（`/ws/<name>`），由 `workspace` 命令族管理（`create`/`switch`/`rm`）；当前工作区记录在 `/ws/.current` 并跨刷新持久；首次 boot 初始化默认 `main` 工作区。
- 系统配置：`env` 管理持久环境变量（`/etc/succinix.env`，spawn 时合并进真实 Node 子进程）与 `settings` 管理持久系统设置（`/etc/succinix.settings`：tinbase `preview-port` 默认 3001、boot 使用的 `default-workspace`、实时生效于终端的 `font-size`）。
- 服务管理：`service` 命令族（`list`/`start`/`stop`/`status`/`enable`/`disable`）构建于既有 `spawn`/`ps`/`kill` + 端口注册表之上，带声明式服务定义（`/etc/succinix.services`，`name|command|port`，`${PORT}` 占位符从 `preview-port` 解析）与 boot 自启（`/etc/succinix.autostart`，boot 时声明式重启——非守护进程，无崩溃自愈）。
- 日志系统（journald 风格）：持久日志写入容器 FS 的 `/var/log/succinix.log`（随快照跨刷新持久；自动截断保留约 200 KB 尾部），采集 boot 事件（`BOOT`）、命令执行（`INFO` —— `cmd: <command> exit=<code> runtime=<node|lifo|browser|protocol>`）、服务事件（`INFO`/`WARN`）、快照事件（`INFO`）与错误（`ERROR`）；`log` 命令族（`log` 最近 20 行、`log -n <count>`、`log boot`、`log clear`）。交互式 `log -f` 延后（POC）。
- 虚拟网络视图：`netstat` 列出虚拟监听端口（端口注册表渲染为 `Proto  Local Address  State`，`tcp 127.0.0.1:<port> LISTEN`；`netstat -p` 附加关联进程——按进程命令中的端口号匹配，无匹配 `-`），`ip addr` 显示浏览器虚拟网络身份（`lo: virtual loopback`、`eth0: <preview-domain> (virtual)`）。一切诚实标注 `virtual`；不编造接口、IP 或连接。
- 系统信息与登录横幅：`uname` 报告诚实的浏览器原生系统身份——汇总行 `Succinix 0.2.0 js-runtime+webcontainer <api-version> <arch>`（内核标识 `js-runtime+webcontainer`，绝不冒充 Linux 内核）、`-a` 全部字段含主机名/OS、`-r` 是 `@webcontainer/api` 运行时版本、`-m` 是从 UA 提取的架构（缺失时 `unknown`）——`motd` 查看/编辑持久登录横幅 `/etc/succinix.motd`（`motd <text>` 设置，`motd reset` 恢复默认欢迎行，每次 boot 打印）。
- 包管理：`pkg` 命令族（`list`/`search`/`install`/`remove`/`info`）统一两条真实通道——**lifo**（`lifo list`/`search`/`install`/`remove`，Lifo 扩展包如 `lifo-pkg-git`）与 **npm**（真实 Node npm）。来源自动判定：npm 上存在 `lifo-pkg-<name>` → lifo，否则 npm；同名冲突 lifo 优先。`pkg list` 合并两通道并带 `SOURCE` 列，`pkg search` 合并两个搜索，`pkg install`/`remove` 回显真实命令输出。npm 列表读取 `node_modules` 顶层目录（顶层直装简化——含容器预装运行时依赖，不解析依赖树）。

### Changed

- 自检结果现在进入终端：boot 覆盖层淡出后，`?test=1` 在 shell 里打印 `Self-test result: N passed, M failed, K skipped`（有失败时附暗红失败列表），覆盖层消失后结果仍可见。
- host.js 经 esbuild 压缩（`minify: true`）：1,965,361 B → 1,070,913 B（−45.5%）。以完整 `?test=1` 对压缩产物通过验证；`keepNames: true` 变体（1,106,353 B，−43.7%）评估后不需要。
- RPC 客户端健壮性：所有请求经单槽 `/cmd.json` 通道串行化（修复 pkg search 并行通道竞态），只读命令（`ping`/`ps`/`cwd`）传输失败重试一次，浏览器看门狗连续 2 次 ping 失败后重注入 + 重拉 `host.js`（新进程表、WARN 日志）。
- 快照签名不再计入 `/var/log/succinix.log`（日志仍随快照；仅变更检测签名排除它），逐命令日志增长不再强制整写快照。
- `netstat -p` 的端口↔进程匹配现为结构化（`--port N` / `listen(N)` / 词边界 token）而非子串——`3001` 不再关联端口 `300`/`30010`；`processLabel` 跳过开头 `npx`/`node` 标志（`npx --yes X` → `X`）。
- Boot 顺序：`loadSnapshot` 现先于 `initLogger` 运行，消除恢复期间的日志写竞态（恢复前 boot 事件不持久化——已接受）。
- `uname -r` 运行时版本现构建时注入：Vite `define` 从 `node_modules` 读取安装的 `@webcontainer/api` 版本（替换硬编码的 `1.6.4`），`uname` 跟随依赖升级、永不过期。
- 自检覆盖：为 `uname -r` / `uname -m` 增加经命令分发路径（非直接 builder）的断言，端到端验证参数解析链。

### Fixed

- pkg search 单槽竞态：并行 `lifoSearch`/`npmSearch` 覆盖 `/cmd.json` 丢弃一个通道——现经客户端请求队列串行化。
- 包名校验：`pkg install/remove/info` 拒绝空名、空白与开头 `-`（合法：`@scope/name` 或 `[a-zA-Z0-9-_.]+`）；命令参数双重引号；`pkg install --help` 不再返回假成功。
- `detectSource` 网络回退现可见：lifo registry 不可达而改用 npm 时，消息追加 `(lifo unavailable — fell back to npm)` 而非静默切换。
- 轮询 `ps` 不再刷日志：纯 `ps` 协议查询跳过命令日志；`kill` 仍记录。

## [0.1.0] — 2026-08-05

### Added

- POC：Lifo 运行于 WebContainer 内并共享容器文件系统（无桥代码）。
- TerminalExecutor v1：统一命令路由（`node|npm|npx` → 真实 Node.js 子进程；其余 → Lifo）、带 `ps`/`kill` 的统一进程表、后台 `spawn`。
- 基于文件的 RPC 协议（`/cmd.json` → `/result-<id>.json`），每次请求独立结果文件避免写竞态。
- 产品外壳：全屏黑色终端、Ubuntu 风格 boot 序列带浏览器检测系统信息、交互式 shell 提示符。
- 端口管理：`server-ready` 注册表与 `ports` 命令。
- 数据库：`db start|status|stop` 管理 tinbase（PGlite/WASM 引擎）。
- 自检套件：`?test=1` 可访问。
- 持久化层：工作区快照到 IndexedDB（约每 2.5s 自动保存 + `pagehide` 回退），boot 恢复；`snapshot` 命令；tinbase 数据随工作区持久。
- 开源脚手架：README、CONTRIBUTING、MIT license。

### Fixed

- 文件 RPC 通道的结果覆盖竞态（异步 `close` 写入可能覆盖更新的响应）——以每次请求独立结果文件修复。
- WebContainer 上 tinbase 启动：需要 `--engine wasm`（无原生二进制）。
- `db start` 安装步骤：主机侧超时必须传 `{ timeout: 120000 }`。

### 已知边界（Known boundaries）

- CORS 限制对无 CORS 头外部站点的直接 `curl`（用 `https://r.jina.ai/<url>`）。
- Lifo VFS 不支持符号链接。
- 无 `apt` / 原生二进制（沙箱内物理不可行；Succinix 是浏览器原生 Linux）。
