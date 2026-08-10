# Succinix Engineering Review & Unified Fix Plan

> 审查日期：2026-08-10
> 审查对象：`docs/MASTER-PLAN.md` 计划完成情况、代码组织、大文件解耦
> 结论：功能主线已完成并可通过本地质量门，但 0.4.0 发布/F4 尚未闭环；存在 1 个 SDK 分层缺陷、1 个同页端口分发缺陷、以及若干实例边界问题。

---

## 1. 审查范围与结论

- 功能提交覆盖：E1-E4、M1-M5、U1、F1/F2 均有对应 commit。
- F3/F4 只有 CI 配置和文档，无线上/发布闭环证据；`MASTER-PLAN.md` §11 仍为未勾选状态。
- 本地门禁全部通过，但通过门禁不能覆盖同页共享 RPC 的端口分发、实例重启、共享 FS 快照隔离等边界。
- 本次审查未修改业务代码，工作区保持干净。

## 2. 本地实测门禁

| 门禁 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | 0 errors |
| `npm run lint` | pass |
| `npm run test:coverage` | 320 tests / 23 files；95% lines，阈值 70% |
| `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` | 无匹配 |
| `node scripts/build-host.mjs` | pass |
| `npm run build` | pass |
| `npm run build:engine-package` | pass |
| `node scripts/verify-deploy.mjs --skip-build` | COOP/COEP 正确；`?test=1` 76 passed / 0 failed / 5 skipped |
| `node scripts/instance-demo.mjs --skip-build` | 27/27 checks passed（双 tab 实例 + 双用户） |

## 3. MASTER-PLAN 完成状态

| 任务 | 状态 | 证据/缺口 |
| --- | --- | --- |
| E1 终端会话提取 | 已完成 | `src/terminal/session.ts` + 单测 |
| E2 boot 参数化 | 已完成 | `src/terminal/boot.ts` SDK 化，应用 boot 步骤注入 `src/boot-steps.ts`（D1 已修复） |
| E3 main.ts 组装层 | 已完成 | `src/main.ts` 已瘦身到 560 行 |
| E4 engine 打包 | 部分完成 | 本地 `build:engine-package` 通过；版本仍是 0.1.3 |
| M1 persist key 注入 | 已完成 | `src/persist/` 多 key 单测通过；同页快照按实例 scope 隔离（D4 已修复） |
| M2 状态文件路径参数化 | 已完成 | 浏览器侧参数化 + db start 透传 `statePrefix` 到 tinbase `--data-dir`（D6 已修复） |
| M3 协议 instanceId | 已完成 | 协议单测覆盖；同页 e2e 仍是盲区 |
| M4 service/ports/db 实例化 | 已完成 | 跨容器 e2e 通过；同页端口按实例分发（D2 已修复） |
| M5 聚合 API | 已完成 | reset-instance 协议实现真实实例级重 boot（D3 已修复） |
| U1 多用户语义 | 已完成 | `?user=` 双 tab 27 项断言通过 |
| F1 文档定稿 | 已完成 | CHANGELOG/SDK/PROTOCOL/FEATURES 已更新 |
| F2 文档扫尾 | 已完成 | README/FEATURES 门禁数字统一为 `>=71`、实测 76（D7 已修复） |
| F3 CI 全绿 | 未验证 | 有 workflow，无 `gh run` 结果证据 |
| F4 最终验收 | 未完成 | 版本未 bump、未发布、未部署验证、§11 未勾选 |

## 4. 未完成项

### R1. 0.4.0 发布/最终验收未闭环

- `package.json` 版本仍为 `0.3.0`；`packages/engine/package.json` 仍为 `0.1.3`。
- `MASTER-PLAN.md` §11 全部为未勾选状态。
- npm 0.4.0 干净安装、GitHub Release、Vercel 部署站 `?instance=`/`?user=` 均无仓库内证据。

建议：完成 P0/P1 缺陷修复后，由用户/Hermes 执行发布流程并回填 §11。

### R2. F3/F4 无远程证据

- `.github/workflows/ci.yml` 有 push 门禁和 nightly-scenarios，但本次无法验证线上 job conclusion。
- `webunix-development` 技能更新仅出现在计划清单中，仓库内无产物。

建议：修复后跑一次完整 CI，并在验收文档中附 `gh run view` 结果。

### R3. instance-demo 未接入自动门禁

- `scripts/instance-demo.mjs` 已覆盖 27 项，但未加入 `scripts/run-e2e.mjs` STEPS，也未加入 CI。

建议：至少加入 nightly CI；若能控制在合理时长，再加入 `npm run test:e2e`。

### R4. 质量门数字不一致

| 来源 | 数字 |
| --- | --- |
| `MASTER-PLAN.md` | `?test=1` ≥76 |
| `scripts/verify-deploy.mjs` | MIN_PASSED=71，注释残留 >=67 |
| `README.md` | 第 107 行 >=71，第 157 行 >=57 |
| `docs/FEATURES.md` / zh | >=57 |

风险：71-75 之间的自检回归会被放行。

## 5. 缺陷与边界问题

### D1. TerminalBoot 违反 SDK 分层边界（高）

- 计划要求 `TerminalBoot` 不 import `persist/log/config/commands`。
- 实际 `src/terminal/boot.ts` 直接 import `persist/config/services/motd/log/host-restart`，还从应用层 `src/boot-ui.ts` 引入 `BootUI`。
- `build-engine-package.mjs` 会把 terminal SDK bundle 成自包含产物，因此上述应用层代码会进入 `@succinix/engine/terminal`。

建议：
- `BootUI` 接口下沉到 terminal SDK 或共享接口模块，DOM/xterm 实现留在应用层。
- `runApplicationBootSteps` 移到 app 层；`createTerminalBoot` 只负责流程编排，app 级步骤由宿主注入。

### D2. 同页共享 RPC 路径没有端口事件分发（高）

- `createSuccinixInstance` 的 `rpc` 分支只调用 `waitForHostReady`，不调用 `bootEngineHost`，因此该实例的 `ports` map 收不到 `server-ready`。
- `engine/index.ts` 的 `wcListenersBound` 只注册一次，且闭包捕获首个 hooks；同页第二个实例即使自建 host 也收不到端口事件。
- 结果：同页第二个实例执行 `service start`/`db start` 时，`instancePorts.portsFor` 一直拿不到 URL，最终 30s 超时。

建议：实现页面级 ports registry/分发：
1. 页面级维护一份 `Map<port, url>` ready registry 和 hooks 分发表。
2. `server-ready`/`port close` 到达后，按 `instancePorts.expected` 分发到对应实例视图。
3. 无法归属的端口保留在页面级，不进任何实例视图。
4. 增加 fake `server-ready` 单测覆盖 `rpc` 共享路径。

### D3. `restart()` 不是真正的实例级重 boot（中高）

- 当前实现只做 `persist.clear()` + rm stateRoot + 重建 session。
- 未停止仍运行的服务进程。
- 未清理 `ports`、`instancePorts.expect`、`dbActivePortByInstance`。
- 未清理 host 侧 `sessionCwdByInstance` 等内存缓存。
- 未重跑应用级 bootsteps（workspace/env/services/motd/autostart）。

建议：`restart()` 语义改为：
1. 停掉该实例仍运行的服务。
2. 清端口期望与活动端口记录。
3. 清 host 侧实例缓存（通过协议或 host 重启接口）。
4. 重建 session 并重跑应用级 bootsteps。
5. 补“重启后旧进程不再存活/旧 cwd 不残留”的单测。

### D4. 同页快照内容没有按实例隔离（中高）

- `persist.ts` 的 `collectDir`/`collectWithGate` 始终从 `/` 遍历共享 FS。
- 同页实例 A 的快照会包含 B 的状态根、用户 home、文件、tinbase 目录。
- 现有 `tests/persist-instance.test.ts` 使用独立的 FakeFS，未覆盖共享 FS 场景。

建议二选一：
- 短期：在 SDK.md 明确“同页快照是整棵 FS 快照，仅 key 隔离”。
- 长期：为 `createPersist` 增加 scope 根路径，按实例只遍历其状态根/工作区范围。

### D5. 实例 tinbase 目录未进入快照排除规则（中）

- `isExcludedPath` 只排除 `.tinbase` 段。
- `/workspace/.succinix-<id>/tinbase` 会被遍历，可能反复读二进制 DB 文件。

建议：把 `.succinix-*/tinbase` 或状态根下的 `tinbase` 加入排除规则，并补单测。

### D6. `statePrefix` 对 db 不一致（中）

- `src/commands.ts` 调用 `tinbaseDataDir(inst)` 时未传 `statePrefix`。
- 其他 config/services/motd 路径均透传 prefix，自定义前缀下数据库目录会落在内置前缀。

建议：统一改为 `tinbaseDataDir(inst, ctx.statePrefix)`，并补 `statePrefix + db` 路径单测。

### D7. F2 文档扫尾仍有陈旧内容（低）

- `README.md:157` 写 `>=57`，与 CI 的 `>=71` 不一致。
- `docs/FEATURES.md` 版本仍写 `0.3.0`，但同一文件已描述 0.4.0 能力。
- `docs/SDK.md` 版本生命周期仍以 0.1.3/0.3.0 收尾。

## 6. 代码组织与大文件分析

### 6.1 当前规模

| 文件 | 行数 | 主要职责 |
| --- | --- | --- |
| `src/commands.ts` | 1520 | 25 个本地命令 + 工作区/netstat/uname 等纯函数 |
| `src/tests.ts` | 923 | `?test=1` 自检全部断言，单函数 `runTests` |
| `src/engine/host.ts` | 831 | host daemon：RPC 循环、node/lifo/python、spawn、ps/kill |
| `src/terminal/boot.ts` | 586 | boot 流程 + 应用级 bootsteps 混合 |
| `src/engine/python-daemon.ts` | 578 | Pyodide daemon |
| `src/main.ts` | 560 | xterm 装配、自动快照、看门狗、dev hooks、demo |
| `src/services.ts` | 476 | 服务文件 I/O、端口视图、生命周期 |
| `src/persist.ts` | 454 | 排除规则、收集、签名、IndexedDB、实例上下文 |
| `src/terminal/session.ts` | 486 | 无 UI 终端核心 |
| `scripts/scenarios.mjs` | 1047 | 14 个浏览器场景 |
| `scripts/lang-verify.mjs` | 496 | 语言生态验证 |
| `scripts/instance-demo.mjs` | 450 | 多实例/多用户 demo |

### 6.2 分层现状

| 层 | 现状 | 问题 |
| --- | --- | --- |
| `src/engine/*` | 自包含，无 app 层 import | 良好 |
| `src/terminal/*` | `boot.ts` import persist/config/services/motd/log/boot-ui | D1：SDK 边界被破坏 |
| `src/instance/*` | import persist/services | 有意为之，但应作为稳定契约，避免再扩大 |
| `src/commands.ts` | 一个文件承载 25 个命令 + 纯函数 | 大文件，跨域混合 |
| `src/main.ts` | 装配 + 应用特性混合 | 可继续拆分 |
| `src/tests.ts` | 单函数 900 行 | 难以维护，且被 scripts 间接依赖 |
| `scripts/*.mjs` | 6 个脚本各自复制 CDP/Chrome 引导 | 重复代码约百行/文件 |

### 6.3 依赖与循环风险

- `src/commands.ts` import `src/boot.ts` 仅为 `detectSystemInfo`；而 `boot.ts` 不依赖 commands，方向不循环但语义不合理。
- `src/tests.ts` import `src/commands.ts` 的 10+ 个导出；拆分 commands 时必须保留这些导出或同步迁移。
- `src/terminal/boot.ts` 被 `src/boot.ts`、`src/main.ts` 和 engine package 共同引用，是当前最危险的分层节点。

## 7. 解耦优化规划

### O1. `src/commands.ts` 拆分为 `src/commands/` 目录

建议结构：

```text
src/commands/
  types.ts          # CommandContext
  registry.ts       # tryHandleLocalCommand 分发
  help.ts
  system.ts         # sysinfo/free/top/cache/reboot/shutdown/version/whoami
  snapshot.ts
  workspace.ts
  config-cmds.ts    # env/settings
  service-cmd.ts
  db.ts
  pkg-cmd.ts
  log-cmd.ts
  network.ts        # netstat/ip
  identity.ts       # uname/motd/lang
```

原则：
- 保留所有被 `tests.ts`/`main.ts` 使用的导出。
- `tryHandleLocalCommand` 只做命令注册与分发。
- 每个命令域自带纯函数与输出格式，不互相引用。

### O2. `src/main.ts` 拆分为 `src/app/`

建议结构：

```text
src/app/
  xterm.ts          # Terminal/FitAddon 创建、字体设置
  output.ts         # TerminalOutput/Terminal shim
  local-commands.ts # LOCAL_COMMAND_NAMES + makeLocalHandlers
  logging.ts        # makeSessionLogger/makeClientLogger
  auto-snapshot.ts
  watchdog.ts
  dev-hooks.ts      # bench/scenario/test window handles
  main.ts
```

原则：`main.ts` 最终只负责启动顺序，应用特性全部可单独测试。

### O3. `src/engine/host.ts` 按 host 内部职责拆分

建议结构：

```text
src/engine/host/
  config.ts         # engine config/env/cwd
  rpc.ts            # cmd.json/result 循环、TTL/prune
  run.ts            # node/lifo/python 分发
  spawn.ts          # spawnTracked/attachOutputCollector/currentRun
  ps-kill.ts
  main.ts           # 入口
```

注意：`scripts/build-host.mjs` 只改变入口路径，产物仍是单一 `public/host.js`。

### O4. `src/persist.ts` 拆分为快照子模块

建议结构：

```text
src/persist/
  types.ts
  exclusions.ts     # isExcludedPath/scope
  collect.ts        # collectDir/signature/gate
  idb.ts
  context.ts
  index.ts
```

优先配合 D4/D5 的实例 scope 与 tinbase 排除规则一起做。

### O5. `src/tests.ts` 拆分为 `src/selftest/`

建议结构：

```text
src/selftest/
  runner.ts         # runTests/verdict/boundary/TestResult
  kernel.ts
  filesystem.ts
  persistence.ts
  config.ts
  services.ts
  packages.ts
  network.ts
  process.ts
  languages.ts
  smoke.ts
```

原则：保持 `?test=1` 输出顺序和 76 passed 数字不变；拆分只改变组织，不改变断言。

### O6. 脚本共享 CDP/Chrome 工具

以下 6 个脚本各自复制了 Chrome 发现/CDP 客户端/eval 逻辑：

- `scripts/verify-deploy.mjs`
- `scripts/verify-bootgate.mjs`
- `scripts/bench.mjs`
- `scripts/scenarios.mjs`
- `scripts/lang-verify.mjs`
- `scripts/instance-demo.mjs`

建议新增：

```text
scripts/lib/
  chrome.mjs        # findChrome/launchChrome/cleanup
  cdp.mjs           # CDP client/evalValue
  harness.mjs       # waitForHttp/run/makeTab 等
```

各脚本只保留业务场景，不重复基础设施。

## 8. 统一修复清单

| ID | 类型 | 优先级 | 问题 | 位置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| R1 | 发布 | P0 | 0.4.0 未 bump/发布/验收 | `package.json`、`packages/engine/package.json`、§11 | 未开始 |
| R2 | 验证 | P0 | CI/部署无远程证据 | `.github/workflows/ci.yml` | 未开始 |
| R3 | 自动化 | P1 | instance-demo 未接入 CI/e2e | `scripts/run-e2e.mjs`、CI | 已完成（7326bdb） |
| R4 | 门禁 | P1 | `?test=1` 门禁数字不一致 | verify-deploy/README/FEATURES | 已完成（7326bdb） |
| D1 | 架构 | P0 | TerminalBoot 分层边界破坏 | `src/terminal/boot.ts` | 已完成（7326bdb） |
| D2 | 功能 | P0 | 同页端口事件未分发 | `src/instance/index.ts`、`src/engine/index.ts` | 已完成（7326bdb） |
| D3 | 功能 | P1 | restart 非真正重 boot | `src/instance/index.ts:208` | 已完成（7326bdb） |
| D4 | 隔离 | P1 | 同页快照含其他实例内容 | `src/persist.ts:225` | 已完成（7326bdb） |
| D5 | 性能/语义 | P2 | 实例 tinbase 未排除 | `src/persist.ts:98` | 已完成（7326bdb） |
| D6 | 一致性 | P1 | db 忽略 statePrefix | `src/commands.ts:291` | 已完成（7326bdb） |
| D7 | 文档 | P2 | README/FEATURES 陈旧数字 | `README.md`、`docs/FEATURES.md` | 已完成（7326bdb） |
| O1 | 重构 | P2 | commands.ts 1520 行拆分 | `src/commands.ts` | 已完成（0e4454b） |
| O2 | 重构 | P2 | main.ts 应用特性拆分 | `src/main.ts` | 已完成（efcdfb5） |
| O3 | 重构 | P2 | host.ts 831 行拆分 | `src/engine/host.ts` | 已完成（fb84492） |
| O4 | 重构 | P2 | persist.ts 454 行拆分 | `src/persist.ts` | 已完成（95d21bd） |
| O5 | 重构 | P2 | tests.ts 923 行拆分 | `src/tests.ts` | 已完成（37dab85） |
| O6 | 重构 | P2 | 脚本 CDP 重复代码 | `scripts/*.mjs` | 已完成（工作区，含 bench 清理修复） |

## 9. 建议执行顺序

1. 先修 P0：D1（SDK 分层）、D2（同页端口分发）。
2. 再修 P1：D3（restart）、D4（快照 scope）、D6（statePrefix）、R4（门禁数字）。
3. 补齐 P1 自动化：R3（instance-demo 进 CI/nightly）。
4. 清理 P2：D5、D7。
5. 分阶段做 O1-O6 重构，每个拆分独立 commit 并保持全部门禁通过。
6. 最后执行 R1/R2：统一 bump 0.4.0、发布、部署、回填 §11。

## 10. 残余风险

- 同页多实例的端口分发、restart、快照边界已修复（D2/D3/D4），但同页宿主行为仍以协议级单测为主，双 tab e2e 已覆盖。
- CI、Vercel 部署、npm 发布传播无法在本地完全验证。
- `scripts/instance-demo.mjs` 27/27 通过，已加入 `run-e2e` STEPS 与 nightly CI（R3），但 push 门禁不含场景套件，仍有静默回归可能。

---

本文档为工程验收记录与修复追踪清单；对应代码修复完成后，应逐项更新状态并重跑 §2 门禁。
