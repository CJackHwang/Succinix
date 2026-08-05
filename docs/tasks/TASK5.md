# WebUnix — TASK5：持久化层（WebOS 命根子）

## 背景

WebUnix 目前**全部内存态**：容器 FS（项目文件 + tinbase 数据）刷新即失。用户要求"和真系统一样"——刷新/重开不丢数据。

已验证的技术栈：WC 真 Node + Lifo 共享同一容器 FS（`wc.fs` == host 的 `process.cwd()`）；tinbase `--engine wasm` 可跑（当前带 `--memory` 不落盘）。

**核心洞察：容器 FS 快照 = 一切持久化。** 项目文件、tinbase 数据（去掉 --memory 后落容器 FS）、用户状态——只要把容器 FS 快照到 IndexedDB，boot 时恢复，就全部持久。不需要分别处理。

## 需求

### 1. 快照持久化模块 `src/persist.ts`（新文件，核心）

用**原生 IndexedDB**（不新增依赖），提供：

```ts
export interface SnapshotMeta {
  version: 1;
  savedAt: number;
  fileCount: number;
  totalBytes: number;
}

export async function saveSnapshot(fs: WebContainerFS): Promise<SnapshotMeta>
export async function loadSnapshot(fs: WebContainerFS): Promise<SnapshotMeta | null>  // null = 无快照（全新系统）
export async function clearSnapshot(): Promise<void>  // "重置系统"
```

- IndexedDB：库名 `webunix-persist`，store `snapshots`，key `current`
- 存储结构：`{ meta: SnapshotMeta, files: Array<{ path: string; content: string }> }`（POC 阶段文本为主；二进制文件（若有）用 base64 或跳过并计数——二选一按简单性，README 里注明）
- **排除规则**（快照遍历时跳过，避免 node_modules 巨量）：`node_modules/`、`dist/`、`host.js`、`cmd.json`、`result-*.json`、`.git/`、`.tinbase/storage/`（可重建的存储缓存，数据在 `.tinbase/` 其他目录）
- **遍历实现**：递归读目录（`fs.readdir` + `fs.readFile`），排除规则命中即剪枝
- **触发策略**：
  - 主循环：`main.ts` 里每 ~2.5s 调用一次 saveSnapshot（自动快照）。性能注意：排除 node_modules 后文件数可控；若遍历耗时 >1s 则说明需要优化（可在实现里做简单缓存：仅当"文件总数或总字节变化"时才写 IDB）
  - 兜底：`pagehide`/`beforeunload` 事件里尽力而为再存一次（IDB 异步，能存多少存多少，不阻塞）
  - 手动：新增命令 `snapshot`（见下）
- **快照大小保护**：`totalBytes` 超过 ~50MB 时跳过本次写并 console.warn（POC 上限，README 注明）

### 2. boot 恢复流程（boot.ts 修改）

- 时机：`WebContainer.boot()` 成功之后、`ensureTerminalHost` 之前（host 挂载的就是恢复后的 FS）
- 逻辑：`loadSnapshot(wc.fs)` → 有快照：写日志 `[  OK  ] Restored workspace from persistent storage (N files, M KB)`（覆盖层）；无快照：写 `[  OK  ] Initialized fresh workspace`（首次启动）
- 恢复后 host 注入逻辑不变
- 注意顺序：恢复**先于** `browser-wrote.txt` 写入（那是自检用的测试文件，每次写，不影响）

### 3. tinbase 持久化（commands.ts 修改）

- `db start` 去掉 `--memory`：改为 `npx tinbase start --port 3001 --engine wasm`（data-dir 落容器 FS → 随快照持久）
- `db stop` 后数据仍在 `.tinbase/` 目录，重启容器恢复后 `db start` 直接复用（提示语相应调整："database data persisted in workspace"）

### 4. 新命令 `snapshot`（浏览器侧，commands.ts）

```
snapshot          查看持久化状态（上次快照时间/文件数/字节数，或无快照）
snapshot now      立即手动保存
snapshot clear    清除快照（= 重置系统，下次启动全新；需二次确认输入 snapshot clear --yes）
```

- 输出英文、专业、零 emoji（AGENTS.md）

### 5. 自检新增持久化检查（tests.ts）

- 新增 2 项（放在 Filesystem 区）：
  - `[  OK  ] Persistence: snapshot saved (N files)`——测试里调用 saveSnapshot 验证写入成功
  - `[  OK  ] Persistence: snapshot loadable (restored N files)`——loadSnapshot 验证读回一致（文件数/抽样内容匹配）
- 注意：自检会真实写入快照——这是特性（自检也验证了持久化）

### 6. boot 覆盖层日志

- 恢复/初始化信息用现有 `ok()`/`note()` 风格（`[  OK  ]` 暗橙），英文

## 保留项（不许改）

- 文件 RPC（`/cmd.json` → `/result-<id>.json`）、路由规则（node|npm|npx → 真 Node）、spawn/ps/kill、端口管理
- 暗橙主题/全英文/禁 emoji（AGENTS.md）、vite 7892/COOP/COEP、`--engine wasm`（保留，只去 `--memory`）、db 安装超时 `{ timeout: 120000 }, 150000`
- 自检既有断言（只新增，不改）

## 质量门禁

- `npx tsc -p tsconfig.json --noEmit` 0 错误
- `node scripts/build-host.mjs`、`npm run build` 成功
- dev server 起得来（COOP/COEP 头在位）
- 静态自查：`grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 浏览器人工验证清单（你列出）：启动 → 写文件 → 刷新 → 文件仍在；snapshot 命令三态；db 数据跨刷新保留；自检持久化项通过

## 约束

- **不新增依赖**（IndexedDB 原生 API；可以用不超过 40 行的 promise 封装）
- TS strict、注释中文、标识符英文、结构沿用现有拆分
- 完成后输出总结：改了哪些文件、快照触发策略说明、门禁结果、浏览器人工验证清单

## 开始

先读 `src/main.ts`、`src/boot.ts`、`src/commands.ts`、`src/tests.ts`、`src/terminal-client.ts`、`AGENTS.md`，然后实现。
