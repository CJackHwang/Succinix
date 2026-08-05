# WebUnix — TerminalExecutor v1 实现任务

## 背景

WebUnix 是一个 POC 项目，验证"Lifo（TypeScript 重写的 Unix）跑在 WebContainer 里，与容器共享文件系统"。
已经验证的结论（**全部实测通过，不要推翻**）：

1. **共享 FS**：Lifo 以 `node host.js` 进程跑在 WC 内，`Sandbox.create({ mounts: [{ virtualPath: '/workspace', hostPath: process.cwd(), fsModule: node:fs }] })` —— 浏览器 `wc.fs` 与 Lifo 命令操作的是**同一份文件系统**（wc.fs 根 == 进程 cwd）。
2. **文件型 RPC 可靠**：浏览器写 `/cmd.json`（`{id, cmd, opts}`），host 轮询执行后写 `/result.json`（`{id, ok, exitCode, stdout, stderr}`）。**stdin→进程 通道在测试环境不可靠，不要用 stdin**。
3. **child_process.spawn 在 WC 容器内可用**（实测）：host 能拉起真 Node 子进程、`npm --version`（PATH 解析正常）、`spawnSync` 也可用。stdout/stderr/exit code 全部正确透传。
4. **边界**：curl 直连外网受 CORS 限制（exit=7，走 `https://r.jina.ai/<url>` 代理正常）；Lifo VFS 不支持 symlink；Lifo 的 `node` 命令是 15 模块 shim（不是真 Node）。
5. **WC 怪癖**：`proc.output` 流吐字符串（不是 Uint8Array）；`wc.fs` 路径相对 workdir；Vite dev server 必须带 COOP/COEP 头（已配好）。

## 目标：TerminalExecutor v1

把现在的"host 只是 Lifo 执行器"升级成**统一的终端执行器**——单一入口，内部智能路由：

```
浏览器 → terminal(command) → /cmd.json → host 执行器
  ├─ node|npm|npx 及项目 bin → child_process.spawn（真 Node）
  └─ 其余命令 → lifo sandbox.commands.run（Unix 工具）
→ /result.json → 统一 {exitCode, stdout, stderr}
```

### 具体要求

1. **host.ts 重构**（当前是 setInterval 轮询 + 简单分支）：
   - 命令协议扩展：`run`（统一路由执行）、`ps`（列出进程表）、`kill <pid>`、`cwd`、`ping`、`exit`
   - **统一路由规则**：
     - 前缀匹配 `node`、`npm`、`npx`（以及 `node `、`npm `、`npx ` 开头的整条命令）→ child_process.spawn 真 Node（可带参数数组，从命令字符串解析）
     - 其余一切 → lifo `sandbox.commands.run`
     - 路由结果必须带 `runtime: 'node' | 'lifo'` 字段返回，方便验证
   - **进程表**：child_process 子进程登记（pid、命令、状态、启动时间）；支持 `kill`（真子进程用 child.kill()，Lifo 侧先返回"仅支持列表"的明确提示——不要假装支持）
   - cwd 统一：child_process spawn 用 `cwd: process.cwd()`，与 Lifo 侧一致（挂载点就是 process.cwd()，天然一致）
   - 保持轮询文件协议（不要改协议通道），但把处理逻辑从"setInterval 内嵌"重构为清晰的结构（handleCommand 函数 + 路由函数 + 进程表模块）
2. **main.ts 更新**：客户端加 `terminal(command)` 单一 API（内部还是文件 RPC），测试页新增 TerminalExecutor 测试组：
   - `terminal('node -e "console.log(21*2)"')` → 期望 stdout=42, runtime=node
   - `terminal('npm --version')` → 期望 runtime=node
   - `terminal('grep -i lifo /workspace/browser-wrote.txt')` → 期望 runtime=lifo
   - `terminal('ps')` → 期望列出刚才的 node 子进程
   - `terminal('cat /workspace/browser-wrote.txt | wc -c')` → 管道仍走 Lifo
3. **README.md**：写清架构图（WC + Lifo + TerminalExecutor）、验证过的事实、已知边界、如何运行（`npm run dev` → localhost:7892）、如何打包 host（`npm run build:host`）。
4. **git**：如果还不是 git 仓库，`git init` + 首次提交（写 .gitignore：node_modules、dist、public/host.js）。
5. **质量门禁**（必须全部通过再收工）：
   - `npx tsc -p tsconfig.json --noEmit` 0 错误
   - `node scripts/build-host.mjs` 成功
   - `npm run build` 成功
   - 浏览器端运行时测试由我（外部）验证——你不用跑浏览器，但代码必须保证上述门禁通过

### 约束

- **不要改**：vite.config.ts 的端口(7892)和 COOP/COEP 头、依赖版本、文件 RPC 通道（/cmd.json → /result.json）
- TypeScript strict 保持；不要引入新依赖（除非绝对必要，且要在提交说明里写明原因）
- 这是 POC，追求"结构清晰、可读、够用"，不要过度工程化（不要引入测试框架/不要建 monorepo/不要抽象基类）
- 所有代码注释用中文，代码本身用英文标识符
- 完成后输出：改了哪些文件、每处改了什么、门禁结果、以及"你还不能自己验证的浏览器运行时测试清单"（告诉我该在浏览器里点哪里看什么）

## 开始

先读 `src/host.ts`、`src/main.ts`、`scripts/build-host.mjs`、`package.json` 了解现状，然后实现。
