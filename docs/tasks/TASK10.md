# WebUnix — TASK10：系统配置（env / settings，持久化）

## 背景

TASK7（多工作区）已完成。OS 化下一步：**系统配置**——用户可查看/设置环境变量和系统设置，随快照持久（存容器 FS 状态文件，天然走持久化通道）。

遵循 AGENTS.md 的 **Explicitly Not Implemented**：不做多用户、不做权限位。配置是单用户 guest 的全局配置。

## 需求

### 1. `env` 命令（查看/设置环境变量）

```
env              列出全部环境变量（key=value 一行一个，对齐）
env <key>        查看单个（不存在显示空/not set）
env <key>=<val>  设置（持久化，重启保留）
env -u <key>     删除
```

- 存储：容器 FS 状态文件 `/etc/webunix.env`（每行 `KEY=value`，`#` 注释），随快照持久
- **生效范围**：浏览器侧命令读取（如后续 TASK 用）；**host 侧进程**——host 是常驻进程，改 env 后新 spawn 的 node 子进程要拿到？host 的 child_process 继承 host 的 process.env——host 启动时读 /etc/webunix.env 注入 process.env（boot 时 host 已启动……host 侧要支持动态 env 需要 host 修改：spawn 时合并 env 文件）。**范围决策**：
  - 第一阶段（本 TASK）：env 命令管理 `/etc/webunix.env` 文件（查看/设置/删除 + 持久化），浏览器侧命令读取生效
  - host 侧动态注入（spawn 时读 env 文件合并）→ 需要 host.ts 小改：spawn/runNode 时读 `/etc/webunix.env` 合并进 `env` 选项。**做**（小改，价值明确——模型跑命令能用上配置的变量）
- boot 时：读 `/etc/webunix.env`，`[  OK  ] Loaded N environment variables`

### 2. `settings` 命令（系统设置）

```
settings                 列出全部设置
settings <key>           查看
settings <key> <val>     设置
settings reset <key>     恢复默认
```

- 存储：`/etc/webunix.settings`（`KEY=value`）
- 首批设置项（有真实作用的）：
  - `preview-port`（默认 3001，tinbase 端口可配——db start 用这个值？**决策**：db 端口读 settings，缺省 3001）
  - `default-workspace`（默认 main，boot 初始工作区名）
  - `font-size`（默认 14，xterm 字号——生效需重建 terminal？xterm 的 fontSize 可 setOption 动态改！term.options.fontSize 可运行时改。做：settings font-size 立即生效）
  - `theme-accent`（可选，暂不做——暗橙是品牌，不开放改色）
- 应用点：boot 读 settings 应用到（默认工作区、db 端口）；font-size 运行时生效

### 3. 自检新增（tests.ts）

- `Config: env set/get/delete lifecycle`——设置 TEST_VAR → env 读回 → 删除
- `Config: settings read/write`——设置 preview-port 9999 → 读回 → reset

### 4. help / README / CHANGELOG

- help 加 `env`、`settings`
- README 命令表 + Features 补 system configuration 一句；CHANGELOG Unreleased/Added

## 保留项（不许改）

- 文件 RPC、路由、spawn/ps/kill、端口注册、快照逻辑（persist.ts）、tinbase `--engine wasm`、暗橙主题/英文/禁 emoji、vite 7892/COOP/COEP、TASK6/TASK7 功能
- host.ts 只允许加"spawn 时合并 /etc/webunix.env"这一处小改，不许动其他

## 质量门禁

- `npx tsc -p tsconfig.json --noEmit` 0 错误；`node scripts/build-host.mjs`；`npm run build`
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 浏览器人工验证清单（你列出）：env 设置→重启保留、font-size 实时生效、db 端口跟随 settings

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文；输出英文零 emoji
- 文件格式：`KEY=value` 纯文本，解析要健壮（空行/注释/含 = 的值）
- 完成后输出总结：改了哪些文件、门禁结果、浏览器人工验证清单

## 开始

先读 `src/commands.ts`、`src/boot.ts`、`src/host.ts`、`src/tests.ts`、`AGENTS.md`，然后实现。
