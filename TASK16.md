# WebUnix — TASK16：维护轮（体验盲区 / 依赖审计 / 体积 / 稳定性 / 回归）

## 背景

TASK12-15 完成后做维护轮。目标：把产品打磨到"可发布"状态。本任务分五块，每块都有明确验收。

## 1. 自检结果进终端（体验盲区，已确认）

现状：`?test=1` 自检输出在覆盖层显示，淡出后终端只剩欢迎横幅——**自检结果不可回溯**。

- main.ts：自检完成后（runTests 返回后），把 summary 行（`Self-test result: N passed, M failed, K skipped`）和失败项列表（若有）**打印到终端**（complete() 之后、欢迎横幅之前或之后）
- 失败项 >0 时用暗红显示失败行（现有 ANSI 常量）；全绿只打印 summary 行
- 验收：`?test=1` 刷新后终端里能看到 summary

## 2. 依赖审计

- `npm audit` 检查已知漏洞（记录结果；高危修复需评估——**不自动升级**，只报告）
- 版本盘点：`npm outdated`（记录：@webcontainer/api、@lifo-sh/core、@xterm/xterm、vite、typescript、esbuild、@fontsource/jetbrains-mono）
- 输出：README/CHANGELOG 的 Dependencies 节更新（或新增 SECURITY.md 记录 audit 结果——二选一，README 优先）
- 约束：**本任务不升级依赖**（升级单独评估，避免引入回归）；只报告

## 3. host.js 体积优化

- 现状：public/host.js 1.9MB（未压缩？）——检查 scripts/build-host.mjs 是否开了 minify
- 优化：esbuild `minify: true`（+ 若可行 `keepNames: false`、tree-shaking 检查）；目标：体积下降 ≥30%
- 注意：host.js 在 WC 里以字符串注入运行——minify 后必须**真机验证**（自检全过 = 优化有效）
- 若 minify 引入问题（Lifo 依赖 Function.name 之类）→ 回退并记录原因（不强行）
- 验收：build-host 后体积数字对比 + ?test=1 全过

## 4. 稳定性加固

- **host 失联重连**：浏览器侧定时（每 30s）ping，连续 2 次失败 → 自动重启 host（重新注入 + spawn），日志 WARN 记录；重启后命令自动重发（简单版：记录一次重连即可，复杂队列不做）
- **RPC 超时重试**：LifoClient 的 exec 超时（现 120s 全局）→ 对非幂等命令不重试，只对 ping/ps 类只读命令做 1 次重试（防瞬断）
- **spawn 清理**：host 重启时旧进程表孤儿清理（重启后 ps 应干净）
- 验收：浏览器里杀 host 进程（ps 里 kill host pid 或用 devtools）→ 30s 内自动恢复、命令可用

## 5. 全量回归

- 所有内置命令冒烟（help 列出的全部：env/settings/snapshot/workspace/service/free/top/cache/ports/db/netstat/ip/uname/motd/log/reboot/shutdown/version/whoami/sysinfo/clear）
- `?test=1` 全过（PASS 数 ≥ 当前基线）
- 持久化回归：写文件 → 快照 → 刷新 → 文件在
- 结果记录到 README Verified Behavior（更新计数）

## 保留项（不许改）

- 文件 RPC、路由、spawn/ps/kill、端口、快照协议、tinbase、暗橙主题/英文/禁 emoji、vite 7892/COOP/COEP
- 依赖不升级（只报告）

## 质量门禁

- `npx tsc --noEmit` 0 错；`node scripts/build-host.mjs`；`npm run build`
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 自检全过 + 体积对比数字

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文；输出英文零 emoji
- 完成输出总结：每块改了什么/验证数字（体积对比、audit 结果、回归计数）、门禁结果

## 开始

先读 `src/main.ts`、`src/terminal-client.ts`、`src/boot.ts`、`scripts/build-host.mjs`、`package.json`、`README.md`，然后实现。
