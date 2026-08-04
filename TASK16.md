# WebUnix — TASK16：维护轮（体验盲区 / 审查修复 / 依赖 / 体积 / 稳定性 / 回归）

## 背景

TASK12-15 全部完成。本任务是**发布前维护轮**：修复全部积攒的审查问题 + 性能/稳定性 + 全量回归。所有修复项均来自独立审查 agent 报告（已确认缺陷）。

## 1. 自检结果进终端（体验盲区，已确认）

现状：`?test=1` 自检输出只在覆盖层显示，淡出后终端看不到结果。

- main.ts：runTests 返回后，把 summary（`Self-test result: N passed, M failed, K skipped`）+ 失败项列表（若有）打印到终端（complete() 之后、motd 横幅之前）
- 失败 >0 暗红显示失败行；全绿只打印 summary
- 验收：`?test=1` 后终端可见 summary

## 2. TASK13 审查修复（pkg）

1. **pkg search 单槽竞态（必修）**：lifoSearch/npmSearch 并行 → `/cmd.json` 单槽丢通道。修复：给 TerminalClient 加请求互斥/队列（同一时刻只有一个在途请求），或两通道改串行
2. **包名校验 + 引号（必修）**：拒绝空名/含空白/以 `-` 开头（合法：`@scope/name` 或 `[a-zA-Z0-9-_.]+`）；`npm view ${name}` 等命令参数加双引号；保证 `pkg install --help` 不返回假成功
3. **CHANGELOG**：补 pkg 命令族条目
4. **README**：注明"顶层直装"（node_modules 顶层目录 = 已装包，含容器预装运行时依赖，不含依赖树）
5. detectSource 网络失败回落 npm 时附加 `(lifo unavailable — fell back to npm)` 提示

## 3. TASK12 审查修复（日志）

6. **日志文件从快照签名排除**（R1）：/var/log/webunix.log 参与 totalBytes 计算导致每条命令触发全量快照。修复：persist.ts 快照遍历时排除 /var/log/webunix.log（或日志单独处理）；同时日志仍随快照持久（排除的是签名参与，不是持久本身——**注意**：如果排除遍历则日志不落快照，需权衡：改为"参与遍历但不参与签名"（遍历含日志、签名计算排除它）——选这个方案）
7. **内部探测命令降噪**（R2）：terminal-client 对纯轮询 ps（service/top 内部调用）跳过命令日志记录；kill 保留
8. **boot 顺序**（R3）：boot.ts 改"先 loadSnapshot 再 initLogger"，消除恢复期日志写竞争（恢复完成前的 boot 事件不落盘，可接受）

## 4. TASK14 审查建议

9. **端口↔进程结构化匹配**：子串 → `--port\s+N` / `listen(N)` / 单词边界匹配（消除 3001↔300/30010 误关联）
10. **processLabel 跳过 npx/node 前置 flag**：`npx --yes X` → `X`

## 5. 依赖审计（报告，不升级）

11. `npm audit`（记录漏洞，不自动升级）；`npm outdated` 盘点；结果写入 README 或 CHANGELOG 的 Dependencies 节

## 6. host.js 体积优化

12. scripts/build-host.mjs：esbuild `minify: true`（+ keepNames 评估）。目标体积下降 ≥30%。**minify 后必须真机验证**（?test=1 全过 = 有效）；若 Lifo 依赖 Function.name 之类导致运行时错误 → 回退并记录原因（不强行）

## 7. 稳定性加固

13. **host 失联自动重启**：浏览器侧每 30s ping，连续 2 次失败 → 重新注入 host.js + spawn（WARN 日志）；重启后进程表应干净（孤儿清理）
14. **RPC 只读命令重试**：ping/ps 类只读命令失败重试 1 次（非幂等命令不重试）

## 8. 全量回归

15. 全部内置命令冒烟（help 全部条目）；`?test=1` 全过（≥ 当前基线）；持久化回归（写→快照→刷新→在）
16. README Verified Behavior 计数更新

## 保留项（不许改）

- 文件 RPC、路由、spawn/ps/kill、端口注册、tinbase、暗橙主题/英文/禁 emoji、vite 7892/COOP/COEP
- 依赖不升级（只报告）

## 质量门禁

- `npx tsc --noEmit` 0 错；`node scripts/build-host.mjs`；`npm run build`
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 自检全过 + 体积对比数字（minify 前后）

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文；输出英文零 emoji
- 完成输出总结：每块改了什么/验证数字（体积对比、audit 结果、回归计数）、门禁结果

## 开始

先读 `src/main.ts`、`src/terminal-client.ts`、`src/boot.ts`、`src/persist.ts`、`src/commands.ts`、`src/pkg.ts`、`scripts/build-host.mjs`、`package.json`、`README.md`、`AGENTS.md`，然后实现。
