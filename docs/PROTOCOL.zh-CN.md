# Succinix TerminalExecutor — 文件 RPC 协议（权威）

> 中文翻译。英文版为准：见 [PROTOCOL.md](PROTOCOL.md)
>
> 这是 Succinix 命令执行引擎（`src/engine/`）的**契约（contract）**。
> 生态使用方应能仅凭本文档构建替代客户端或 host，而无需阅读实现。仓库内实现是参考：
> `src/engine/client.ts`（浏览器侧）与 `src/engine/host.ts`（容器内 daemon）。协议版本：**1**。

## 1. 概览（Overview）

Succinix 在 WebContainer 内运行常驻 **host daemon**（`node host.js`）。
浏览器持有 **TerminalClient**，经容器共享文件系统发送命令并接收结果。
没有 socket、没有 stdin 管道、没有共享结果文件——每个请求独享一个文件。这正是命令在
交互式 stdin 已知不可靠的环境中依然可靠的原因。

```
Browser (TerminalClient)                Container (node host.js)
        │  write /cmd.json                    │
        │  ──────────────────────────────────►│  poll every 50ms
        │                                     │  dispatch command
        │  poll /result-<id>.json             │
        │  ◄──────────────────────────────────│  write /result-<id>.json
        │  read + delete                       │
```

**单槽通道（single-slot channel）。** `/cmd.json` 是单文件邮箱：同一时刻最多一个请求在途。
浏览器客户端经互斥队列串行化所有请求，host 一次处理一个请求。这是有意为之——让失败变得确定。

## 2. 请求格式（`/cmd.json`）

浏览器向 `/cmd.json` 写入一个 JSON 对象：

```jsonc
{
  "protocol": 1,        // protocol version（协议版本，v1 加入；字段缺失视为 1）
  "id": 42,             // 唯一请求 id，按客户端严格递增
  "cmd": "run",         // 取值：run | spawn | ps | kill | interrupt | cwd | setCwd | ping | exit
  "opts": {             // 命令特定选项（可选）
    "command": "...",   // 完整命令字符串（run / spawn）
    "pid": 1234,        // 目标进程 id（kill）
    "cwd": "/workspace/proj", // 目标会话 cwd（setCwd；可选）
    "timeout": 30000    // host 侧超时毫秒（run / spawn；可选）
  }
}
```

| `cmd`    | 用途                                        | `opts`               |
|----------|------------------------------------------------|----------------------|
| `run`    | 执行一条命令（统一路由）                          | `command`、`timeout` |
| `spawn`  | 启动后台长驻进程（node）                        | `command`、`timeout` |
| `ps`     | 列出进程表                                     | —                    |
| `kill`   | 终止真实子进程                                 | `pid`                |
| `interrupt` | 终止当前前台 `run` 子进程（Ctrl+C）           | —                    |
| `cwd`    | 返回会话工作目录                               | —                    |
| `setCwd` | 显式设置会话工作目录                           | `cwd`                |
| `ping`   | 存活探针                                       | —                    |
| `exit`   | 优雅关闭握手                                   | —                    |

host 每 **50 ms** 轮询 `/cmd.json`。它跟踪上次处理的 `id`，对 `id` 不是数字或等于上次值的请求
直接忽略（去重）。未知 `cmd` 值以 `{ "ok": false, "error": "unknown command: <cmd>" }` 应答。

处理完一个请求后 host **删除 `/cmd.json`**（P0-2）。`processedId` 是进程内去重，新 spawn 的
host 起步为 `-1`，因此看门狗 kill + respawn 后残留的陈旧 `/cmd.json` 会被新 host 当作新命令
真实执行一次——删除把这个窗口关掉（浏览器下一拍仍会覆盖写入，行为不变）。
删除是**选择性**的：只删「文件内容仍是刚处理的那个请求」的文件；若处理期间有绕过队列的
直接写入（`pingDirect`/`interruptDirect`）把 `/cmd.json` 覆盖成新请求，则保留它待下一轮
轮询处理（否则看门狗等不到 pong 会误判 host 失联）。

## 3. 响应格式（`/result-<id>.json`）

host 为每个请求恰好写一个结果文件，以请求 id 命名。浏览器轮询该文件、读取并**删除**它
（read-then-delete）。结果文件绝不在请求间共享，因此异步 `close` 写入永远不会覆盖更新的结果。

公共字段：

```jsonc
{
  "id": 42,            // 回显请求 id
  "ok": true,          // 整体成功
  "exitCode": 0,       // 进程退出码（run/spawn）；无进程运行时为 -1
  "stdout": "...",     // 捕获的输出（run）
  "stderr": "...",     // 捕获的错误输出（run）
  "runtime": "node",   // "node" | "lifo" —— 实际执行该命令的路由
  "kind": "pong"       // 协议命令判别器（ps/cwd/ping/exit）
}
```

各命令响应字段：

| `cmd`    | 成功形态                                                    |
|----------|------------------------------------------------------------------|
| `run`    | `{ ok, exitCode, stdout, stderr, runtime }`（成功 `cd` 时另附 `cwd` 字段，TASK23） |
| `spawn`  | `{ ok: true, pid, runtime: "node" }`（立即）；确认窗口内失败 `{ ok: false, exitCode, error, runtime }` |
| `ps`     | `{ ok, kind: "ps", processes: [{ pid, cmd, status, startTime, scope, containerId?, exitCode?, outputTail? }] }` |
| `kill`   | `{ ok, killed, message }`                                        |
| `interrupt` | `{ ok, kind: "interrupted", pid, killed, message }` —— `pid` 为数字 = 已向当前前台 `run` 子进程发 SIGTERM；`null` = 无在途可中断 run |
| `cwd`    | `{ ok, kind: "cwd", cwd }`                                       |
| `setCwd` | `{ ok, kind: "cwd", cwd }`（新的会话 cwd）                 |
| `ping`   | `{ ok, kind: "pong" }`                                           |
| `exit`   | `{ ok, kind: "bye" }`                                            |

### 中断（`interrupt`）

`interrupt` 实现浏览器 **Ctrl+C**（P5-15）。host 跟踪最近一个前台 `run` 子进程（真实 Node
子进程）的 pid；`interrupt` 向它发 SIGTERM。范围：只针对那个前台 `run`——**后台 `spawn` 服务
绝不被打断**，纯 Lifo 命令（在沙箱内运行、不在进程表里）不可中断（沙箱无 abort API）。kill
后子进程的 `close` 事件结算原 `run` 请求（其结果文件出现）并清除跟踪的 pid，浏览器在途等待
随即解除。客户端经 `interruptDirect()` 发送——直接写 `/cmd.json`、绕过串行化队列（排队的
`interrupt` 只会在它要停掉的命令结束后才执行，毫无意义）。

### 会话 cwd（`cwd` / `setCwd`）

host 维护**会话 cwd**（初始值 `process.cwd()`，持久化到 `/etc/succinix.cwd`，host 启动时恢复）。
每个真实 Node/Python 子进程都以 `cwd = 会话 cwd` spawn。当一条以 `cd` 开头的 `run` 命令在 Lifo
沙箱内成功**且**新 cwd 位于 `/workspace` 挂载下时，host 把会话 cwd 同步到该值，并把新值作为
`cwd` 字段附在 `run` 结果上。`cd` 到不存在目录时会话 cwd 不变。`setCwd` 显式设置它（绝对路径、
必须是已存在目录）——它是同一同步的显式协议形式，对客户端可选（交互式 `cd` 已自动同步）。

### TTL / 清理（prune）

host 每 **60 s** 清理陈旧的 `result-*.json` 文件（浏览器超时后放弃的请求），删除所有比结果
TTL（默认 **120 s**）更老的文件。TTL 可经在 host 启动前向 `/etc/succinix.engine.json` 写入
`{ "resultTtlMs": <ms> }` 覆盖（engine 的 `boot` 仅在传入 `resultTtlMs` 时写它）。

## 4. 命令路由（Command routing）

host 对 `run` 命令应用一条固定路由规则：

- **`node|npm|npx`**（后随空白或命令结束）→ **真实 Node.js 子进程**，经 `child_process.spawn`。
  结果 `runtime: "node"`。例外（TASK24）：若 tokenize 后的 argv 含**shell 元字符** token
  （`&&`、`||`、`|`、`>`、`>>`、`<`、`2>`、`2>&1`、`;`、`&`、`$(`，或粘连重定向如 `>file`、
  `1>out`、`&>all`）则**整条命令**经 Lifo shell 执行（管道/链/重定向在那里解析），结果
  `runtime: "lifo"`；链中每个 `node`/`npm`/`npx` 段由 host 转发给**真实二进制**（Lifo shell 的
  浏览器内 JS 解释器 shim 被覆盖）。无元字符的纯 node 命令不变（直接 spawn）。
- **`python|python3|pip|pip3`**（后随空白或命令结束）→ **真实 Node.js 子进程**，运行常驻
  Pyodide daemon（`python-daemon.js`，Pyodide 314.0.4 / Python 3.14.2）。结果 `runtime: "node"`
  （它*就是* node 子进程；路由字段保持稳定）。例外（TASK24 复审）：若 tokenize 后的 argv 含
  shell 元字符 token 则**整条命令**经 Lifo shell 执行（结果 `runtime: "lifo"`），链中每个
  `python`/`python3`/`pip`/`pip3` 段转发给**同一个常驻 daemon** —— `python -c "print(1)" | grep 2`
  → 空、`python -c "print(42)" | grep 42` → `42`。运行时是首用懒注入的系统资产——`python -c "<code>"`
  执行代码字符串，`python <script.py>` 执行脚本（绝对路径按浏览器文件系统根 = host 进程 cwd 解析），
  `python -m pip install <pkg>` 映射到 Pyodide 的 micropip。交互式 REPL 不支持（AGENTS.md 边界）；
  `pip` 经 micropip 可用。
- **其余一切** → **Lifo 沙箱**（`sandbox.commands.run`）。结果 `runtime: "lifo"`。

命令字符串以 shlex 风格 tokenizer（`src/engine/tokenize.ts`）切分：单/双引号分组空白，反斜杠
转义下一个字符（引号内 `\"` → 字面 `"`、`\\` → `\`、单引号内 `\'` → `'`），**未闭合引号抛**
`unterminated quote in command`（以 `{ ok: false, exitCode: -1, stderr: "unterminated quote in command", runtime: "node" }`
应答）而非静默截断。无变量展开。空命令以
`{ ok: false, exitCode: -1, stderr: "empty command", runtime: "lifo" }` 应答。

### 错误语义（Error semantics）

| 条件                       | 响应                                                            |
|---------------------------------|---------------------------------------------------------------------|
| 未知协议 `cmd`          | `{ ok: false, error: "unknown command: <cmd>" }`                    |
| Node 子进程未找到       | `{ ok: false, exitCode: -1, stderr: String(e), runtime: "node" }`   |
| Node 子进程超时       | 子进程被杀；`{ ok: false, exitCode: -1, stderr: "node subprocess timed out after <ms>ms, killed", runtime: "node" }` |
| Node/npm stderr 含 `EACCES` + `/usr/local` | 原 stderr，换行后追加 `hint: /usr/local is read-only for guest. Install locally: npm i <pkg>  (or set a user prefix: npm config set prefix ~/.npm-global)`（TASK24） |
| Python 资产未注入      | `{ ok: false, exitCode: -1, stderr: "python runtime failed to load: assets not injected yet ...", runtime: "node" }` |
| Lifo 命令抛错             | `{ ok: false, exitCode: -1, stderr: <前 200 字符>, runtime: "lifo" }` |
| 对非 node 命令 `spawn` | `{ ok: false, error: "spawn only supports node/npm/npx background processes ...", runtime: "lifo" }` |
| `kill` 表外 pid       | `{ ok: false, killed: false, message: "process <pid> not in process table; Lifo-side processes are list-only (kill not supported)" }` |
| `setCwd` 路径非法        | `{ ok: false, error: "setCwd: cwd must be an absolute path ..." / "setCwd: not a directory: ..." }` |

**输出上限（output cap）。** 每条命令的 `stdout` 与 `stderr` 各自上限约 1 MB（保留尾部）。
host 在 2 倍上限处增量裁剪，并在落定结果时做最终截断，因此即使超大输出结果文件也有界。

## 5. 进程模型（Process model）

- **`spawn`** 启动后台长驻进程（仅 node 系；Lifo 无后台概念）。host 立即返回 pid，进程输出
  流入其进程表条目（`outputTail`，最近约 500 字符）。
- **启动确认窗口（2 s）。** 2 秒内非零退出的 spawn 进程报告为**失败**（`ok: false`）——例如
  不存在的 `npx` 包，或带语法错误的 node 脚本。健康服务（tinbase、http 服务器）越过窗口且
  调用方无感知。
- **进程表**（`host-procs`）：每个真实子进程注册为 `{ pid, cmd, status: running|exited,
  startTime, exitCode?, outputTail? }`。表上限 100 条，清理最老的 exited 条目。
- **进程归属**（TASK-CISOL）：每个 `ps` 条目额外携带 `scope`（`system` | `container` |
  `unknown`），`scope=container` 时带 `containerId`（如 `c-1`）。判定为启发式：命令命中
  Succinix 系统资产（`node host.js`、`node python-daemon.js`、任何 `/usr/lib/succinix/`
  路径）→ `system`；否则子进程 spawn cwd 落在容器根（`.../c-<id>`，即调用方执行
  `cd /workspace/c-<id> && <cmd>` 时的形态）→ `container` + `containerId`；其余 → `unknown`。
  均为新增字段，既有 `pid/cmd/status/...` 契约不变。
  - ⚠️ **不是安全边界。** `scope` 由命令串 + spawn cwd 推导，可被伪装（任何用户进程只要命令
    长得像系统资产就会被标为 `system`）。仅用于 **UI 展示与查询过滤**——不可作为权限 / 隔离 /
    kill 拦截的信任依据。需要硬语义时改显式声明制（spawn 时调用方显式传 `scope`）。
- **`kill`** 向表条目发 SIGTERM；子进程 `close` 事件后条目翻转为 `exited`。失败 spawn（如
  ENOENT）显式标记 `exited`，因为该情况下 `close` 永不触发。
- **Lifo 侧进程仅可列出**——它们不在表中，`kill` 报 "not in process table" 消息而非假装终止。

## 6. 端口事件（Port events）

engine 自身不隧道端口；它把 WebContainer 的端口生命周期中继给宿主应用：

- `server-ready (port, url)` → `onServerReady(port, url)`（宿主应用记录预览 URL）。
- `port (port, "close")` → `onServerClosed(port)`（宿主应用移除该 URL）。

这些回调由 engine 的 `bootEngineHost`（`src/engine/index.ts`）在拉起 host 时注册。它们是
应用级通知，不属于文件 RPC 线上协议。

## 7. 超时 / 重试（Timeout / retry）

### 浏览器侧（客户端）等待

| 调用                         | 默认等待 |
|------------------------------|--------------|
| `exec` / `terminal`          | 30 s         |
| `spawn`                      | 5 s          |
| `pingDirect`（看门狗）      | 30 s         |

等待即 **RPC 轮询预算**——浏览器等待结果文件的时间。浏览器放弃后 host 可能仍在工作；
陈旧结果由 TTL 清理。

### host 侧命令超时

| 路由      | 默认超时 | 覆盖                     |
|------------|-----------------|------------------------------|
| Lifo       | 25 s            | `run` 上的 `opts.timeout`      |
| Node 子进程 | 30 s            | `run` 上的 `opts.timeout`      |

超时后 host 杀死 node 子进程并落定结果；浏览器看到带 `timed out` stderr 消息的非零退出。

### 重试（Retry）

仅**幂等、只读**的协议命令 —— `ping`、`ps`、`cwd` —— 在 RPC 失败时重试一次（重发安全）。
`run`、`spawn`、`kill`、`exit` 客户端从不重试。

### `pingDirect` 看门狗

host 存活看门狗以绕过互斥队列的直接 `ping` 探测 host，因此持队列的长命令无法推迟存活检测。
通道繁忙时探测跳过（中性）：若存在排队未开始的请求，或上次 `/cmd.json` 写入在 **250 ms**
host 轮询余量内（host 可能尚未读取），则跳过。`true` = pong、`false` = 超时（host 不可达）、
`null` = 跳过。

## 8. 客户端行为（Client behavior）

- **串行化（serialization）。** 所有请求经一个 FIFO 队列；超时请求不破坏链。
- **自适应轮询（adaptive polling）。** 浏览器从 25 ms 起轮询结果文件，指数退避到 150 ms 上限，
  因此快命令快速返回、长命令不锤击文件系统。
- **读后删（read-then-delete）。** 结果文件成功读取后立即删除。
- **协议版本（protocol version）。** 每个请求携带 `protocol: 1`。字段缺失视为版本 1。host
  **不**严格拒绝版本不匹配——未知字段被忽略，因此版本是咨询性而非硬门禁。未来改动应保持向后
  兼容；破坏性改动会把本文档版本号升级，客户端适配新响应形态，而非被直接拒绝。

## 9. Engine 公开 API（摘要）

engine 经 `src/engine/index.ts` 消费：

- `TerminalClient` —— 文件 RPC 客户端（丰富：`terminal`、`exec`、`spawn`、`pingDirect`）；
  Succinix 前端使用。
- `createTerminalExecutor(): TerminalExecutor` —— 为生态使用方准备的干净命令风格门面：
  `boot(wc, opts)`、`exec(command, opts)`、`spawn(command, opts)`、`listProcesses()`、
  `kill(pid)`、`ping()`、`dispose()`。
- `bootEngineHost(wc, client, hooks)` / `waitForHostReady(client)` —— 门面与 Succinix boot
  序列共享的底层 boot 助手。

`TerminalExecutor.exec` 在 RPC 等待超时时返回 `{ ok: false, timedOut: true }` 而非抛异常
（底层 `TerminalClient.exec` 仍抛）。`spawn` 返回完整 `ExecResult`（`{ pid }` 的超集），调用方可
读取 `ok`/`runtime`/`error`。

打包/内嵌设计见 [SDK.zh-CN.md](SDK.zh-CN.md)，参考实现见 `src/engine/`。

## 10. 已知边界（Known boundaries）

这些是环境/协议的有意限制：

- **交互式 stdin** 在 WebContainer 中不可靠——文件 RPC 替代它。`log -f` 与 REPL 风格进程
  不支持。这也是 `python` 没有交互式 REPL 的原因（用 `python -c "<code>"` /
  `python <script.py>` / `python -m pip <cmd>`）。`pip` 经 Pyodide 的 micropip 可用
  （纯 Python wheel 经 NODEFS site-packages 刷新后仍在；编译 wheel 如 numpy 刷新后需一次
  `pip install`——文本快照不带 `.so` 文件，见 `docs/LANGUAGES.md`）。
- **会话 cwd 同步仅覆盖 `/workspace` 挂载**：Lifo 进入 VFS 私有路径（如 `/tmp`、
  `/home/user`）的 `cd` 在 Lifo 内成功，但无 host 文件系统等价物，因此会话 cwd 保持不变
  （Node/Python 子进程保持上次同步的 cwd）。
- **CORS** —— 对无 CORS 头站点的 `curl` 失败；用 `https://r.jina.ai/<url>`。
- **符号链接 / 硬链接** 不受 Lifo VFS 支持。
- **1 MB 输出上限** —— stdout/stderr 超过 1 MB 仅保留尾部。
- **Lifo 内核懒加载** —— `host.js` 保持轻量；约 1 MB 的 `lifo-core.js` bundle 在首个 Lifo
  命令时动态加载（带 150 ms 后台预热）。首个 Lifo 命令可能比后续慢。
- **单槽通道** —— 无真并发；并行命令串行化。
