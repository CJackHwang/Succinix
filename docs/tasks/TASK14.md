# WebUnix — TASK14：网络视图（netstat/ip 风格，仅虚拟端口）

## 背景

包管理（TASK13）后做网络视图。真 OS 的 `netstat`/`ip` 展示网卡/连接表——浏览器沙箱没有真网卡（AGENTS.md 边界：**仅虚拟端口视图**，不做真网络模拟）。已有端口注册表（server-ready 事件）——本 TASK 在其上做**展示层**。

## 需求

### 1. `netstat` 命令（浏览器侧，commands.ts）

```
netstat           列出全部服务端口（虚拟端口视图）
netstat -p        带进程信息（端口 → 关联进程 PID/命令）
```

输出示例（英文、对齐、零 emoji）：

```
Proto  Local Address       State   Process
tcp    127.0.0.1:3001      LISTEN  tinbase (pid 12)
tcp    127.0.0.1:3456      LISTEN  node http server (pid 15)
```

- 数据源：端口注册表（port → URL）+ 进程表（spawn 的 node 系进程）
- **关联规则**：端口 ↔ 进程——从进程表里找命令含端口号的进程（tinbase 命令含 3001）；匹配不到显示 `-`
- Proto 固定 tcp（虚拟）、Local Address 用 `127.0.0.1:<port>`、State LISTEN
- 空表：`No listening ports`

### 2. `ip` 命令（轻量）

```
ip addr    显示网络身份（浏览器视角：user agent 平台 + 预览域）
```

- 输出：`lo: virtual loopback`、`eth0: <preview-domain> (virtual)`——**诚实标注 virtual**，不编造 IP
- 也可以直接省略 ip 命令只做 netstat？——**决策：做 `ip addr` 轻量版**（信息少但有"网络身份"感），不编造数据

### 3. 自检新增（tests.ts）

- `Network: netstat format`——spawn 一个 echo server（3456）→ netstat 列出该端口 → kill 清理
- `Network: netstat empty`——kill 后 netstat 空表（或无该端口）

### 4. help / README / CHANGELOG

- help 加 `netstat`、`ip`；README 命令表 + Features；CHANGELOG

## 保留项（不许改）

- 文件 RPC、路由、spawn/ps/kill、端口注册机制（server-ready 监听不动）、快照、tinbase、TASK6/7/10/11/13 功能、暗橙主题/英文/禁 emoji、vite 7892/COOP/COEP
- **不编造数据**：没有的网卡/IP/连接一律不显示或标 virtual

## 质量门禁

- `npx tsc -p tsconfig.json --noEmit` 0 错误；`node scripts/build-host.mjs`；`npm run build`
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 浏览器人工验证清单（你列出）：spawn 服务 → netstat 显示端口+进程关联 → kill → 消失；ip addr 输出 virtual 标注

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文；输出英文零 emoji
- 完成后输出总结：改了哪些文件、门禁结果、浏览器人工验证清单

## 开始

先读 `src/commands.ts`、`src/main.ts`（端口注册表）、`src/tests.ts`、`AGENTS.md`，然后实现。
