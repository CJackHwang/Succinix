# WebUnix — TASK7：虚拟目录拆分（多工作区，像 Sunam workspace）

## 背景

内存管理（TASK6）完成后，实现"虚拟目录拆分"——多个独立工作区，用户可创建/切换/删除，像 Sunam 的 workspace 概念。持久化层（TASK5）已就绪：快照包含容器 FS 全部内容（`/ws/*` 未被排除），**多工作区天然随快照持久**。

## 设计（已定，遵循）

- **工作区 = 容器 FS 子目录** `/ws/<name>/`（如 `/ws/demo/`）
- **当前工作区状态**存容器内状态文件 `/ws/.current`（内容 = 当前工作区名；随快照持久，无需改 persist.ts）
- 首次启动无 `/ws/.current` → 自动初始化默认工作区 `main`（建 `/ws/main/` + 写 `.current`）
- **host 零改动**：工作区全部是浏览器侧（FS 操作 + 状态读写），协议/路由不动

## 需求

### 1. `workspace` 命令族（浏览器侧，commands.ts）

```
workspace             列出全部工作区（当前项标记 *，英文输出）
workspace create <n>  创建新工作区（目录已存在则报错）
workspace switch <n>  切换当前工作区（更新 /ws/.current；不存在则报错）
workspace rm <n>     删除工作区（需 --yes 确认；禁止删当前工作区；禁止删 main）
```

输出示例（英文、零 emoji、表格对齐）：

```
Workspaces
  main     (current)
  demo
```

- `workspace create demo` → `Workspace 'demo' created. Switch with: workspace switch demo`
- `workspace switch demo` → `Switched to workspace 'demo'. Your files live in /ws/demo`
- `workspace rm demo --yes` → `Workspace 'demo' removed`；保护：当前工作区 `cannot remove the current workspace`、main `cannot remove 'main'`
- 实现：浏览器侧直接 `wc.fs` 操作（mkdir/readFile/writeFile/rm 递归——wc.fs 有 rm 递归？`wc.fs.rm(path, {recursive:true})` 支持。若无则用 `terminal('rm -rf /ws/demo')` 走 Lifo）。**优先用 wc.fs 原生 API**，不行再走 Lifo
- 切工作区后提示用户 `cd /ws/<name>` 使用（不自动 cd）

### 2. 默认工作区初始化（boot.ts）

- boot 流程中（恢复快照之后、host 拉起之前或之后均可）：检查 `/ws/.current` 不存在 → 建 `/ws/main/` + 写 `.current=main`，日志 `[  OK  ] Initialized default workspace 'main'`；存在 → `[  OK  ] Workspace 'xxx'`（显示当前工作区名）
- 注意：恢复快照后 .current 应该已存在（除非全新系统）

### 3. 自检新增（tests.ts）

- `Workspace: list workspaces`——`workspace` 命令返回包含 `main`（或当前工作区）且格式正确
- `Workspace: create/switch lifecycle`——创建临时工作区 `selftest-ws` → 切换 → 读取 .current 验证 → 删除（清理干净，不留残留）

### 4. help / README

- help 加 `workspace` 条目
- README：命令表加 workspace；Features 或 Usage 补一句多工作区隔离

## 保留项（不许改）

- 文件 RPC、路由、spawn/ps/kill、端口、快照逻辑（persist.ts 不动——状态文件方案避免改它）、tinbase、主题/英文/禁 emoji、vite 7892/COOP/COEP
- TASK6 的内存管理命令（free/top/reboot/shutdown/cache）保持

## 质量门禁

- `npx tsc -p tsconfig.json --noEmit` 0 错误
- `node scripts/build-host.mjs`、`npm run build` 成功
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 浏览器人工验证清单（你列出）：首次启动自动建 main 工作区、create/switch/rm 全流程、刷新后工作区状态保留（持久化联动）

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文
- 输出英文、专业、零 emoji
- 完成后输出总结：改了哪些文件、门禁结果、浏览器人工验证清单

## 开始

先读 `src/commands.ts`、`src/boot.ts`、`src/tests.ts`、`src/persist.ts`、`AGENTS.md`，然后实现。
