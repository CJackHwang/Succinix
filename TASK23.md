# WebUnix — TASK23：内置语言运行时系统（融合感 + 装不坏）

## 背景与实测结论（本任务的设计依据，全部容器内实测）

**坑点（生产环境真实会遇到，实测）**：
1. 🔴 **npm install 的包不稳定**：同容器会话内装好的 `node_modules/python-wasm` 后来消失（`nm: false`），npx 第二次报 "was not found and will be installed"——依赖用户 npm install 的运行时不可靠
2. 🔴 **npm 装到容器根而非用户项目目录**：node 子进程 cwd 固定（host 的 process.cwd()），Lifo 的 `cd` 不影响它——用户在 `/ws/proj` 里 `npm install` 会装到根 node_modules（TASK19 已知边界 #5）
3. 🟡 **wasm 版本兼容**：Pyodide 314 失败（`unknown section code #0x44`，wasm 新特性 WC 的 V8 不支持）；**python-wasm v0.28 实测跑通（Python 3.11.14）**
4. 🟡 **node_modules 被快照排除**：刷新后用户装的包丢失

**关键设计决策**：语言运行时 = **系统资产**（构建时打包、boot 时注入容器，像 lifo-core.js 一样），**零安装感、装不坏**；用户 npm install 只用于项目依赖场景。

## 需求

### 1. 会话 cwd 同步（融合基石，host 侧 + 浏览器侧）

现状：node/npm/npx 子进程固定用 host 的 process.cwd()（容器根），Lifo 的 `cd` 只影响 Lifo 内部。用户 `cd /ws/proj && npm install` 装错位置——**这是"融合感"最大破绽**。

- host 维护**会话 cwd**（初始 = process.cwd()）：
  - `cd <dir>` 命令（Lifo 已有）执行成功后，host 同步更新会话 cwd（新增协议字段：cmd 结果里带 `cwd`，或专门的 `setCwd` 协议命令）
  - node/npm/npx 子进程 spawn 时用 `cwd: 会话cwd`（child_process.spawn 的 cwd 选项）
  - 会话 cwd 持久化到 `/etc/webunix.cwd`（随快照）——刷新恢复
  - `pwd` 命令显示会话 cwd
- 边界：Lifo 的 cd 与 node cwd 现在同步；`cd` 到不存在目录 → Lifo 报错，host cwd 不变
- 路由规则不变（node|npm|npx 前缀判断不变，只改 spawn cwd）

### 2. 内置语言运行时系统（`src/engine/lang.ts` + host 资产）

**运行时注册表**（系统内置，非用户安装）：

| 语言 | 命令 | 实现 | 状态 |
|------|------|------|:---:|
| node/npm/npx | node | 真 Node 子进程（现有路由） | ✅ 已有 |
| **python** | python / python3 | **python-wasm v0.28 打包为系统资产** | 🆕 本任务 |
| typescript | 由 node 直跑（`node --experimental-strip-types`） | node 22 原生支持 | 🆕 验证 |

**python 实现**：
- 资产：`scripts/build-host.mjs` 新增打包 `python-runtime.js`（python-wasm 的 node 入口 + wasm 资产内联/base64，或独立 .wasm 文件随 public/ 发布）——**复用 lifo-core.js 的懒加载模式**
- host 新增 `python` 命令：spawn 一个 node 进程加载 python-runtime → 执行：
  - `python -c "<code>"` → 执行代码
  - `python <script.py>` → 执行脚本文件（路径解析用会话 cwd）
  - 无参数 → 进入 REPL？（**不做**——交互 stdin 边界，README 注明；给出 `python -c` 用法）
- 路由：`python` 前缀加进 node 系路由（真 node 子进程跑 runtime）或单独命令——**选单独命令**（python 需要专用启动逻辑：加载 runtime 再执行）
- 标准库：python-wasm 自带标准库（json/csv/re/math/os/sqlite3 等——规格实现时验证清单，输出支持矩阵）
- **融合**：python 命令的 stdout/stderr/退出码走标准 ExecResult；管道 `python -c "..." | grep xxx` 可用（python 是 node 子进程，输出进结果流）
- **装不坏**：python 不依赖用户 npm install（资产注入）；runtime 加载失败 → 明确错误 `python runtime failed to load: <原因>`，系统不崩

**typescript 验证**：`node --experimental-strip-types script.ts` 能否跑（node 22 支持）——验证后 `ts` 或 `tsx` 命令（脚本直跑）；失败则 README 注明

### 3. 安装体验与装坏保护

- 系统语言（python）**永远可用**：boot 时资产注入，用户无需安装、无法装坏
- 用户 npm install（项目依赖）：配合 cwd 同步装到当前目录；失败（网络/wasm）→ 明确错误信息 + 系统不崩 + 提示重试
- `pkg` 命令不变；新增 `lang` 命令（可选）：`lang` 列出内置语言与版本（`lang python` → `Python 3.11.14 (python-wasm 0.28)`）
- 快照排除规则不变（node_modules 仍排除——系统语言靠资产，用户项目依赖可重装）

### 4. 自检 + 场景

- 自检新增：`Languages: python -c`（真实跑 python 断言输出）、`Languages: lang list`
- scenarios.mjs 补 S11：python 脚本工作流（写 .py → python 跑 → 输出断言）；S12：cd + npm install 装到会话 cwd（验证 cwd 同步）
- 门禁：自检 ≥57（+2 新项）+ lint/tsc/build/无 emoji

### 5. 文档

- README：Languages 特性（python 内置 + 版本 + 使用示例）；Known Boundaries 更新（python REPL 不做、pip 不可用——python-wasm 无 pip，注明）
- PROTOCOL.md：setCwd/cwd 字段补进协议文档
- CHANGELOG

## 保留项

- 文件 RPC 协议形态（setCwd 是**新增可选字段/命令**，向后兼容）；路由规则（node 系不变，python 是新增）；spawn/ps/kill/端口/tinbase/主题/COOP/COEP 不变
- 运行时依赖不新增（python-wasm 作为**构建时资产**打包，不进 dependencies——评估：如果必须进 dependencies 则放 devDependencies + 构建产物）
- REPL/交互 stdin 不做；pip 不做

## 质量门禁

- tsc 0 错 / lint 0 / vitest 全过 / build（含 python-runtime 资产）/ 自检 ≥59 / grep 无 emoji
- 浏览器实测：python -c / python 脚本 / 管道 / cwd 同步（cd + pwd + node 读 cwd）

## 开始

先读 `src/engine/host.ts`（路由/spawn/cwd 语义）、`src/engine/client.ts`（协议）、`scripts/build-host.mjs`（资产打包模式）、`src/commands.ts`、`AGENTS.md`，然后实现。完成后输出报告：坑点应对清单（4 条如何解决）、python 标准库支持矩阵、cwd 同步实现、自检数字。
