# WebUnix — TASK12：日志系统（journald 风格，落盘持久）

## 背景

服务管理（TASK11）之后做日志系统。真 OS 的日志是核心（journald/syslog）——boot 日志、命令历史、系统事件落盘，可查询。WebUnix 的 boot 日志目前只显示不落盘；命令执行无历史记录。

## 需求

### 1. 日志存储（浏览器侧 + 容器 FS）

- 文件：`/var/log/webunix.log`（容器 FS，随快照持久；`log rotate` 概念简化：超过 ~200KB 时截断保留尾部）
- 行格式：`2026-08-05T04:00:00Z [level] message`（level: INFO/WARN/ERROR/BOOT），ISO 时间戳
- **采集点**：
  - boot 事件（覆盖层日志的 [ OK ]/note 行 → 写 BOOT 级日志）
  - 命令执行（terminal 命令 → INFO：`cmd: <command> exit=<code> runtime=<node|lifo>`）
  - 服务事件（service start/stop/enable → INFO/WARN）
  - 快照事件（snapshot saved/restored → INFO）
  - 错误（exec 异常、host 掉线 → ERROR）

### 2. `log` 命令（浏览器侧）

```
log                最近 20 行（默认）
log -n <count>     最近 N 行
log -f              持续输出（新行追加，Ctrl+C 停止——xterm 交互模式；POC 简化为输出后提示"tail -f style not supported, use log -n"？）
                    决策：-f 不做（交互 stdin 边界），用 log watch 替代？也不做。POC: log / log -n 即可，README 注明
log clear           清空日志文件
log boot            只看 BOOT 级
```

- 读取走 Lifo `tail -n <N> /var/log/webunix.log`（或浏览器直接 wc.fs.readFile 取尾部——浏览器读更直接，选浏览器读）
- 输出格式保持日志原文（带时间戳）

### 3. 写日志的实现位置

- `src/log.ts`（新文件）：`initLogger(fs)` → `log(level, msg)`（异步追加，不阻塞命令）、`readLog(fs, n)`、`clearLog(fs)`
- commands.ts 的 execute 路径插入命令日志；boot.ts 插入 boot 事件；服务/快照点插入
- 追加实现：读现有内容 + 写回（POC 文件小，全量读写在 200KB 内可接受；或 wc.fs.appendFile？WC fs 有 appendFile——**优先 appendFile**，若不可用则读改写）

### 4. 自检新增（tests.ts）

- `Logs: command execution recorded`——跑一条命令 → log 出现该命令记录（exit=0）
- `Logs: boot events recorded`——log 含 BOOT 级条目
- `Logs: clear`——log clear 后为空

### 5. help / README / CHANGELOG

- help 加 `log`；README 命令表 + Features；CHANGELOG

## 保留项（不许改）

- 文件 RPC、路由、spawn/ps/kill、端口、快照、tinbase、TASK6/7/10/11 功能、暗橙主题/英文/禁 emoji、vite 7892/COOP/COEP
- `log -f` 交互流式**不做**（交互 stdin 边界，AGENTS.md）

## 质量门禁

- `npx tsc -p tsconfig.json --noEmit` 0 错误；`node scripts/build-host.mjs`；`npm run build`
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 浏览器人工验证清单（你列出）：跑几条命令 → log 有记录（含时间戳/级别）→ log -n 5 → log clear 空；刷新后日志仍在（持久化联动）

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文；日志内容英文
- 日志写入失败绝不影响主流程（try/catch 静默降级）
- 完成后输出总结：改了哪些文件、门禁结果、浏览器人工验证清单

## 开始

先读 `src/commands.ts`、`src/main.ts`、`src/boot.ts`、`src/tests.ts`、`AGENTS.md`，然后实现。
