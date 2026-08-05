# TASK26 — 品牌迁移：WebUnix → Succinix（SuccinixOS）

## 物理边界（不许越界硬造）

- 纯改名/品牌迁移任务：**不改任何功能逻辑、协议、架构**。命令行为、文件 RPC、Lifo 路由、python 注入、快照机制全部保持原样。
- **不许新增依赖**、不许重构代码结构、不许优化性能（无对比数字的优化不做）。
- 界面语言保持英文、禁 emoji、暗橙主题、JetBrains Mono——一切设计规范见 AGENTS.md，**本任务只换名字，不换风格**。
- docs/tasks/TASK*.md 是**历史归档**（记录当时的真实开发过程）——**保留原名与原文**，不改写历史。README 的 Development Archive 引用若无碍可不改。

## 背景

产品正式命名确定：**Succinix**（琥珀学名 succinite + ix），对外完整称呼 **SuccinixOS**。当前项目名为 WebUnix（0.2.0，未上线，无用户数据包袱）。用户决定**统一迁移**：品牌标识、状态文件、持久化库名、提示符、包名全部一次性迁移到 Succinix，不做旧名兼容层。

## 需求：统一迁移清单（全部替换）

### 1. 品牌标识（用户可见文本 + 包元数据）

| 位置 | 现在 | 改为 |
|---|---|---|
| package.json `name` | `webunix` | `succinix` |
| index.html `<title>` | WebUnix — browser-native Linux | Succinix — browser-native Linux |
| index.html boot-version | WebUnix 0.2.0 — browser-native Linux | Succinix 0.2.0 — browser-native Linux |
| index.html 环境错误页 | WebUnix requires ... | Succinix requires ... |
| src/commands.ts VERSION | 'WebUnix 0.2.0 (browser-native Linux)' | 'Succinix 0.2.0 (browser-native Linux)' |
| src/commands.ts help 标题 | WebUnix built-in commands | Succinix built-in commands |
| src/commands.ts reboot 提示 | Rebooting WebUnix... | Rebooting Succinix... |
| src/commands.ts sysinfo | s: 'WebUnix' | s: 'Succinix' |
| src/tests.ts 自检标题 | WebUnix self-test | Succinix self-test |
| src/tests.ts uname 断言 | 前缀 'WebUnix'、正则 WebUnix \d+... | 前缀 'Succinix'、正则 Succinix \d+... |
| src/main.ts 启动横幅 | WebUnix 0.2.0 — kernel: ... | Succinix 0.2.0 — kernel: ... |
| src/engine/host.ts / index.ts 头部注释 | WebUnix POC host / WebUnix TerminalExecutor | Succinix POC host / Succinix TerminalExecutor（注释同步） |
| README.md / docs/README.zh-CN.md / CHANGELOG.md / CONTRIBUTING.md / AGENTS.md / docs/SDK.md / docs/PROTOCOL.md / docs/LANGUAGES.md / docs/LANGUAGES.zh-CN.md | WebUnix / webunix | Succinix / succinix |

### 2. 提示符 / 主机名（uname）

| 位置 | 现在 | 改为 |
|---|---|---|
| src/main.ts promptStr | `guest@webunix:~$ ` | `guest@succinix:~$ ` |
| src/commands.ts uname `n` | 'webunix' | 'succinix' |
| AGENTS.md 提示符示例 | `guest@webunix:~$ ` | `guest@succinix:~$ ` |

### 3. 状态文件路径（/etc、/var、/usr 全系列）

| 现在 | 改为 |
|---|---|
| `/etc/webunix.env` | `/etc/succinix.env` |
| `/etc/webunix.settings` | `/etc/succinix.settings` |
| `/etc/webunix.services` | `/etc/succinix.services` |
| `/etc/webunix.autostart` | `/etc/succinix.autostart` |
| `/etc/webunix.motd` | `/etc/succinix.motd` |
| `/etc/webunix.cwd` | `/etc/succinix.cwd` |
| `/etc/webunix.engine.json` | `/etc/succinix.engine.json` |
| `/var/log/webunix.log` | `/var/log/succinix.log` |
| `/usr/lib/webunix`（python 运行时资产目录） | `/usr/lib/succinix` |

覆盖所有引用：src/commands.ts、src/tests.ts、src/motd.ts、src/log.ts、src/config.ts、src/boot.ts、src/persist.ts、src/engine/*.ts、tests/*.ts（测试夹具里的路径同步改）。**host 侧 `${process.cwd()}/etc/succinix.*` 拼接逻辑保持，只换文件名。**

### 4. 持久化库名（IndexedDB）

| 位置 | 现在 | 改为 |
|---|---|---|
| src/persist.ts `DB_NAME` | `'webunix-persist'` | `'succinix-persist'` |

同步：persist.ts 注释、EXCLUDED_FILES 里的 `webunix.engine.json` → `succinix.engine.json`、EXCLUDED_PREFIXES 里的 `/usr/lib/webunix` → `/usr/lib/succinix`。

### 5. Window 钩子（bench/scenario 驱动接口）

| 现在 | 改为 |
|---|---|
| `__webunixBench` | `__succinixBench` |
| `__webunixScenario` | `__succinixScenario` |

覆盖：src/main.ts（两处定义）、scripts/bench.mjs、scripts/scenarios.mjs、scripts/lang-verify.mjs（全部引用点同步）。

### 6. 包名 / 生态标识（docs/SDK.md、docs/tasks 除外）

| 现在 | 改为 |
|---|---|
| `@webunix/engine` | `@succinix/engine` |
| `@webunix/sandbox-page` | `@succinix/sandbox-page` |
| `create-webunix-app` | `create-succinix-app` |

仅 docs/SDK.md 中的生态规划文字。docs/tasks/TASK21.md 是历史归档，**不改**。

### 7. 其他散落引用

- scripts/bench.mjs / lang-verify.mjs 临时目录前缀：`webunix-bench-` → `succinix-bench-`、`webunix-lang-verify-` → `succinix-lang-verify-`
- 任何剩余 `webunix`/`WebUnix`/`WEBUNIX` 大小写变体一律替换为 `succinix`/`Succinix`/`SUCCINIX`（注意 `Succinix` 大写 S，无 `Web` 前缀；`succinix` 全小写）
- **public/host.js、public/lifo-core.js 是构建产物**：不手改，改完 src/engine/*.ts 后重新运行 `node scripts/build-host.mjs` 生成

## 保留项（不许改清单）

1. docs/tasks/TASK*.md —— 历史归档，**原样保留**（含其中的 webunix 字样）
2. 功能逻辑、协议（文件 RPC、命令表、路由、python 注入、快照机制）——零改动
3. 版本号保持 **0.2.0**（本任务不 bump；版本 bump 留给下一个功能任务）
4. 设计规范（英文 UI、禁 emoji、暗橙主题、JetBrains Mono）——零改动
5. AGENTS.md 除提示符示例外，规则正文不动
6. LICENSE（MIT）不动
7. node_modules / dist / coverage 目录不手动改（dist 由 npm run build 重新生成）

## 质量门禁（全过才算完成）

1. `npx tsc -p tsconfig.json --noEmit` → **0 errors**
2. `node scripts/build-host.mjs` → 成功（host.js/lifo-core.js 重新生成）
3. `npm run build` → 成功
4. `npm test` / vitest（tests/ 6 文件）→ **全绿**（99 tests，路径夹具已同步改名）
5. 残留检查：`grep -rn "webunix\|WebUnix\|WEBUNIX" src/ index.html scripts/ tests/ package.json AGENTS.md docs/README.zh-CN.md docs/SDK.md docs/PROTOCOL.md docs/LANGUAGES.md docs/LANGUAGES.zh-CN.md README.md CHANGELOG.md CONTRIBUTING.md` → **0 匹配**（docs/tasks/ 与 public/host.js、public/lifo-core.js、dist/、node_modules/、coverage/ 除外）
6. 静态自检：`grep -n '✅\|❌\|🎉\|GREEN' src/ index.html` → 无匹配
7. 浏览器实测：dev server 起在 7892 → 打开页面 → 提示符显示 `guest@succinix:~$ ` → `?test=1` 自检 **≥71 passed / 0 failed**（uname 显示 Succinix 0.2.0）→ `uname -n` 输出 `succinix`
8. `npm run lint` → 0 error

## 约束

- 代码注释中文、标识符英文（TS strict）——标识符本身（如 `DB_NAME` 值）按清单改，变量名不改
- 提交信息规范：`feat: TASK26 品牌迁移 — WebUnix → Succinix（SuccinixOS）`，附验证证据（门禁输出）
- 完成后更新 README roadmap（如有 webunix 字样）与 CHANGELOG（记录品牌迁移条目）
- 界面所有对用户可见的字符串必须同步为 Succinix，**一处遗漏都不行**（help 输出、错误提示、boot 横幅、自检输出）
