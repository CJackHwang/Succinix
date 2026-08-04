# WebUnix POC — TerminalExecutor

验证「Lifo（TypeScript 重写的 Unix）跑在 WebContainer 里，与容器共享文件系统」，并通过**统一终端执行器**把 `node|npm|npx` 路由到真 Node 子进程、其余命令路由到 Lifo。

## 架构

```
┌───────────────────────────┐         文件 RPC          ┌────────────────────────────────────────────────┐
│         浏览器页面           │   /cmd.json {id,cmd,opts}  │              WebContainer（浏览器内 Node 运行时）   │
│  src/main.ts               │ ─────────────────────────► │                                                │
│  TerminalClient            │                            │   node host.js（常驻统一终端执行器）                 │
│  terminal(command) 单一入口  │                            │   ├─ run: node|npm|npx 前缀                      │
│                            │   /result.json {id,ok,...} │   │    → child_process.spawn（真 Node 子进程）    │
│  wc.fs（与容器共享同一份 FS） │ ◄───────────────────────── │   ├─ run: 其余 → Lifo sandbox.commands.run      │
└───────────────────────────┘                            │   │    （Unix 工具：grep/cat/wc/echo/curl…）      │
                                                         │   ├─ ps / kill：进程表管理                        │
                                                         │   └─ cwd / ping / exit                          │
                                                         └────────────────────────────────────────────────┘
```

浏览器写 `/cmd.json` → host 轮询执行 → 写 `/result.json`。响应统一为
`{ ok, exitCode, stdout, stderr, runtime: 'node' | 'lifo' }`，`runtime` 标明实际路由。

## 核心结论（全部实测通过）

1. **共享 FS**：浏览器 `wc.fs` 与 Lifo 命令操作同一份文件系统。挂载
   `{ virtualPath: '/workspace', hostPath: process.cwd(), fsModule: node:fs }`，
   `wc.fs` 根 == host 进程 cwd。
2. **文件型 RPC 可靠**：`/cmd.json → /result.json` 通道可靠（stdin→进程 通道在测试环境不可靠，不用 stdin）。
3. **TerminalExecutor 统一路由**：
   - 以 `node` / `npm` / `npx` 开头（后跟空格或结束）的整条命令 → `child_process.spawn`（真 Node 运行时）；
     参数从命令字符串经简单分词解析（支持单/双引号）。
   - 其余命令 → `lifo sandbox.commands.run`（Unix 工具，管道/重定向等由 Lifo 处理）。
4. **进程表**：host 拉起的真实子进程登记 `(pid, cmd, status, startTime)`；`ps` 列出，`kill <pid>` 对真子进程执行
   `child.kill()`；Lifo 侧进程不在表内，kill 时明确返回「仅支持列表」提示，不假装支持。
5. **cwd 统一**：`child_process.spawn` 固定用 `cwd: process.cwd()`（挂载点），与 Lifo 侧天然一致。

## 命令协议（host 侧）

| cmd | 说明 | 响应要点 |
|---|---|---|
| `run` | 统一路由执行，`opts.command` 为命令串 | `{ ok, exitCode, stdout, stderr, runtime }` |
| `ps` | 列出进程表 | `{ ok, processes: [{pid, cmd, status, startTime, exitCode}] }` |
| `kill <pid>` | 终止真实子进程；Lifo 侧仅列表 | `{ ok, killed, message }` |
| `cwd` | 返回统一 cwd（`process.cwd()`） | `{ ok, kind: 'cwd', cwd }` |
| `ping` | 连通性探测 | `{ ok, kind: 'pong' }` |
| `exit` | 优雅退出握手 | `{ ok, kind: 'bye' }` |

浏览器侧 `terminal(command)` 会拦截 `ps` / `kill <pid>` / `cwd` / `ping` / `exit` 直接命中协议，
其余命令作为 `run` 发送。

## 已知边界

- **curl 直连外网受 CORS 限制**（exit=7）；走 `https://r.jina.ai/<url>` 代理正常。
- **Lifo VFS 不支持 symlink**（`ln -s` 降级/受限）。
- **Lifo 的 `node` 命令**是 15 模块 shim（不是真 Node）；TerminalExecutor 已把 `node|npm|npx` 前缀路由到真 Node 子进程。
- **WC 怪癖**：`proc.output` 流吐字符串（不是 Uint8Array）；`wc.fs` 路径相对 workdir；Vite dev server 必须带
  COOP/COEP 头（`vite.config.ts` 已配好，不要去掉）。

## 运行

```bash
npm install
npm run dev         # 启动 Vite dev server → http://localhost:7892
npm run build:host  # 打包 host.ts → public/host.js（浏览器自动注入容器执行）
npm run build       # build:host + vite build（产物在 dist/）
```

打开浏览器后，页面会自动：boot WebContainer → 注入 host.js → 拉起 `node host.js` → 跑测试
（基础协议 → 共享 FS → TerminalExecutor 统一路由 → 已知边界）。测试页面的 PASS/FAIL 统计见页面顶部。
