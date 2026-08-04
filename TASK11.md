# WebUnix — TASK11：服务管理（service start/stop/status，systemctl 风格）

## 背景

TASK10（系统配置）后做服务管理。WebUnix 已有 `spawn`（后台进程）+ `ps`/`kill` + 端口注册——服务管理是在其上的**声明式封装**：给后台服务起名字、管生命周期、可配置开机自启（声明式重启，不是守护进程——遵循 AGENTS.md 边界）。

## 需求

### 1. `service` 命令族（浏览器侧，commands.ts）

```
service                   列出全部服务（状态：running/stopped，含端口）
service start <name>      启动服务（定义见下）
service stop <name>       停止（kill 对应进程）
service status <name>     单个服务详情
service enable <name>     开机自启（写入自启清单，boot 时拉起）
service disable <name>    取消自启
```

输出示例（英文、表格对齐、零 emoji）：

```
Services
  NAME     STATE     PORT
  tinbase  running   3001
  web      stopped   -
```

### 2. 内置服务定义（`/etc/webunix.services`，随快照持久）

格式：`name|command|port`（`|` 分隔，`#` 注释），内置预置：

```
tinbase|npx tinbase start --port ${PORT} --engine wasm|3001
```

- `${PORT}` 占位符：读 settings 的 `preview-port`（TASK10，缺省 3001）
- 命令用 spawn 启动（node 系，TerminalExecutor 后台协议）
- 端口列用于状态展示（从端口注册表匹配）

### 3. 状态判定

- `running`：进程表里有该服务命令的 running 进程 **且**（若有端口）端口注册表里有
- `stopped`：没有
- 同名服务只允许一个实例（start 前检查）

### 4. 自启（`/etc/webunix.autostart`，随快照持久）

- `service enable <name>` 把服务名写入 autostart 文件（去重）
- boot 时（TerminalExecutor ready 后）：读取 autostart，逐个 `service start`，日志 `[  OK  ] Started service '<name>' (autostart)` 或 `[FAIL] service '<name>' failed to start`
- 自启失败不阻塞 boot（继续，记日志）

### 5. `service stop` 实现

- 查进程表找该服务命令对应的 running 进程 → `kill <pid>`；端口注册表对应条目自动移除（现有逻辑）
- stop 后 `service` 列表状态变 stopped

### 6. 自检新增（tests.ts）

- `Services: list shows tinbase`——服务列表包含预置项且格式正确
- `Services: start/stop lifecycle`——临时注册一个测试服务（echo server）→ start → running → stop → stopped → 清理定义（零残留）
- `Services: autostart enable/disable`——enable 写入 → disable 移除（文件断言）

### 7. help / README / CHANGELOG

- help 加 `service`；README 命令表 + Features；CHANGELOG

## 保留项（不许改）

- 文件 RPC、路由、spawn/ps/kill 协议、端口注册、快照、tinbase `--engine wasm`、TASK6/7/10 功能、暗橙主题/英文/禁 emoji、vite 7892/COOP/COEP
- 自启是"声明式重启"（boot 时拉起），**不是守护进程/崩溃自愈**——README 注明，不做崩溃重启（那是守护进程语义，超出声明式范围）

## 质量门禁

- `npx tsc -p tsconfig.json --noEmit` 0 错误；`node scripts/build-host.mjs`；`npm run build`
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 浏览器人工验证清单（你列出）：service 列表、start tinbase → running + 端口、stop → stopped、enable 后刷新自动拉起

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文；输出英文零 emoji
- 服务文件解析健壮（空行/注释/缺字段容错）
- 完成后输出总结：改了哪些文件、门禁结果、浏览器人工验证清单

## 开始

先读 `src/commands.ts`、`src/boot.ts`、`src/tests.ts`、`TASK10.md`（settings 读取方式）、`AGENTS.md`，然后实现。
