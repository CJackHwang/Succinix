# WebUnix — TASK21：生态铺路（引擎解耦 + 协议契约 + SDK 形态）

## 背景

CI 建设完成（TASK20）。本任务 = **生态铺路**：把 TerminalExecutor 引擎从 WebUnix 前端解耦成可复用模块，输出权威协议契约文档，评估并落地 SDK/脚手架形态——目标：**他人前端项目可内嵌 WebUnix 引擎做沙箱**（用户战略：封包/脚手架化，作为生态）。

## 0. 跟进修复（TASK20 复审建议，小项）

1. **setup-hooks 保护第三方 hook**（中低）：非 `--force` 且 .git/hooks/pre-commit 存在但内容不含本脚本 → 拒绝并提示加 --force，绝不静默覆盖
2. **tests 纳入 typecheck**（低）：tsconfig include 加 tests/（或独立 tsconfig.test.json + typecheck:test 脚本）
3. **文档清残**（低）：verify-deploy.mjs 残留 `>=51` 注释改 57；CHANGELOG 覆盖率数字与实测对齐（90.62/74/92.8/93.46）

## 1. 引擎解耦（核心）

目标：`src/engine/` 独立目录，含引擎全部逻辑，前端（xterm/boot/commands）只依赖 engine 的公开 API。**结构重构，行为不变**（自检 ≥57 全过是硬条件）。

### 1.1 engine 公开 API（src/engine/index.ts）

```ts
export interface TerminalExecutorOptions {
  hostJsUrl?: string;        // host 资产 URL（默认 /host.js）
  lifoCoreUrl?: string;      // lifo 内核资产 URL（默认 /lifo-core.js）
  resultTtlMs?: number;
  onServerReady?: (port: number, url: string) => void;
  onServerClosed?: (port: number) => void;
}

export interface ExecResult {
  ok: boolean; exitCode: number | null; stdout: string; stderr: string;
  runtime: 'node' | 'lifo' | 'browser'; timedOut: boolean;
}

export interface TerminalExecutor {
  boot(wc: WebContainer, opts?: TerminalExecutorOptions): Promise<void>;
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  spawn(command: string, opts?: { timeoutMs?: number }): Promise<{ pid: number }>;
  listProcesses(): Promise<Array<{ pid: number; cmd: string; status: string }>>;
  kill(pid: number): Promise<boolean>;
  ping(): Promise<boolean>;
  dispose(): Promise<void>;
}

export function createTerminalExecutor(): TerminalExecutor;
```

### 1.2 迁移

- `src/terminal-client.ts` → engine 的文件 RPC client 层
- `src/host.ts` / `src/host-procs.ts` / `src/lifo-core.ts` → engine host 侧（注入资产 + 构建产物路径不变：public/host.js + public/lifo-core.js）
- `src/persist.ts`（快照）→ 属于**系统层**（浏览器状态），不进 engine（引擎是命令执行，持久化是宿主责任）——确认边界
- `src/main.ts` / `src/commands.ts` / `src/boot.ts` 改调 engine API（尽量薄）
- 路由规则（node|npm|npx → 真 Node / 其余 → Lifo）在 engine 内实现
- **行为不变**：全部现有命令/自检/场景照常

### 1.3 构建

- build-host.mjs 输出不变（public/host.js + lifo-core.js）
- 新增 `src/engine/` 的独立构建产物？——**决策**：POC 阶段 engine 与前端同仓库同构建（vite 打包进同一 bundle），但**目录/API 边界清晰**（为后续拆 npm 包铺路）。README/SDK 文档说明拆分路径

## 2. 协议契约文档（docs/PROTOCOL.md，权威）

完整文档（生态使用者无需读源码）：
- **文件 RPC 协议**：/cmd.json 请求格式（id/command/opts）、/result-<id>.json 响应格式（id/ok/runtime/stdout/stderr/exitCode/timedOut）、每请求独立文件、读后删除、TTL/prune
- **命令路由**：node|npm|npx → 真 Node 子进程（spawn）；其余 → Lifo sandbox；错误语义（未知命令/超时/ENOENT）
- **进程模型**：spawn 后台、进程表、kill(SIGTERM)、spawn 确认窗口、失败标记
- **端口事件**：server-ready → 宿主回调（onServerReady/onServerClosed）
- **超时/重试**：默认值、只读命令重试、pingDirect 看门狗语义
- **已知边界**：stdin 不可靠、CORS、symlink、stdout 1MB 上限、lifo-core 懒加载时序
- 版本化：协议版本字段（cmd.json 加 `protocol: 1`？——评估，向后兼容优先）

## 3. SDK 形态设计文档（docs/SDK.md）

输出**设计文档**（不实现 npm 发布）：
- **形态 A：npm 包 @webunix/engine**——engine 目录打包（host 资产 + client），`import { createTerminalExecutor } from '@webunix/engine'`；前端项目内嵌：`boot(wc)` 即得沙箱 shell
- **形态 B：iframe 沙箱**——WebUnix 作为独立部署的沙箱页，宿主项目 `<iframe>` + postMessage 桥（命令/结果/端口）；隔离性强（样式/全局隔离），性能有桥开销
- **形态 C：脚手架 create-webunix-app**——模板生成"宿主 + 引擎"项目骨架
- 对比表：集成深度/隔离性/性能/包体积/维护成本 → **推荐形态**（结合用户"内嵌不同人的前端项目提供沙箱"场景：A 同页深度集成 vs B 强隔离，给出推荐 + 理由）
- 落地路线：当前 → 拆包（A）→ 桥（B）→ 模板（C），各阶段前置条件

## 4. 文档与门禁

- README：Ecosystem 章节（engine API 摘要 + 文档链接 + 生态愿景）
- 门禁：tsc 0 错 / lint 0 / vitest 全过 / build / 自检 ≥57 / grep 无 emoji
- 完成后输出：engine 目录结构与 API、PROTOCOL.md 要点、SDK.md 推荐形态与理由、迁移后自检数字

## 保留项

- 行为不变（自检/场景/命令全部照常）；协议形态不变；路由不变；端口/tinbase/主题/COOP/COEP 不变
- 不拆 npm 包（本任务只解耦目录 + 文档铺路；拆包是后续阶段）
- 运行时依赖不新增

## 开始

先读 `src/` 全部（尤其 terminal-client/host/main/commands/boot）、`AGENTS.md`、`docs/`（若存在），然后实施。完成后输出完整报告。
