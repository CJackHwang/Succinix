# STATUS

## 一、架构健康度

- 模块总数：核心 12 个（`app`、`commands`、`engine`（含 `host`、`python-daemon`、`ruby-runtime`）、`host`、`instance`、`persist`、`pkg`、`plugin`、`services`、`terminal`、`userland`、`theme`）。
- 违规跨模块调用：0。`npm run check:plugin-boundaries`、`check:dsh-shapes`、`check:dsh-keys` 均通过；`engine`、`terminal`、`persist`、`services` 保持 Cordis-free，所有 `src/plugin/` 文件带 invariant 标记。

## 二、本次变更影响范围

- 修改功能：完成 v0.7.0 全量升级，包括每实例 SandboxContext、带 nonce/ack/scheduler 的 RPC v2、Lifo `ITerminal` 交互传输、持久化 v2（binary chunk、LKG、session segments、legacy 检测）、Ruby/WASI adapter、UserlandRegistry、`succinix` 管理命令、服务单一真源、日志脱敏和类型化事件。
- 摸到的文件：约 220 个，覆盖源码、测试、构建/质量脚本、CI、包配置、Cordis 示例和双语文档。
- 接口契约：engine 插件根形态仍为 `{ name, apply, Config }`；新增可选 `rubyAssetsUrl`，RPC/终端采用 v2 协议；新增 `command-start`、`command-finish`、`runtime-ready`、`degradation`、`persistence`、`terminal-open`、`terminal-close`、`terminal-backpressure` 事件；快照使用独立 v2 IndexedDB，不迁移或删除 v0.6 数据。
- 验证证据：`npm run check`、`npm run test:e2e`、`npm run test:bench -- --skip-build --port 7910`、`npm run test:bench:soak -- --skip-build --port 7910`、`npm audit --audit-level=high` 全部通过。三轮 benchmark 的中位 P95：Lifo 57.85 ms、Node 117.40 ms、1000 文件 snapshot 214.85 ms、交互 36.24 ms、session append 1.30 ms。

## 三、已知风险点

- S13 的首次临时 npm 安装曾发生一次外部网络波动，既有重试后通过；该风险来自远端包获取，不影响已验证的本地功能。
- WebContainer 平台限制仍有效：仅 Chromium 桌面环境；不提供真实内核、apt、权限位、原生二进制、入站网络或通用 Node/Python 子进程 PTY。
- 多实例是组织性隔离，不是安全边界。

## 四、下次最该做的事

1. 由 release owner 在 staging 环境复跑 `npm run check:release`，确认外部依赖源稳定后再决定发布。
2. 未获明确授权前不执行 npm publish；保留 v0.6 分支与旧 package tarball 作为发布回滚依据。
