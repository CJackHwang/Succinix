# WebUnix — TASK18：深度优化（性能剖析 / 技术债务 / 隐形 bug）

## 背景

0.2.0 + 复审循环（四批复审 + 三波修复）已闭环。本任务 = **深度优化阶段**：用可复现的测量建立性能基线，优化到目标，清理已知技术债务，挖掘隐形 bug。**不追求速度，要细节与质量。**

## 0. 已知遗留（先修）

1. **M1 残余**：`findServiceProcess` 仍按当前 preview-port 渲染 needle——"运行中改 preview-port 后状态误判 stopped"未真正闭环。修复：存在 activePorts 记录时用记录值渲染 needle
2. pingDirect 反向窗口（新 exec 120ms 内吞 ping）：记录到 README Known Limitations 或轻量处理（任选，倾向记录）

## 1. 性能剖析（headless Chrome 脚本，可复现基线）

写 `scripts/bench.mjs`（仿 verify-deploy.mjs 的 CDP 模式，零新依赖）测量并输出 JSON：

| 指标 | 测量方式 | 目标（优化后） |
|------|---------|---------------|
| **boot 耗时** | 导航 → 覆盖层淡出（MutationObserver 捕获 boot-overlay 移除）→ 终端提示符出现 | 记录基线，优化 ≥20% |
| **命令往返** | 终端内跑 `echo hi`（Lifo）与 `node -e 1`（Node）各 10 次，取 p50/p95 | 记录基线，优化 ≥20% |
| **快照开销** | 构造 N=200 文件 FS → saveSnapshot 耗时；N=1000 文件压力 | 记录基线，门控后应已大幅改善 |
| **xterm 大输出** | `seq 1 5000` 类大输出 → 渲染耗时/卡顿检测 | 有界（缓冲上限） |

### 优化方向（实现时自主探查，输出对比数字）

- **boot**：WC boot 与 host.js 注入并行化、`?test=1` 与正常 boot 分离、懒加载（Lifo 内核按需？评估成本）
- **命令延迟**：RPC 轮询间隔 150ms → 事件化？host 侧是否可 push？评估文件 RPC 的最小延迟路径（不改协议，优化轮询节奏/结果文件检查顺序）
- **快照**：门控已做；进一步评估"增量快照"（只写变化文件）vs 全量（小 FS 下全量更简单——若基线已 <200ms 则记录"无需增量"）
- **xterm**：`convertEol`/缓冲上限/行数上限（防超大输出 OOM）

**约束**：协议（文件 RPC 形态）不变；不引入新依赖；优化必须有基线数字对比（没有对比数字的优化不做）。

## 2. 技术债务清理

- 死代码扫描（TASK 过程遗留的未用导出/注释块/冗余分支——`grep` + 人工核对，列出清理清单）
- `boot-ui.ts` 的 `[preview]` marker 冗余匹配分支（复审已记录）
- 模块边界复查：commands.ts 是否过大需拆分（当前 >1000 行？评估拆分的收益/风险，**不强行拆**）
- 事件监听器/Interval 泄漏清查（main.ts 的 prune/snapshot/看门狗 interval 在重启路径是否清理）

## 3. 隐形 bug 挖掘（系统性，输出清单 + 修复）

- **竞态清单**：已知（spawn error 改写 / pingDirect 窗口 / workspace rm 并发）+ 新找（host 重启与在途命令、snapshot 与 force 并发、server-ready 与 kill 时序）
- **错误路径**：每个命令的超时/失败/降级路径走查（db/service/pkg/netstat 全部）
- **内存**：xterm 输出无限增长、日志文件 200KB 上限是否真的旋转
- **数据一致性**：快照恢复后 host 进程表状态（孤儿进程）、端口注册表与进程表不一致场景

## 4. 输出与门禁

- `scripts/bench.mjs` 保留（CI 可复用）
- 输出总结：基线 vs 优化后对比表、债务清理清单、bug 清单（每个：现象/根因/修复）
- 门禁：tsc 0 错 / build-host / build / grep 无 emoji / 自检 ≥53 passed
- 优化不破坏功能（自检全过是硬条件）

## 保留项

- 文件 RPC 协议形态、路由、spawn/ps/kill、端口、tinbase、暗橙/英文/禁 emoji、vite 7892/COOP/COEP、依赖不升级
- 不做"协议重构"级别的改动（如 RPC 改 WebSocket）——本任务在现有协议上优化

## 开始

先读 `src/` 全部、`scripts/verify-deploy.mjs`（CDP 模式参考）、`package.json`，实现 bench.mjs 测基线 → 优化 → 复测 → 清理债务 → 挖 bug → 修复。完成后输出完整报告。
