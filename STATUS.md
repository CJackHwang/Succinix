# STATUS

## 一、架构健康度

- 模块总数：核心 12 个（`app`、`commands`、`engine`（含 `host`、`python-daemon`、`ruby-runtime`）、`host`、`instance`、`persist`、`pkg`、`plugin`、`services`、`terminal`、`userland`、`theme`）。
- host epoch、终端回压、实例 canonicalization、服务生命周期、staging restore、进程退出清理和交互终端调度均有源码及单测证据；浏览器门禁的 preview 与 DevTools 端口现在独立分配。
- Cordis 运行时唯一基线为 DeepSeek Harness 的 `@deepseek-ai/cordis@4.0.1`；根依赖图不再包含上游 `cordis` 或 `@cordisjs/*` 平行链。
- 全部公开文档以英文主文档和完整简体中文对应页成对维护；协议、类型快照和发布契约保留必要的精确细节，并明确不是新手教程。

## 二、本次变更影响范围

- 拆分超出 CI 行数限制的宿主终端和交互编辑器测试模块，保持 `terminal.ts` 原有导出路径不变。
- 修复基准门禁：每个环境仍执行绝对预算与稳定性检查，历史回归只在构建输入和执行环境同时匹配时比较。
- 修复浏览器门禁的固定端口误连；部署自检使用独立 preview/DevTools 端口，终端交互门禁完成清理后明确退出。
- 未改变 `@succinix/engine` 的 peer 契约、RPC v2、Lifo terminal seam、实例隔离、service snapshot 或 package integrity 接口。

## 三、已知风险点

- 平台限制仍有效：仅 Chromium 桌面环境；不提供真实内核、apt、权限位、原生二进制、入站网络或通用 Node/Python 子进程 PTY。
- WebContainer、micropip 和虚拟 preview 依赖浏览器/运行时提供方；这些是设计边界，不是本轮门禁失败。
- benchmark 指标是当前 macOS + Chromium 环境的性能样本，不代表其他设备的绝对性能。
- 本轮 `test:e2e` 已通过 deploy 与 terminal-interactive，并在 bench 输出完整采样结果后因残余句柄未退出；`test:bench:soak` 未重跑，均不能视为本轮通过。
- GitHub 的失败根因是文件规模和跨环境错误比较的基准门禁；需在远端干净 runner 上触发本地提交后的工作流确认完整发布链路。

## 四、下次最该做的事

1. 修复 bench 与 soak 脚本在输出结果后的残余句柄，再重跑完整浏览器门禁。
2. 将提交推送后观察 GitHub `CI` 与 `e2e-full` 的干净 Ubuntu runner 结果。
3. 后续只以 DeepSeek Harness 发布的 `@deepseek-ai/cordis` 与其 `master` 源码作为 Cordis 对齐基线。

<!-- STATUS_EVIDENCE
{
  "schemaVersion": 2,
  "head": "8a186d304bdc7f42be9d7fc8e1edf573e4f68d65",
  "recordedAt": "2026-08-18T21:35:42.000Z",
  "environment": {
    "node": "v22.23.1",
    "platform": "darwin",
    "arch": "arm64"
  },
  "commands": [
    {
      "command": "npx tsc -p tsconfig.json --noEmit",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T20:08:41.000Z",
      "outputSha256": "a7ea8c73e233ee1db113ffeb44465097c9b9669a06a6610529ae80166f928034",
      "summary": "TypeScript type check completed without diagnostics."
    },
    {
      "command": "node scripts/build-host.mjs",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T15:55:00.000Z",
      "outputSha256": "2c8196fa8e309319c4c3b6c2ee887f9c93fc5657de4581da42aceecca4999495",
      "summary": "Host, lazy Lifo core, Ruby runtime, and Python daemon built successfully."
    },
    {
      "command": "npm run build",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T15:55:00.000Z",
      "outputSha256": "1f1fad39b22a0c0155d7dff3d1d23e6af3ff0d9917b8a69c1f7558a80c26ce95",
      "summary": "Production Vite build completed successfully."
    },
    {
      "command": "npm run lint",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T15:50:00.000Z",
      "outputSha256": "b96dedb357b1092c01b61d4ca7a282636b322c10e50268fed3e6f100521fc6a8",
      "summary": "ESLint completed without errors."
    },
    {
      "command": "npm run test",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T15:52:00.000Z",
      "outputSha256": "1e68f5e2866dc5c7a6368fbdad6b54d8dee8164c918b5195ea8c8ca583c253ef",
      "summary": "65 test files and 688 tests passed."
    },
    {
      "command": "npm run test:coverage",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T15:52:00.000Z",
      "outputSha256": "3b4ba2c68ba78530013518ad76a76f30cae381692ead6ac58b5e830d15ff69f1",
      "summary": "688 tests passed; statements 80.44%, branches 71.05%, functions 80.50%, lines 86.57%."
    },
    {
      "command": "npm run check:docs",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T21:35:42.000Z",
      "outputSha256": "c0224a7543ef60c136eda26684ea95a41587c70274d74bf3cbe65b92a8b361bc",
      "summary": "27 markdown files passed local-reference validation after bilingual pages were restored."
    },
    {
      "command": "npm run check:plugin-boundaries",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T15:50:00.000Z",
      "outputSha256": "a4a8bb7695d8422d70529b6775fabd23458980e1d3fc2be0c2bf784e40c066be",
      "summary": "Cordis boundaries and plugin invariant markers passed."
    },
    {
      "command": "npm run check:engine-package",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T15:55:00.000Z",
      "outputSha256": "a32e3f0dc5935d7c226b60cebfe2db02c245de65f7d1328ae17497ba1feee3f4",
      "summary": "Engine package build, asset hashes, export validation, and npm pack dry run passed."
    },
    {
      "command": "npm run test:e2e",
      "result": "failed",
      "exitCode": 143,
      "completedAt": "2026-08-18T20:03:00.000Z",
      "outputSha256": "5680a175e06f50abf2870513b3ad1ef44368ba53a222f1d397ac15dd368dc20f",
      "summary": "Deploy self-test and terminal-interactive completed, then the benchmark child stalled during Chrome cleanup and the process was terminated."
    },
    {
      "command": "npm run test:bench",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T15:37:00.000Z",
      "outputSha256": "57b6985eb3a5f8e8c3d75bd2e3acdf826ab8c3bd80e70bfa33ac413285e2c0f9",
      "summary": "Three independent headless Chrome benchmark runs recorded the dependency-cleanup baseline and retained per-run p95 metrics."
    },
    {
      "command": "npm run test:bench:soak",
      "result": "failed",
      "exitCode": 143,
      "completedAt": "2026-08-18T20:07:00.000Z",
      "outputSha256": "ab4cef3f5edc068d15a57ecec5931b105b6f8ae95890451ebafbc39ca78c67b9",
      "summary": "The browser pressure run became idle during Chrome cleanup and was terminated before the soak gate could report completion."
    }
  ]
}
-->
