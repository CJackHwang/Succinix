# WebUnix — TASK13：包管理封装（pkg install/remove/list/search）

## 背景

服务管理（TASK11）后做包管理。WebUnix 已有两条包通道：**npm**（真 Node，全生态）和 **lifo-pkg**（Lifo 扩展包：git/ffmpeg/vi/nano 等）。用户需要**统一、apt 风格的封装**。

遵循 AGENTS.md 边界：不做 apt/原生二进制（物理不可能）；本 TASK 只封装真实存在的两条通道。

## 需求

### 1. `pkg` 命令族（浏览器侧，commands.ts）

```
pkg list              列出已安装包（两条通道合并，标注来源）
pkg search <term>     搜索（lifo pkg search + npm search，合并结果）
pkg install <name>    安装：
                        - lifo 系（lifo-pkg-<name> 存在）→ lifo 安装
                        - 否则 → npm install <name>（容器内，真 Node）
pkg remove <name>     卸载（按来源走对应通道）
pkg info <name>       显示包信息（来源/版本/描述）
```

输出示例（英文、表格对齐、零 emoji）：

```
Packages
  NAME       SOURCE  VERSION
  git        lifo    0.6.3
  tinbase    npm     0.12.2
```

### 2. 来源判定规则

- `lifo-pkg-<name>` 在 npm 上存在（`lifo search <name>` 或 registry 探测）→ lifo
- 其余 → npm
- 同名冲突：优先 lifo（工具类），README 注明规则
- install 输出真实命令反馈（stdout 尾部 + 成功/失败），失败给原因（不吞错）

### 3. 已安装列表实现

- lifo 侧：`lifo pkg list`（或检查全局模块目录）——用 lifo 命令真实输出
- npm 侧：`ls node_modules` 顶层目录 + `npm ls --depth=0 --json`（简化：node_modules 顶层目录名即已装包，排除依赖后缀乱码的简化即可，README 注明"顶层直装"）
- 合并去重

### 4. 自检新增（tests.ts）

- `Packages: list merged`——pkg list 输出包含 tinbase（或至少格式正确、两通道表头在）
- `Packages: search lifo-git`——`pkg search git` 命中 lifo-pkg-git（网络项，失败 SKIP——按既有网络项处理方式）

### 5. help / README / CHANGELOG

- help 加 `pkg`；README 命令表 + Features；CHANGELOG

## 保留项（不许改）

- 文件 RPC、路由、spawn/ps/kill、端口、快照、tinbase `--engine wasm`、TASK6/7/10/11 功能、暗橙主题/英文/禁 emoji、vite 7892/COOP/COEP
- 网络类操作失败按"已知边界"处理（可 SKIP/提示，不假装成功）

## 质量门禁

- `npx tsc -p tsconfig.json --noEmit` 0 错误；`node scripts/build-host.mjs`；`npm run build`
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 浏览器人工验证清单（你列出）：pkg list 两通道合并、pkg search git、pkg install 一个轻量包（如 `pkg install lifo-pkg-bc` 或 npm 小包）→ list 出现

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文；输出英文零 emoji
- 网络操作带超时（复用现有 timeout 模式）；失败信息可操作
- 完成后输出总结：改了哪些文件、门禁结果、浏览器人工验证清单

## 开始

先读 `src/commands.ts`、`src/tests.ts`、`AGENTS.md`，然后实现。
