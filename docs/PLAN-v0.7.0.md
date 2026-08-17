# PLAN: Succinix v0.7.0 Browser-native Linux 工程化与 Userland 生态升级

> **Status**: Proposed（2026-08-16）
> **目标版本**: `0.7.0`
> **性质**: 允许公开 API、内部协议和持久化格式发生 breaking change
> **合并来源**: Browser-native Linux 工程化、Linux Userland 生态扩展、稳定性/性能升级三份计划
> **规范优先级**: `AGENTS.md` 英文版 > 本计划 > 其他说明文档

---

## 0. 一句话定位

> **Linux-compatible userland workflows inside WebContainer, not a simulated Linux kernel and not a browser-side assembly of Linux-looking features.**

v0.7.0 将 Succinix 从功能完整的 POC/早期产品推进为可长期运行、可嵌入、可观测、可恢复、可由第三方扩展的浏览器原生 Linux userland。

---

## 1. 架构宪法

### 1.1 WebContainer 是执行世界

- WebContainer 是运行时、命令、文件、进程、服务、包、实例与交互应用的唯一事实源。
- `node host.js` 运行在 WebContainer 内；`lifo-core.js` 由 host 动态加载，Lifo Sandbox 也在该 WebContainer 内执行。
- Lifo `/workspace` 挂载到 host `process.cwd()`，与真实 Node、Pyodide NODEFS 和浏览器 `wc.fs` 共用同一棵文件树。
- 新能力必须首先尝试实现为 WebContainer/Lifo userland 命令、package、runtime 或 service。
- 禁止在浏览器侧另建一套文件系统、命令实现、进程表、服务表、包状态或编辑器状态。

### 1.2 浏览器是控制/设备平面

浏览器仅负责：

- WebContainer boot 与环境校验；
- xterm 渲染、focus、键盘、paste 和 resize 事件；
- IndexedDB、Storage Estimate、Visibility/Page Lifecycle、preview URL 等只有浏览器拥有的 Web API；
- 浏览器↔WebContainer 的轻薄传输。

轻薄传输只传递数据和设备事件，不拥有业务语义。

### 1.3 人类终端与程序化执行分轨

```text
人类终端：
browser xterm
  -> thin terminal transport
  -> WebContainer host RpcTerminal implements Lifo ITerminal
  -> Lifo Shell (started once by Sandbox.create({ terminal }))
  -> Lifo-native commands/packages and separately supported runtime adapters

程序化执行：
TerminalExecutor / dsh / agent
  -> /cmd.json
  -> WebContainer host
  -> Lifo commands.run() or real runtime adapter
  -> /result-<id>.json
```

两条入口必须共用同一 `SandboxContext`、cwd/env、CommandRegistry、ProcessRegistry、ServiceRegistry、PackageRegistry 和文件系统，不维护并行状态。

### 1.4 交互应用复用 Lifo 原生终端能力

`@lifo-sh/core@0.10.8` 根入口导出 `ITerminal`，并公开 command stdin/raw-mode 契约。v0.7 必须复用而不是重新造一套编辑器协议：

- `ITerminal.write/writeln/onData/cols/rows/focus/clear`；
- `CommandContext.stdin` 与 `setRawMode`；
- 内部 `TerminalStdin.read/readAll/rawMode` 为上述公开契约提供实现，但没有从包根导出，第三方不得直接依赖；
- streaming `onStdout/onStderr`；
- AbortSignal；
- Shell 行编辑、history、job control、paste queue；
- 实时 `LINES`/`COLUMNS` 和全屏命令重绘。

`vi`、`nano`、未来数据库 console、Git TUI、WASM TUI 和第三方交互工具都必须作为 WebContainer 内 Lifo package/command 运行，不存在 UI-only 特殊包。

---

## 2. 保留边界与版本决策

必须保留：

- `/cmd.json -> /result-<id>.json` 独立结果文件 RPC，不恢复单结果文件。
- `node|npm|npx` 使用真实 WebContainer Node 子进程；混合 shell chain 仍由 Lifo 解析并转发真实 runtime。
- `python|python3|pip|pip3` 使用内置 Pyodide daemon，首次使用懒加载。
- Vite 开发端口 `7892`、COOP/COEP 和 Chromium-only 约束。
- `@lifo-sh/ui` 继续 external；WebContainer host 不访问 DOM，现有 browser xterm 是 Lifo `ITerminal` 的远程设备。
- UI English-only、无 emoji、dark amber、JetBrains Mono。
- 不实现真实 kernel、apt、ELF/native binary、权限隔离、`chmod` 语义、symlink/hard link、真实入站网络。
- 实例/用户隔离是组织性隔离，不是安全边界。
- 通用真实 Node/Python 子进程 PTY 不因 Lifo 终端接入自动获得；必须单独实现、单独验证。
- v0.6 snapshot 不自动迁移；v0.7 使用新数据库和新格式，不删除旧数据。
- 不自动 npm publish；实际发布是 release owner 行为。

---

## 3. 依赖与供应链升级

采用已确认的激进升级方案，但每一批依赖必须独立通过回归后才进入下一批：

| 依赖 | 当前 lock | v0.7 目标 |
| --- | ---: | ---: |
| `@lifo-sh/core` | `0.10.8` | `0.10.10` 精确锁定 |
| `browser-metro` | `1.0.34` | 随 Lifo 锁定 `1.0.36` |
| Vite | `8.2.0` | `8.2.1` |
| esbuild | `0.28.1` | `0.28.2` |
| ESLint | `10.8.0` | `10.8.1` |
| `typescript-eslint` | `8.66.0` | `8.67.0` |
| `@types/node` | `26.1.2` | `26.2.0` |
| TypeScript CLI | `6.0.3` | `7.0.2` |
| `globals` | `16.5.0` | `17.11.x` |
| `nanoid` | 传递依赖 `3.3.17` | `overrides` 强制 `>=3.3.18` |

TypeScript 双轨：

- TS7 原生 CLI 执行 `npm run typecheck`；
- TS6 API 兼容包供 `typescript-eslint` 使用；
- 新增 `npm run typecheck:legacy`；
- CI 同时通过 TS7 和 TS6；
- 任何依赖升级必须记录包版本、发布日期、导出/类型差异、bundle hash、engine asset hash、测试与 benchmark 结果；
- `npm audit --audit-level=high` 必须无 high/critical。

---

## 4. WebContainer-native 终端与 Lifo Shell 融合（P0）

### 4.0 先行可行性门禁

在迁移浏览器 Shell 或承诺稳定 `vi`/`nano` 前，先完成最小纵向 spike：

```text
xterm -> terminal transport -> RpcTerminal -> Sandbox.create({ terminal })
      -> Lifo Shell -> minimal raw-mode full-screen editor
```

门禁必须在真实 Chrome + WebContainer 中验证连续输入、paste、ANSI burst、Ctrl 键、Unicode、动态 resize、保存退出、dispose、reconnect、host respawn 和旧帧丢弃，并测量按键到回显 P95。文件 mailbox 是可靠基线；若无法达到延迟预算，可替换为等价双向流，但不得把编辑器或 Shell 状态迁回浏览器。只有该门禁通过后，才进入正式 Shell 迁移及 `vi`/`nano` 稳定交付。

### 4.1 移除浏览器并行 REPL

当前 `SuccinixTerminalSession` 在浏览器侧处理行编辑、history、Tab、本地命令和队列，再把完整命令通过文件 RPC 发往 headless Lifo。v0.7 将该主人类终端迁入 Lifo：

- browser xterm 不再解析 shell line；
- 行编辑、history、completion、Ctrl+C、raw mode、jobs、prompt 由 Lifo Shell 管理；
- 浏览器 local handler 中的标准命令迁入 Lifo/host command adapter；
- 纯系统管理入口收口到 `succinix ...`；
- SDK/dsh 的非交互 `exec()` 仍使用文件 RPC，不被人类终端重构破坏。

### 4.2 WebContainer 内 `RpcTerminal`

在 `host.js` 执行世界内实现：

```ts
interface RpcTerminal extends ITerminal {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  writeln(data: string): void;
  onData(callback: (data: string) => void): void;
  focus(): void;
  clear(): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}
```

`RpcTerminal` 只做终端帧与设备事件转发；不保存文件、编辑内容、命令历史或应用状态。

终端传输与 `/cmd.json` 批处理 RPC 分离，必须支持：

- sessionId + instanceId + boot nonce；
- 单调 input/output sequence；
- 按 xterm `onData` 事件批量输入；
- 最多 16 ms 或 32 KiB 的输出合并；
- resize/focus/clear/control frame；
- reconnect 与 last-ack replay；
- bounded queue 与 backpressure；
- host respawn 后旧 nonce 的帧必须丢弃；
- session dispose 后清理所有邮箱、timer 和 callback。

实现以 session-scoped WebContainer 传输 mailbox 为可靠基线，路径位于运行时排除区，不进入 snapshot。如浏览器实测证明文件 mailbox 无法达到延迟门禁，可以替换为等价双向流，但 `RpcTerminal` 和上层语义不变。

### 4.3 Lifo 交互 Shell 生命周期

- 每个 instance 创建独立 Sandbox + `RpcTerminal`；
- `Sandbox.create({ terminal, cwd, env, mounts })` 会创建并启动人类 Shell；同一 Sandbox 不得再次调用 `sandbox.shell.start()`，避免重复注册输入与 Shell 进程；
- 非交互 `commands.run()` 与人类 Shell 共用相同 sandbox，但受每实例 scheduler 管理，禁止 cwd/env 竞态；
- dispose 时终止前台命令、后台 job、终端传输和 Sandbox；
- HMR/fiber reload 只重新 attach browser device，不重启 page-level host/Sandbox；
- host respawn 时显式中断旧交互 session，启动新 nonce，恢复 cwd/env/package/service 状态。

### 4.4 `vi`/`nano` 与第三方 TUI

- `vi`/`nano` 作为 Lifo userland package 安装或随系统预置；
- 输入仅依赖公开的 `CommandContext.stdin`；
- raw key 使用 `setRawMode(true)`；
- 画面通过 ANSI stdout 输出；
- 行列使用 Lifo 实时 `cols`/`rows`；
- 文件直接读写 Lifo VFS/共享 `node:fs`；
- PID、Ctrl+C、exit code、cwd、instance、snapshot dirty 进入统一模型；
- 第三方 package 使用完全相同的 command/package/terminal 协议，不需要 browser plugin 特判。

稳定验收至少覆盖：新建/打开/修改/保存/放弃、搜索、Ctrl+C、resize、Unicode、大文件、多实例、host respawn、refresh snapshot 恢复和无残留 timer/session。

---

## 5. RPC、并发与实例模型（P0）

### 5.1 文件 RPC v2

保留协议路径，拆分请求投递和结果等待：

- `/cmd.json` 只负责投递，host 确认读取后可发送下一请求；
- `/result-<id>.json` 独立返回最终结果；
- 请求带 `protocolVersion`、`bootNonce`、`instanceId`、runtime hint；
- ID 使用 session/random/time 前缀，不从页面刷新后重用 `1,2,...`；
- host 使用有界 processed-ID set；
- 结果 temp-write + rename；
- malformed JSON、非法 ID、未知版本返回结构化错误，不写 `result--1.json`；
- 仅 `ping/ps/cwd` 等幂等请求允许重试；
- watchdog/Ctrl+C 使用优先级队列，不覆盖在途 `/cmd.json`；
- 记录 queue/host/poll/total 四段时间。

```ts
interface RpcTiming {
  queueMs: number;
  hostMs?: number;
  resultPollMs: number;
  totalMs: number;
}
```

### 5.2 per-instance SandboxContext

将全局 `sandboxPromise` 改为：

```ts
Map<InstanceId, SandboxContext>
```

每实例独立：

- Sandbox/Shell/RpcTerminal；
- cwd/env/history/jobs；
- ProcessRegistry/ServiceRegistry/PackageRegistry；
- terminal session 与 AbortController；
- snapshot/persist context；
- diagnostics/metrics namespace。

页面级只共享 Lifo code bundle、WebContainer 基础能力和系统 runtime assets，不共享 shell 可变状态。

### 5.3 路径与 cwd/env

- 默认用户 `guest`，HOME `/home/guest`；
- 统一挂载 `/workspace`、`/tmp`、`/home/guest`；
- 使用单一 canonicalizer 处理 `..`、重复 slash、trailing slash、空路径和边界前缀；
- Node/Python 绝对路径与 `--flag=/workspace/file` 统一映射；
- Lifo 私有路径无真实 Node/Python 对应时 fail-closed，不静默回落旧 cwd；
- 任意 compound command 结束后从真实 `sandbox.cwd` 同步会话 cwd，不仅匹配 `^cd`。

---

## 6. 进程、信号与服务（P0/P1）

统一真实 Node、Python daemon、Lifo ProcessRegistry 与交互应用：

```ts
interface ProcessRecord {
  pid: number;
  runtime: 'node' | 'python' | 'lifo' | 'wasi' | 'ruby';
  instanceId: string;
  scope: string;
  cwd: string;
  state: string;
  startedAt: number;
  exitCode?: number;
  outputTail?: string;
  interactive: boolean;
  terminalSessionId?: string;
}
```

要求：

- PID namespace 全局不冲突；
- `ps` 展示全部可管理进程，支持 runtime/scope/instance 过滤；
- `kill` 统一管理 Node/Python/Lifo/WASI/Ruby/interactive app；
- Ctrl+C 对 Lifo 前台命令使用 AbortSignal，对真实 Node 先 SIGTERM、grace period 后 SIGKILL；
- daemon crash、spawn error、后台任务退出必须清理 registry；
- stdout/stderr 上限按 UTF-8 bytes 计算，流式 backpressure；
- service registry、`succinix service`、Lifo `systemctl` 和端口视图使用同一数据源；
- `systemctl start|stop|restart|status|list-units|enable|disable`；
- 不模拟 PID 1，输出明确标注 declarative service manager。

官方服务模板：`node-http`、`vite`、`static-http`、`python-http`、`tinbase`、`websocket`、`worker`。

---

## 7. 持久化 v2 与生命周期（P0）

### 7.1 混合快照格式

采用：

1. WebContainer binary export 作为 workspace 真源；
2. binary generation 按默认不超过 256 KiB 的 chunk 写入独立 IndexedDB；
3. manifest + SHA-256 + generation + last-known-good pointer 管理一致性。

本版 chunk 是完整 binary generation 的可原子存储分片，不虚假宣称为内容寻址增量去重。真正 content-addressed dedup 留待后续版本。

manifest 至少包含：

- `formatVersion: 2`；
- instanceId/workspace root/generation；
- file/chunk count/byte size/SHA-256；
- engine/Lifo/Pyodide/Ruby/WASI 版本；
- createdAt/excluded paths；
- package rehydration manifest；
- degradation 状态。

写入顺序：

```text
chunks -> manifest -> hash verification -> active pointer
```

恢复：

- 先写临时 workspace；
- 校验 hash/manifest/version；
- 成功后替换目标，并删除 snapshot 中不存在的旧文件；
- 失败时保留原 workspace 与上一代 LKG；
- v0.6 store 只报告 `legacy snapshot detected`，不自动导入、覆盖或删除。

quota：

- 使用 `navigator.storage.estimate()`；
- 默认硬上限 256 MiB；
- 为新 generation 和上一代 LKG 同时保留空间；
- quota 不足不切换 current pointer。

### 7.2 dirty generation

- 使用可靠 VFS/FS watch 事件记录 dirty revision；
- 5 s debounce，最长 30 s 强制落盘；
- `visibilitychange(hidden)`、`pagehide`、`succinix snapshot now` 执行 best-effort flush；
- 交互编辑器保存直接触发 dirty，不依赖文件大小变化；
- 状态：`clean|dirty|saving|saved|quota-exceeded|corrupt|degraded`。

### 7.3 Session persistence

- manifest + segment JSONL；
- 每 segment 默认 500 条或 1 MiB；
- append 仅写当前 segment；
- `readFrom()` 按 segment index 读取；
- `readRaw()` 按需组装；
- compaction 使用 temp + manifest atomic switch；
- 保留 contiguous sequence、revision、raw artifact、synthetic closer 和尾部修复语义；
- `onFlush` 默认 500 ms trailing debounce。

### 7.4 控制器与资源所有权

```ts
interface SnapshotController {
  stop(): void;
  flush(): Promise<void>;
  running(): boolean;
}

interface WatchdogController {
  stop(): void;
  restartNow(): Promise<void>;
}
```

- 所有 timer/listener/subscription 可清理；
- 同一 WebContainer 只有一个 snapshot loop 和一个 watchdog；
- HostManager boot/attach/respawn 使用 generation token；
- restart 互斥 + 指数退避；
- dispose 后忽略迟到 callback；
- `releaseInstance()` 清理 persist context、terminal transport、sandbox、process/service/package state 和 cache。

---

## 8. Linux Userland Compatibility Profile（P0/P1）

新增：

```text
succinix-linux-userland/0.7
```

```ts
interface UserlandCommandCapability {
  name: string;
  status: 'native' | 'adapter' | 'partial' | 'unsupported';
  runtime: 'lifo' | 'node' | 'python' | 'ruby' | 'wasi';
  execution: 'batch' | 'interactive' | 'both';
  supportedFlags?: string[];
  exitCodeContract?: string;
  limitations?: string[];
}
```

新增：

```text
succinix doctor
succinix capabilities
```

每个命令必须记录 stdin、管道、glob、相对路径、帮助、非法参数、exit code、最大输出、二进制行为、batch/interactive 能力和已知限制。

### 8.1 Shell/脚本

稳定支持：

- `;`、`&&`、`||`、pipe；
- stdin/stdout/stderr redirect；
- glob、变量展开、引号、转义、命令替换；
- `export/set/unset/exit`；
- here-document 或稳定明确的 unsupported；
- shebang；
- `sh script.sh`、`bash script.sh`、`./script.sh`；
- 脚本内 Node/Python/WASI/Lifo 混合链；
- cwd/env/exit code 在同一 Shell 上下文一致。

`bash` 明确输出 `Succinix shell: bash-compatible userland subset`，不伪造真实 Bash binary。

### 8.2 常用 Unix 命令

至少对以下命令建立参数和退出码合同：

```text
echo printf true false test [ env export command which pwd cd
ls cp mv rm mkdir rmdir touch cat head tail tee wc
sort uniq cut tr grep sed awk find xargs basename dirname realpath
mktemp date sleep seq du df file diff tar gzip gunzip zip unzip
base64 sha256sum md5sum column xxd id groups printenv expr
```

标准命令在 Lifo Shell 中正常组合：

```text
env | sort
whoami | cat
ps | grep node
systemctl status | head
```

明确 fail-closed：

```text
chmod chown ln mount umount sudo su useradd groupadd
iptables ifconfig route ping ssh gcc clang rustc go
```

所有拒绝必须英文、稳定 exit code、不写入错误状态，并在 `succinix capabilities` 中可见。

---

## 9. 包、Git、网络、语言与交互生态（P1）

### 9.1 统一 package manifest

```text
/etc/succinix.packages.json
```

```ts
interface InstalledPackage {
  name: string;
  source: 'lifo' | 'npm';
  version: string;
  integrity?: string;
  installedAt: number;
  persistent: boolean;
  execution?: 'batch' | 'interactive' | 'both';
}
```

```text
succinix pkg install|remove|update|lock|doctor|cache|restore
```

- Lifo package 跨 host restart rehydrate；
- npm package 继续使用真实 `node_modules`；
- Lifo tool package 与 npm 同名时 Lifo 优先，普通 npm package 用 `npm:` 显式选择；
- registry unavailable 与 package not found 区分；
- 安装失败不写已安装状态；
- manifest 声明 network/persistence/binary/interactive/multi-instance/refresh 行为；
- credential 不进普通 snapshot。

### 9.2 Git 与网络

Git HTTPS 工作流稳定支持：

```text
git init status add commit log diff branch checkout clone fetch pull push
```

- 使用 Lifo package/Isomorphic Git；
- SSH transport 明确 unsupported；
- clone/fetch/push 支持进度和取消；
- token 不进 command log 或 snapshot；
- `.git` snapshot 默认排除，允许配置。

网络命令：

```text
curl wget dig host nslookup netstat ss ip addr ip route
succinix net doctor|preview|tunnel
```

输出必须标注 `virtual|preview|outbound|unavailable`，不伪造公网网卡、ICMP 或真实入站 socket。

### 9.3 开发工作流

```text
succinix init
succinix run
succinix serve
succinix open
succinix doctor
```

识别 `package.json`、`pyproject.toml`、`requirements.txt`、Vite 配置、`index.html`、service port 和 preview URL。

### 9.4 Ruby/WASI/编辑器

v0.7 全部进入稳定交付范围：

- Ruby WASM：`ruby -e`、script、`--version`；不承诺 native gem/subprocess；
- WASI：`wasi-run`、`wasi-info`，支持 argv、stdin/stdout、exit code、timeout、输出上限；
- `vi`/`nano`：Lifo 原生交互 package，经 `RpcTerminal` 与 browser xterm 通信；
- C/Rust/Go 原生编译器仍为稳定 unsupported capability，不伪造系统工具链。

---

## 10. 第三方 Userland SDK（P1）

```ts
interface UserlandRegistry {
  listCommands(): UserlandCommandCapability[];
  registerCommand(command: UserlandCommandDefinition): () => void;
  registerPackage(source: UserlandPackageSource): () => void;
  registerServiceTemplate(template: ServiceTemplate): () => void;
  capabilities(): UserlandCapabilitySnapshot;
}
```

注册的命令/package 必须运行在 WebContainer/Lifo userland，可以声明 batch/interactive/both，并使用同一：

- Lifo CommandRegistry；
- `ITerminal` 与 `CommandContext.stdin`/`setRawMode`；
- VFS/共享文件系统；
- ProcessRegistry/ServiceRegistry；
- package manifest/integrity/rehydration；
- instance/lifecycle/capabilities/self-test。

不提供一个可以在浏览器外层实现标准命令的 SDK。浏览器 plugin 仅允许注册设备、显示面或必要 Web API bridge。

---

## 11. 性能、错误与可观测性（P1）

目标：

- 普通主 bundle < 400 KiB，gzip < 120 KiB；
- 初始路径不加载 Lifo、Pyodide、Ruby、WASI、selftest、scenario、bench；
- `host.js` 保持轻量，`lifo-core.js` 继续 dynamic import/idle prewarm；
- host 首次 ping P95 不退步；
- 普通 batch RPC P95 <= 250 ms；
- 交互按键到终端帧往返 P95 <= 50 ms；
- 1000 文件强制 snapshot <= 1 s；
- 10k session append 单次 P95 <= 50 ms；
- 5000 行输出不产生明显 UI 卡顿；
- CI benchmark 运行三次取中位数，波动 >20% 失败。

错误统一：

```ts
interface RuntimeErrorShape {
  code: string;
  message: string;
  runtime: string;
  retryable: boolean;
  degraded: boolean;
}
```

命令日志默认脱敏 token/password/npm auth/env secret/URL query secret。可恢复错误进 diagnostics ring buffer，不静默吞关键错误。

可观测字段：boot phase、RPC queue/host/poll、terminal input/frame/ack/backpressure、snapshot collect/write/IDB、session append/flush、watchdog restart、runtime asset load、active timers/controllers、cache/process/terminal registry size。

---

## 12. 公共 API 与协议调整

```ts
TerminalExecutor.exec(command, {
  timeoutMs,
  signal,
  cwd,
  env,
  instanceId,
});

TerminalExecutor.spawn(command, options);
kill(pid, { signal, forceAfterMs, instanceId });
listProcesses(options);
runtimeStatus();
persistenceStatus();
capabilities();
degradations();
shutdown();
```

新增交互 session 面：

```ts
interface InteractiveTerminalService {
  open(options: {
    instanceId: string;
    cols: number;
    rows: number;
  }): Promise<InteractiveTerminalSession>;
}

interface InteractiveTerminalSession {
  readonly id: string;
  send(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  onData(listener: (data: string) => void): () => void;
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void>;
  close(): Promise<void>;
}
```

Cordis 事件：

```text
succinix/command-start
succinix/command-finish
succinix/runtime-ready
succinix/degradation
succinix/persistence
succinix/terminal-open
succinix/terminal-close
succinix/terminal-backpressure
```

必须建立 v0.6 -> v0.7 API 迁移矩阵，明确旧接口、替代接口、兼容层、移除时间和 contract test。

---

## 13. 测试与质量门禁

### 13.1 单元/协议测试

- Lifo 0.10.10 根导出/type `ITerminal`、`CommandContext.stdin`/`setRawMode` 行为与内部 raw-mode 桥接快照；
- RpcTerminal write/onData/resize/focus/clear/dispose；
- terminal input/output sequence、ack、replay、stale nonce、backpressure；
- browser xterm 不再解析 shell line 或保持第二套 history；
- RPC refresh ID 冲突、cmd 覆盖、malformed JSON、partial write、stale result、instance mismatch；
- compound cwd、pipeline、export -> Node/Python、路径映射、Lifo-only cwd fail-closed；
- Node/Python/Lifo/Ruby/WASI/interactive process ps/kill/timeout/crash；
- binary snapshot、chunk/hash/quota/torn write/LKG/exact restore/legacy store/multi-instance；
- session 10k append、compaction、torn tail、concurrent append；
- snapshot/watchdog/controller dispose 与 HostManager stale generation；
- shell 组合语义、至少 40 个 Unix 命令、denylist exit code；
- package integrity/rehydration/registry unavailable；
- vi/nano/Ruby/WASI 与第三方 interactive package。

### 13.2 完整浏览器 E2E

- Chrome + COOP/COEP + port 7892；
- xterm -> RpcTerminal -> Lifo Shell 真实按键、paste、history、Tab、Ctrl+C、resize；
- Node/npm/npx/Lifo/Python/pip/Ruby/WASI；
- `vi`/`nano` 全屏重绘、raw mode、保存/退出/搜索；
- 第三方 package 经相同终端路径运行；
- batch RPC 与交互 Shell 并发共享同一 cwd/env/files/package state；
- 多实例终端/进程/文件隔离；
- host crash/respawn/reconnect 不消费旧帧、不留孤儿进程；
- pagehide/visibilitychange/refresh 二进制恢复；
- Git/ffmpeg/jq/tinbase/Vite preview；
- `succinix init -> install -> run -> ports`；
- v0.6 legacy snapshot 检测；
- external `examples/cordis-app` contract；
- 首次 Lifo/Python/Ruby/WASI 和缓存命中性能。

### 13.3 门禁

```text
npm run typecheck
npm run typecheck:legacy
npm run lint
npm run test
npm run test:coverage
npm run build
npm run audit:files
npm run check:static
npm run check:docs
npm run check:plugin-boundaries
npm run check:dsh-shapes
npm run check:dsh-keys
npm run check:engine-package
npm run test:e2e
npm run test:bench
npm run check:legacy-store
npm run check:lifecycle
npm run check:bundle-budget
npm audit --audit-level=high
```

发布前 soak：

- 10,000 次 batch RPC refresh/race；
- 100,000 个 terminal input/output frame 无丢失、重复或乱序；
- 交互 session 连续 resize/paste/Ctrl+C 压力；
- 多实例 100 次创建/释放无 timer/context 线性增长；
- binary snapshot 恢复零丢失；
- host respawn 无孤儿 service/terminal/process。

---

## 14. 实施顺序

1. **基线固化**：重跑当前 unit/E2E/coverage/bundle/benchmark/audit，写入可复现 baseline。
2. **依赖升级**：分批升级 toolchain、Lifo、TS 双轨和 audit override，每批独立回归。
3. **per-instance SandboxContext**：先消除全局 sandbox/currentInstance 可变状态。
4. **Lifo 原生终端**：实现 RpcTerminal/终端传输，用 `Sandbox.create({ terminal })` 创建并启动的 Lifo Shell 替代浏览器并行 REPL。
5. **命令迁移**：标准名称进 Lifo/host adapter，管理命令收口 `succinix ...`，保留 batch RPC。
6. **RPC/process/service**：完成 nonce/ack/scheduler、统一进程/信号/service manager。
7. **持久化 v2**：binary chunk generation/LKG、session segments、controller lifecycle。
8. **Shell/Userland profile**：脚本、40+ 命令、denylist、capabilities/doctor。
9. **包/Git/网络**：manifest/integrity/rehydration、Git HTTPS、诚实网络视图。
10. **交互/语言生态**：vi/nano、Ruby WASM、WASI、第三方 UserlandRegistry。
11. **性能/可观测**：lazy assets、bundle/output/log/terminal backpressure、metrics。
12. **文档和迁移**：SDK/PLUGIN/MIGRATION/PROTOCOL/FEATURES/LANGUAGES/README/examples/contract 双语同步。
13. **发布门禁**：完整 unit/E2E/soak/benchmark/audit、staging 验证、engine dry-run tarball。

---

## 15. 发布、回滚与完成定义

发布前：

- 保留 v0.6 branch 和旧 package tarball；
- v0.7 使用独立 IndexedDB，不删旧 store；
- staging 执行完整 E2E/benchmark/Cordis external example；
- 校验 COOP/COEP、SHA-256、runtime assets、static deployment；
- 生成 `@succinix/engine@0.7.0` dry-run tarball；
- 未得到 release owner 明确授权不 npm publish。

v0.7.0 只有在以下条件全部满足时完成：

- 人类终端真实由 WC 内 Lifo Shell 驱动，浏览器不再维护并行 REPL 状态；
- vi/nano 和第三方交互 package 经同一 `ITerminal` 与 `CommandContext.stdin`/`setRawMode` 路径稳定运行；
- batch RPC 与交互 Shell 共享同一 Sandbox/cwd/env/files/process/package/service 状态；
- snapshot v2/session segments/legacy detection/LKG 稳定；
- instance dispose 无 cache/timer/terminal/sandbox 泄漏；
- host respawn 无并发重启、旧帧误消费或孤儿进程；
- Shell、Unix 命令、service、package、Git、Node/Python/Ruby/WASI 工作流达标；
- 不可实现的能力全部 fail-closed，无权限/网络/kernel/native 能力被误标为真实；
- bundle/RPC/terminal/snapshot/session/output 性能达到预算；
- SDK、插件、迁移、协议、边界与双语文档同步；
- 全部质量门禁、浏览器 E2E、soak、benchmark 与 audit 通过。

---

## 16. 已确认决策

- 大跨度升级符合当前快速迭代阶段，不因范围大而人为拆出 v0.8。
- snapshot 使用 binary export + IndexedDB chunks + generation/LKG 混合方案。
- 依赖使用激进升级方案，但分批回归和 lockfile 可回滚。
- Ruby、WASI、vi/nano 和第三方交互生态全部进入 v0.7 稳定交付范围。
- vi/nano 不是 Browser Editor Adapter，而是 WebContainer/Lifo userland 内的原生交互 package。
- v0.7 复用 Lifo 根导出的 `ITerminal` 与公开 `CommandContext.stdin`/`setRawMode`/终端尺寸能力；内部 `TerminalStdin` 不作为第三方 API，不重新定义并行编辑器协议。
- 浏览器 xterm 是终端设备；终端应用、文件、进程、包和生命周期都属于 WebContainer 执行世界。
