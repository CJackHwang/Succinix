# WebUnix — TASK6：内存管理（free / top / reboot / cache）

## 背景

持久化层（TASK5）已完成。用户要求"和真系统一样，用户也可以管理内存"。
当前无任何内存管理能力。浏览器内存 API：`navigator.deviceMemory`（GB，整数）、`performance.memory`（Chrome，JS heap，需 `{ usedJSHeapSize, totalJSHeapSize }`）、进程表（host 的 ps）。

## 需求

### 1. `free` 命令（浏览器侧，commands.ts）

内存概览，英文输出，类似 Linux free：

```
              total        used         available
Memory        16 GB        2.1 GB       13.9 GB
JS heap       512 MB       180 MB       332 MB
```

- total：`navigator.deviceMemory` GB（Chrome 有，缺失则显示 `--` 并注明）
- used/available：浏览器无法拿到系统级 used——用估算：
  - `performance.memory?.usedJSHeapSize` → JS heap used（真实值）
  - 系统 used 估算 = `performance.memory.usedJSHeapSize + 容器进程估算`（进程表各进程无 RSS，可显示 `~` 前缀注明估算）
  - **诚实标注**：`available` 为估算值，行尾或脚注注明 `(estimated — browser sandbox has no OS-level memory stats)`
- 二进制换算：1 KB = 1024 B，MB/GB 显示保留 1 位小数

### 2. `top` 命令（浏览器侧）

进程表实时视图（2 次快照间隔 ~2s，第 2 次后自动结束，避免常驻）：

```
top — 2026-08-05 03:00:00
  PID  STATE    COMMAND
   12  running  npx tinbase start --port 3001 --engine wasm
   15  exited   node -e http.createServer(...)
```

- 数据来自 `client.terminal('ps')`（复用进程表）
- 头部显示当前时间 + 总进程数；间隔 2s 刷新一次，共 3 次输出后结束（POC 不搞交互式常驻）
- 表头对齐（PID 右对齐、STATE 固定宽）

### 3. `reboot` 命令（浏览器侧）

- **重启系统** = 重建容器释放内存：`location.reload()`（最简单可靠的"重启"——浏览器释放旧容器全部内存，重新 boot）
- 输出一行确认：`Rebooting WebUnix...`，300ms 后 reload
- 持久化数据不受影响（IndexedDB 在浏览器侧，reload 保留）——**这是卖点**，reboot 后文件/数据库都在（boot 自动恢复）

### 4. `shutdown` 命令（浏览器侧）

- 输出 `Powering off. You can close this tab.`（POC 不真关 tab，提示即可）

### 5. `cache` 命令（浏览器侧 + host 侧配合）

```
cache          查看缓存占用（npm cache / tmp / lifo tmp）
cache clear    清理可重建缓存（npm cache ~/.npm、容器 /tmp、lifo 临时文件）
```

- 查看：host 侧跑 `du -sh ~/.npm /tmp` 之类（走 Lifo 路由 `du` 可用？Lifo 有 du——用 `terminal('du -sh /tmp ~/.npm 2>/dev/null')`，失败则显示 `--`）
- 清理：`terminal('rm -rf /tmp/* ~/.npm/_cacache 2>/dev/null')`（npm cache 可重建，安全；`~/.npm` 其余目录保留）。输出清理结果
- 注意：**绝不清理 /workspace**（用户数据）

### 6. help / 自检更新

- help 加 free/top/reboot/shutdown/cache 条目
- 自检（tests.ts）新增 1 项：`Memory: device memory reported`——`navigator.deviceMemory` 或 `performance.memory` 存在（任一即可，PASS；都不存在 SKIP）

### 7. README 更新

- 命令表加 5 个新命令；Features 或 Usage 补"memory management"一句

## 保留项（不许改）

- 文件 RPC、路由规则、spawn/ps/kill、端口、持久化快照逻辑、tinbase `--engine wasm`、暗橙主题/英文/禁 emoji、vite 7892/COOP/COEP、db 安装超时
- **reboot 用 location.reload() 实现，不许自定义容器重建逻辑**（复杂且易错）

## 质量门禁

- `npx tsc -p tsconfig.json --noEmit` 0 错误
- `node scripts/build-host.mjs`、`npm run build` 成功
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 浏览器人工验证清单（你列出）：free 显示合理、top 输出 3 次、reboot 后文件仍在（持久化+重启联动）、cache clear 不碰 /workspace

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文；结构沿用（commands.ts 内新增，别拆新文件除非必要）
- 所有输出英文、专业、零 emoji、估算值必须标注 estimated
- 完成后输出总结：改了哪些文件、门禁结果、浏览器人工验证清单

## 开始

先读 `src/commands.ts`、`src/main.ts`、`src/tests.ts`、`AGENTS.md`，然后实现。
