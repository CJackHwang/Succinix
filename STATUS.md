# STATUS

## 一、架构健康度

- 模块总数：核心 12 个（`app`、`commands`、`engine`（含 `host`、`python-daemon`、`ruby-runtime`）、`host`、`instance`、`persist`、`pkg`、`plugin`、`services`、`terminal`、`userland`、`theme`）。
- 本轮已收敛 host epoch、终端回压、实例 canonicalization、服务生命周期、staging restore 和 host 退出清理；`check:plugin-boundaries`、DSH 形状/键和生命周期门禁通过。
- 仍有运行时环境风险：WebContainer bootstrap、Python micropip 和 Chrome 压力 gate 依赖外部运行时，不能用静态检查替代真实浏览器验收。

## 二、本次变更影响范围

- 修改功能：完成开发审计清单 A-01 至 A-08、B-01 至 B-15、B-17、C-01 至 C-05 的实现、调用点、合同测试、浏览器诊断脚本和迁移文档；B-16 需要同一环境连续三轮 benchmark 重新生成基线。
- 摸到的文件：`src/engine`、`src/persist`、`src/services`、`src/plugin`、`src/terminal`、`src/userland`、测试、质量脚本、CI、SDK/协议/迁移文档及审计报告。
- 接口契约：移除未接线的旧 terminal 配置和浏览器侧 service 生命周期；RPC v2、Lifo terminal seam、实例隔离和 package integrity 合同保持单一执行世界路径。
- 发布状态：功能提交已完成，但同一环境的真实浏览器部署、三轮 benchmark 和全量 soak 尚未取得全绿结果。

## 三、已知风险点

- `npm run test:e2e` 的场景流程已完成 14/14，但 deploy、terminal、benchmark、instance 与 Cordis 合同的部分 Chrome hook 停在 WebContainer bootstrap；语言验证另有 `micropip` 网络失败。
- `npm run test:bench` 和 `npm run test:bench:soak` 受同一 bootstrap stall 阻断，未产生可用于 B-16 的三轮性能基线或完整 soak 结果。
- `npm run audit:deps` 本次因 npm audit TLS 连接被关闭而未完成，不能把旧审计结论当作当前网络证据。
- 平台限制仍有效：仅 Chromium 桌面环境；不提供真实内核、apt、权限位、原生二进制、入站网络或通用 Node/Python 子进程 PTY。

## 四、下次最该做的事

1. 在可稳定启动 WebContainer 且可访问 micropip 的 Chromium 环境，重跑 `npm run test:e2e`、`npm run test:bench` 和 `npm run test:bench:soak`；三轮 benchmark 全绿后用 `--record-baseline` 生成 B-16 基线。
2. 若压力门禁仍失败，按 `scripts/lib/chrome.mjs` 生成的 stderr、页面事件、进程树、端口和截图定位环境问题或产品回归，再决定发布。

<!-- STATUS_EVIDENCE
{
  "schemaVersion": 2,
  "head": "b51cc7f5432487932eab4c65084d5993d6d86186",
  "recordedAt": "2026-08-18T06:27:10.000Z",
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
      "completedAt": "2026-08-18T06:16:00.000Z",
      "outputSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "summary": "TypeScript type check completed without diagnostics."
    },
    {
      "command": "node scripts/build-host.mjs",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T06:16:20.000Z",
      "outputSha256": "ebc0931c56cff6692eb9a8ebff390a2f1f3b7afe681a63a554b8f76946a7b5da",
      "summary": "Host, lazy Lifo core, Ruby runtime, and Python daemon were built."
    },
    {
      "command": "npm run build",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T06:16:20.000Z",
      "outputSha256": "ff6d9b96e5cf5ef0a5fb00c93a4866b914e4ecab83d3d989c1b6f8153a0a4665",
      "summary": "Production host and Vite client build completed."
    },
    {
      "command": "npm run lint",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T06:16:00.000Z",
      "outputSha256": "4797d849cc4a3749a5ecc45068ed10ad473a889babdcebd2c545f58f8614043f",
      "summary": "ESLint completed without errors."
    },
    {
      "command": "npm run test",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T06:16:30.000Z",
      "outputSha256": "9603357a4bd6ac22f8bee51782f64ddf6131607e273f690ac647416d61815f37",
      "summary": "65 test files and 684 tests passed."
    },
    {
      "command": "npm run test:coverage",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T06:16:30.000Z",
      "outputSha256": "edd0966bac18c6a20021d579226749e31e6585424a6f6f649868a27606c4a673",
      "summary": "65 test files and 684 tests passed; all configured coverage thresholds passed."
    },
    {
      "command": "npm run check:docs",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T06:16:00.000Z",
      "outputSha256": "95fe590678da83ea97909936e37055cb8ffde12c0720df6d87daf6ebdf180bcc",
      "summary": "25 markdown files completed local-reference validation."
    },
    {
      "command": "npm run check:plugin-boundaries",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T06:16:00.000Z",
      "outputSha256": "ed8656256f78f0f5157841f5afe6b489a5094972dcde1d99aac2d09e9f84aea3",
      "summary": "Cordis boundary and plugin invariant checks passed."
    },
    {
      "command": "npm run check:engine-package",
      "result": "passed",
      "exitCode": 0,
      "completedAt": "2026-08-18T06:17:00.000Z",
      "outputSha256": "7d5d492722610f74abff126ec6cae5fd85e1fb07d145f09724f2ca6a370a3c60",
      "summary": "Engine package build, asset hash generation, export validation, and npm pack dry run passed."
    },
    {
      "command": "npm run test:e2e",
      "result": "blocked",
      "exitCode": 1,
      "completedAt": "2026-08-18T06:27:10.000Z",
      "outputSha256": "69ebf5e28aae1fb469283e24ff14fd55b774d7b6a557f7d41aedf0d7d55098bb",
      "summary": "Full browser pipeline is blocked by WebContainer bootstrap and micropip network failures; scenarios completed 14/14."
    },
    {
      "command": "npm run test:bench",
      "result": "blocked",
      "exitCode": 1,
      "completedAt": "2026-08-18T06:27:10.000Z",
      "outputSha256": "2ee0b05bd93d939126b3b6da663ec6efc22f1962b71ec106b89ec394018ecdaf",
      "summary": "Benchmark hook remained at the WebContainer bootstrap overlay; no three-run sample exists."
    },
    {
      "command": "npm run test:bench:soak",
      "result": "blocked",
      "exitCode": 1,
      "completedAt": "2026-08-18T06:27:10.000Z",
      "outputSha256": "e57ee59ce3b0fd94f59f04429a9237bbdd8cd7130e36b089fc0085d3f59a18ef",
      "summary": "The bootstrap stall prevented all soak profiles from entering their assertions."
    }
  ]
}
-->
