# WebUnix — TASK15：系统信息补全（uname / motd 风格）

## 背景

网络视图（TASK14）后做系统信息补全。已有 `sysinfo`（浏览器检测信息），缺真 OS 的 `uname` 和登录横幅 `motd`。这是信息展示类（真实数据，无编造）。

## 需求

### 1. `uname` 命令（浏览器侧，commands.ts）

```
uname            输出单行：WebUnix 0.1.0 browser linux x86_64（内核标识）
uname -a         完整信息（全部字段一行）
uname -r         内核版本（runtime 版本）
uname -m         架构（浏览器架构：navigator.userAgent 里的 x86_64/arm64，缺失显示 unknown）
```

- 数据（诚实来源）：
  - 系统名：WebUnix
  - 版本：0.1.0
  - 内核：`js-runtime + webcontainer`（真实描述，不冒充 Linux kernel）
  - 架构：从 UA 提取（`x86_64`/`arm64`），没有则 `unknown`
  - uname -r：`@webcontainer/api` 版本 + JS 运行时（node 版本从容器拿？简单：浏览器侧拿不到容器 node 版本——用 package.json 的 @webcontainer/api 版本即可，注明）
- 输出样例：`WebUnix 0.1.0 js-runtime+webcontainer 1.6.4 x86_64`

### 2. motd（登录横幅，boot.ts）

- 文件 `/etc/webunix.motd`（可编辑，随快照持久；默认内容一条欢迎行）
- boot 完成、进入终端前：打印 motd 内容（若文件存在）
- `motd` 命令：查看当前 motd；`motd <text>` 设置（写文件）；`motd reset` 恢复默认
- 默认：`Welcome to WebUnix 0.1.0 — browser-native Linux. Type 'help' for commands.`

### 3. 自检新增（tests.ts）

- `Info: uname output`——uname 输出含 `WebUnix` 且格式符合
- `Info: motd read/write/reset`——设置 → 读回 → reset（零残留）

### 4. help / README / CHANGELOG

- help 加 `uname`、`motd`；README 命令表 + Features；CHANGELOG

## 保留项（不许改）

- 文件 RPC、路由、spawn/ps/kill、端口、快照、tinbase、TASK6/7/10/11/13/14 功能、暗橙主题/英文/禁 emoji、vite 7892/COOP/COEP
- **不冒充 Linux**：内核标识写 `js-runtime+webcontainer`，不写 linux 版本号

## 质量门禁

- `npx tsc -p tsconfig.json --noEmit` 0 错误；`node scripts/build-host.mjs`；`npm run build`
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 浏览器人工验证清单（你列出）：uname/-a/-r/-m 输出、motd 默认显示、设置/重置

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文；输出英文零 emoji
- 完成后输出总结：改了哪些文件、门禁结果、浏览器人工验证清单

## 开始

先读 `src/commands.ts`、`src/boot.ts`、`src/tests.ts`、`AGENTS.md`，然后实现。
