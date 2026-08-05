# WebUnix — TASK19：高级复杂功能场景测试

## 背景

TASK18 深度优化完成（自检 55 passed）。本任务 = **真实工作流场景测试**：用自动化（headless Chrome，仿 scripts/verify-deploy.mjs / bench.mjs 的 CDP 模式，零新依赖）跑真实开发场景，暴露仅在组合操作下出现的 bug。**不追求速度，场景要逼真。**

## 需求

### 1. `scripts/scenarios.mjs`（新文件，场景套件）

仿 verify-deploy.mjs 的 CDP 驱动模式，每个场景：准备 → 执行（终端输入命令）→ 断言 → 清理，输出 `PASS/FAIL + 证据`，最后汇总。

**场景清单（每个都要真实执行、真实断言）：**

| # | 场景 | 关键断言 |
|---|------|---------|
| S1 | **npm 项目开发闭环**：npm init -y → 写 server.js（http 服务）→ node 启动后台 → fetch 预览 URL 返回 200 → kill | 产物真实、端口真实、HTTP 真实 |
| S2 | **git 操作**：pkg install lifo-pkg-git → git init → add → commit → log | commit 真实产生（hash 存在） |
| S3 | **数据库全生命周期**：db start（wasm）→ 等端口 → node 脚本建表插数据 → db stop → **db start 再起 → 数据仍在**（持久化） | SQL 执行真实、数据跨重启在 |
| S4 | **服务自启**：service enable tinbase → 刷新页面 → boot 自动拉起 → service 显示 running → disable → 刷新不再拉起 | autostart 真实执行 |
| S5 | **多工作区隔离**：workspace create proj-a/proj-b → 各自写文件 → switch 隔离验证（a 的文件 b 看不到）→ 刷新后状态保留 | 隔离 + 持久化 |
| S6 | **并发压力**：同时发 3 条长命令（sleep/大循环）→ 全部正确返回、结果不串（per-id 文件正确性） | 无串扰、无丢失 |
| S7 | **大输出**：`seq 1 10000`（Lifo）+ `node -e` 输出 2MB+（触发裁剪）→ 有界返回不 OOM | 1MB 上限生效、不卡死 |
| S8 | **持久化压力**：写 300 个文件 → snapshot now → 刷新 → 文件全在 + 内容一致（抽样校验） | 大规模恢复一致 |
| S9 | **错误路径**：未知命令 / 不存在目录 / 网络失败（无 CORS curl）→ 英文报错不挂死 | 错误可操作 |
| S10 | **环境边界**：`reboot` 后系统恢复（文件在 + 服务状态合理） | 重启不丢 |

### 2. 回归断言补强（TASK18 复审建议）

- 补 2 条自检断言（tests.ts）：
  - **spawn 失败竞态**：`spawn npx definitely-not-exist-xyz` → 结果 ok:false（不误报成功）
  - **双 host 不变量**：模拟 restartHost 路径（或直接断言 restartHost 存在 kill 先于 spawn 的逻辑——选可测的方式）
- 若不可测（需真实 host 挂死），在 scenarios.mjs 的 S9/S10 里做等价验证

### 3. 场景中发现的 bug

- 记录：现象/根因/严重度
- 轻量 bug（≤5 行修复）当批次修；结构性 bug 列出交下批次

### 4. 输出与门禁

- 报告：每场景 PASS/FAIL + 证据 + 汇总数字；bug 清单
- 门禁：tsc 0 错 / build-host / build / grep 无 emoji / 自检 ≥55 passed
- scenarios.mjs 保留（CI 可复用）

## 保留项

- 协议形态、路由、spawn/ps/kill、端口、tinbase、暗橙/英文/禁 emoji、vite 7892/COOP/COEP、依赖不升级
- 场景测试**真实执行**（真浏览器真容器），不许 mock 代替

## 开始

先读 `scripts/verify-deploy.mjs`（CDP 模式参考）、`scripts/bench.mjs`、`src/tests.ts`、`src/main.ts`（?test=1 钩子）、`AGENTS.md`，然后实现。完成后输出完整报告。
