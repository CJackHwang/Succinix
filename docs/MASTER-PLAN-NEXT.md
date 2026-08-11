# MASTER PLAN NEXT: Succinix 工程优化与自动化补强

> 2026-08-11 新建。0.4.0 平台化阶段已闭环；上传/发布由用户执行，不在本计划步骤内。
> 本文件是 Succinix 下一阶段唯一工程计划；旧 `MASTER-PLAN.md` 与
> `ENGINEERING-REVIEW.md` 已删除。

---

## 0. 目标

- 继续压缩 `src/` 与 `scripts/` 大文件，降低维护成本。
- 补齐同页多实例宿主行为 e2e，缩小协议级单测与真实宿主行为之间的盲区。
- 让 push CI 覆盖场景套件，避免场景回归只在 nightly 暴露。
- 沉淀工程基座：一行命令本地验收、文件规模审计、文档引用完整性检查。

## 1. 完成基线（2026-08-11 实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 errors |
| `npm run lint` | pass |
| `npm run test` | 336 passed / 26 files |
| `npm run build` | pass，`host.js` 15.3kb，`lifo-core` 懒加载保留 |
| `node scripts/verify-deploy.mjs --skip-build` | 76 passed / 0 failed / 5 skipped |
| `node scripts/instance-demo.mjs --skip-build` | 27/27 checks passed |
| `node scripts/instance-routing.mjs --skip-build` | 27/27 checks passed |
| `npm run audit:files`（--fail） | 0 over limit；`src/terminal/session.ts` 486 行按 O9 豁免 |
| 静态自检 | `src/`、`index.html` 无 emoji / `GREEN` |

已闭环：D1-D9、R3/R4、O1-O6、O7/O8/O10/O11、R5/R6、O12/O13/O14；
O9 条件延后（见 TASK-O9）。

上传/发布由用户执行，不纳入本计划任务。

CI 修复记录：run `31461743526`（nightly，2026-08-11）的 `nightly-scenarios` 在
S8 起连续崩溃（`Cannot read properties of undefined (reading 'wc'/'run')`）——
根因是场景间页面意外 reload 导致 `window.__succinix` 句柄丢失且无恢复路径。
`e7b3624` 给 harness 增加 `ensureScenario()`（20s 未恢复主动 reload 自愈）与场景
崩溃重试一次；`5ea8c10` 起 push 由 `e2e-full` job 覆盖，nightly 保留做深度回归。
后续 run `31473605209`（首次含 e2e-full 的 push）秒失败且零 job：`paths` 被误写在
job 级（非法键），GitHub 判定工作流无效。已把 e2e-full 拆为独立
`.github/workflows/e2e-full.yml`，`paths` 回到 workflow 级 `on.<event>` 下，本地
YAML 校验通过后重推验证。

## 2. 统一门禁与执行原则

- 每个 TASK 独立 commit、独立 PR，评审通过后合入。
- 本地收口命令（O13 已落地）：`npm run check`；全量 e2e 用 `npm run check:e2e`。
- 每项重构保持：tsc 0 / lint 0 / vitest 336+ / `?test=1 >=71` 且 0 failed。
- `?test=1` 输出顺序与数字不变；不改变 SDK 公开 API、`/cmd.json` 协议与
  host 资产文件名。
- 行数为 2026-08-11 基线，实施时以实际文件为准；O12 落地后以审计脚本输出为准。
- 重构不改行为；自动化补强不削弱现有断言。
- 涉及文档路径/引用的 TASK，必须在同一 PR 内同步 SDK/PROTOCOL/README/AGENTS，
  并跑 O14 文档完整性检查。
- 每个 PR 都必须通过静态自检：`src/`、`index.html` 无 emoji / `GREEN`。

## 3. 任务总表

| ID | 任务 | 优先级 | 依赖 | Owner | 状态 |
| --- | --- | --- | --- | --- | --- |
| O7 | 拆分 python-daemon 单文件 | P3 | 无 | TBD | `[x]` |
| O8 | 拆分 services 单文件 | P3 | 无 | TBD | `[x]` |
| O9 | `src/terminal/` 子模块化 | P3 | 无 | TBD | `[ ] 条件延后` |
| O10 | 拆分 pkg 单文件 | P3 | 无 | TBD | `[x]` |
| O11 | 拆分 `scripts/scenarios.mjs` | P3 | 无 | TBD | `[x]` |
| R5 | 同页多实例宿主行为补 e2e | P2 | 无 | TBD | `[x]` |
| R6 | 场景套件接入 push CI | P2 | 无 | TBD | `[x]` |
| O12 | 文件规模审计脚本 | P2 | 无 | TBD | `[x]` |
| O13 | 一行本地验收命令 | P2 | 无 | TBD | `[x]` |
| O14 | 文档/引用完整性检查 | P3 | 无 | TBD | `[x]` |

## 4. 详细任务

### TASK-O7：python-daemon 拆分（578 行）✅ 已闭环

- 建议结构：`src/engine/python-daemon/{loader,rpc,process-bridge}.ts`
- 职责拆分：Pyodide 加载、daemon RPC、进程桥接各自独立。
- 验收：O 系列门禁全过；`instance-demo` 27/27 不回归。
- 实际：`src/engine/python-daemon/{loader,rpc,pip,main}.ts`（拆分后最大 259 行，
  原 578 行）；`scripts/build-host.mjs` 入口同步改
  `src/engine/python-daemon/main.ts`，`host.js` 15.3kb、`public/pyodide/pyodide.mjs`
  external 保持；遗留旧文件删除与导入改写由 `fd1fa88` 收口。
- commit：`573d645` `refactor(O7): split python daemon loader/rpc/pip/main`

### TASK-O8：services 拆分（497 行）✅ 已闭环

- 建议结构：`src/services/{io,ports,lifecycle,registry}.ts`
- 职责拆分：服务文件 I/O、端口视图、生命周期、注册表。
- 验收：O 系列门禁全过；service/ports/db 场景不回归。
- 实际：`src/services/{io,registry,ports,lifecycle,types,index}.ts`（拆分后最大
  245 行，原 502 行）；13 处导入改指 `src/services/index.ts`。
- commit：`0d404a3` `refactor(O8): split services into domain modules`

### TASK-O9：`src/terminal/` 子模块化（session 486 行 / boot 408 行）⏸ 条件延后

- 建议：session 的输入解析/历史/补全，boot 的步骤编排/log 输出按需拆子模块。
- 条件：仅在继续扩展终端功能时执行，避免为拆分而拆分。
- 验收：O 系列门禁全过；SDK `./terminal` 导出与行为不变。
- 延后决定：本阶段终端功能无扩展计划，按条件不拆分；为保持 audit 门禁可 fail，
  `scripts/audit-file-size.mjs` 对 `src/terminal/session.ts`（486 > 450）设
  `EXEMPTIONS` 例外（注明原因），执行 O9 时移除豁免并重新收口。
- commit：`refactor(O9): modularize terminal session/boot internals`（待执行）

### TASK-O10：pkg 拆分（401 行）✅ 已闭环

- 建议结构：`src/pkg/{metadata,registry,installer}.ts`
- 验收：O 系列门禁全过；`pkg`/语言验证场景不回归。
- 实际：`src/pkg/{metadata,registry,installer,index}.ts`（拆分后最大 153 行，
  原 401 行）；导入方改指 `src/pkg/index.ts`。
- commit：`a2f5702` `refactor(O10): split pkg into metadata/registry/installer`

### TASK-O11：`scripts/scenarios.mjs` 拆分（838 行）✅ 已闭环

- 建议结构：`scripts/scenarios/{kernel,filesystem,services,languages,smoke}.mjs`
- 复用：`scripts/lib/harness.mjs` / `scripts/lib/cdp.mjs` / `scripts/lib/chrome.mjs`。
- 验收：O 系列门禁全过；scenarios 数量与输出不回归。
- 实际：`scripts/scenarios/{smoke(S1,S2),services(S3,S4),filesystem(S5,S8),
  kernel(S6,S7,S9,S10),languages(S11-S14)}.mjs`；`scripts/scenarios.mjs` 重写为编排
  runner，SCENARIOS 按数值序排序，`--only`/句柄恢复/崩溃重试/汇总格式与原一致；
  `scripts/lib/harness.mjs` 增加共享 check/printChecks/scenarioStats/
  resetScenarioStats/note 工具。
- 验证：本地 S1-S12 全过（S13/S14 因本机 npm registry 网络边界失败，与拆分无关）。
- commit：`3d3e5ff` `refactor(O11): split browser scenarios into suites`

### TASK-O12：文件规模审计与看门狗

- 建议：新增 `scripts/audit-file-size.mjs`，输出 `src/`、`scripts/` 前 20 大文件与阈值。
- 目标阈值：`src/**/*.ts` <= 450 行，`scripts/**/*.mjs` <= 700 行。
- 阶段策略：O7-O11 完成前先 warning 不 fail；完成后改为 fail 门禁并接入 CI。
- 验收：`npm run audit:files` 可复现输出；CI 在代码变更时执行。
- 实际：`audit:files` = `--fail` 模式，已接入 `npm run check` 与 CI `check` job；
  当前 0 over limit（`src/terminal/session.ts` 按 O9 豁免，见 TASK-O9）。
- commit：`86cdbd0` `chore(O12): add file size audit`

### TASK-O13：一行本地验收命令

- 建议：`package.json` 增加 `npm run check` =
  typecheck + lint + test + build + 静态自检；增加 `npm run check:e2e` =
  `npm run check` + `npm run test:e2e`（手动/CI 可选）。
- 目的：减少团队本地和 CI 的命令记忆成本，让新成员一条命令完成收口。
- 验收：`npm run check` 在干净 checkout 上通过；`npm run check:e2e` 可按需执行。
- 实际：`npm run check` = typecheck + lint + test + build + audit:files(--fail) +
  check:static + check:docs；`check:e2e` = check + test:e2e。
- commit：`baf3a8c` `chore(O13): add single-command quality gate`

### TASK-O14：文档/引用完整性检查

- 建议：新增 `scripts/check-docs.mjs`，扫描 `.md` 中引用的本地文件路径与文档名，
  缺失即失败；同时检查旧文档删除后的断链。
- 验收：`docs/` 增删文件后脚本通过；CI 对 docs-only push 也执行。
- 实际：`scripts/check-docs.mjs` 已接入 `npm run check` 与 CI；本轮修复了
  docs 中指向已删除 host 单文件入口的旧引用（O3 后统一指向 `src/engine/host/`）。
- commit：`76381ec` `chore(O14): add docs integrity check`

### TASK-R5：同页多实例宿主行为补 e2e

- 现状：跨容器双 tab 已 e2e；同页 `?instance=` 端口/ps/kill/reboot 目前以协议单测为主。
- 建议：在 `scripts/run-e2e.mjs` 或 `scripts/instance-demo.mjs` 增加同页双实例场景，
  覆盖同页共享 RPC 的端口事件分发与重启边界。
- 目标断言：`service start` 端口只注册到各自实例视图；`ps` 不显示对方进程；
  `kill` 越权拒绝；`reboot` 只重置自己，另一实例状态不变；同页快照按实例键隔离。
- 验收：新增步骤固定进 `npm run test:e2e`；`instance-demo` 27/27 保持。
- 实际：`scripts/instance-routing.mjs`（27/27 checks passed），已接入
  `scripts/run-e2e.mjs`；`5cc201e` 修复服务端口期望在 spawn 前注册 + 等待循环重读 portsView，
  `719e390` 补同页路由 e2e 覆盖。
- commit：`5cc201e`/`719e390` `fix(services)` + `test(R5)`

### TASK-R6：场景套件接入 push CI

- 现状：`instance-demo` 已在 run-e2e/nightly；push 门禁不含完整场景套件。
- 设计：保留 `check` 快路径（tsc/lint/unit/build/verify-deploy）；新增 `e2e-full`
  job 跑 `npm run test:e2e`，按路径触发 `src/**`、`scripts/**`、`public/**`、
  `vite.config.*`、`package*.json`、`.github/workflows/ci.yml`；纯 docs 变更跳过。
- 耗时控制：沿用 45min 预算；若超限，把 `verify-deploy + instance-demo` 与
  `scenarios + lang-verify + bench` 拆成两个 job。
- flake 策略：对已知 deploy gate flake 自动重试一次，失败时上传日志 artifact。
- 验收：源码变更的 push CI 全绿时包含场景门禁；docs-only push 不被拖慢；nightly 保留。
- 实际：新增 `.github/workflows/e2e-full.yml`（workflow 级 `paths` 过滤
  src/scripts/public/vite/vitest/tsconfig/eslint/package/ci.yml/e2e-full.yml；
  45min；失败上传 `e2e-full.log`）；`scripts/run-e2e.mjs` 对 verify-deploy 自动重试
  一次；`.github/workflows/ci.yml` 保留无过滤的 check 快路径与 nightly 深度回归。
- commit：`5ea8c10` `ci(R6): run scenario suite on push`

## 5. 建议执行顺序

已按顺序执行完毕：O12/O13 工具化 → R6 push 门禁 → R5 与 O7/O8/O10/O11 并行 →
O14 收口；O9 按条件延后到终端特性扩展时再执行。

## 6. 执行与协作约定

- Owner：任务总表中的 `TBD` 由团队认领，认领后更新 Owner 列。
- Branch/PR：`next/<id>-<slug>`；PR 标题含 TASK ID；合入前完成评审。
- DoD：PR 合入时 tsc/lint/unit/build/e2e（按任务范围）全绿；文档/引用同步；
  计划文件状态打勾并记录实际行数/命令输出。
- Rollback：合入后若发现行为回归，优先 revert 对应 PR，不在主分支热修。
- 进度：每个 TASK 完成后更新本文件，避免计划与实现脱节。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 全量 e2e 拖慢 push | R6 路径过滤 + job 拆分 + nightly 保留 |
| 文件行数基线过期 | O12 审计脚本输出作为唯一事实来源 |
| 重构破坏导出/协议 | API/protocol freeze + `npm pack --dry-run` + 协议单测 |
| 文档断链 | O14 文档完整性检查 + 文档同步约定 |
| CI flake | 已知 gate 自动重试一次 + 失败日志 artifact |

---

*MASTER PLAN NEXT by Hermes（沈知夏），2026-08-11。执行中规格与实现冲突 → 以实际代码
为准并记录差异，不静默改规格。阶段验证点未过不跳级。*
