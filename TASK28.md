# TASK28 — 文档中文化 + 功能清单（FEATURES）

## 物理边界（不许越界硬造）

- **纯文档任务**：零代码改动（不碰 src/、scripts/、public/、tests/）。只有 .md 文件新增/修改。
- 界面规范：中英双语文档并存。**英文文档是规范原文，中文版是翻译**——翻译忠实原文，不增删技术事实。
- docs/tasks/ 历史归档**不改**（TASK1-27 档案保留英文原样，它们是开发记录不是用户文档）。
- 不新增依赖、不动构建、不动 CI。
- 版本号 0.2.0 不变。

## 背景

用户要求：① 项目所有文档都要有中文版本（当前 AGENTS.md / CHANGELOG.md / CONTRIBUTING.md / docs/PROTOCOL.md / docs/SDK.md 只有英文；README 和 LANGUAGES 已有 zh-CN 版）② 把前面 TASK1-27 做的全部功能汇总成文档，明确说明"这个 OS 支持什么"。

## 需求

### 1. 中文版文档（5 个新文件，放同目录）

为以下英文文档各创建一份中文版，**与英文版同目录、同结构、同小节标题**，翻译忠实原文：

| 英文原版 | 中文版路径 |
|---|---|
| `AGENTS.md` | `AGENTS.zh-CN.md` |
| `CHANGELOG.md` | `CHANGELOG.zh-CN.md` |
| `CONTRIBUTING.md` | `CONTRIBUTING.zh-CN.md` |
| `docs/PROTOCOL.md` | `docs/PROTOCOL.zh-CN.md` |
| `docs/SDK.md` | `docs/SDK.zh-CN.md` |

翻译要求：
- 技术术语保留英文原文 + 首现中文注释（如 `file RPC（文件 RPC）`、`snapshot（快照）`、`WebContainer`）
- 命令、代码块、路径、文件名的**内容保持英文原样**（不翻译 `guest@succinix:~$`、`/etc/succinix.env`、`pip install` 等）
- 中文版头部加一行：`> 中文翻译。英文版为准：见 <原文件名>`（如 `> 中文翻译。英文版为准：见 AGENTS.md`）
- 与英文版保持同步更新约定：README（英文）与 README.zh-CN.md 的互链模式作为范本

### 2. 功能清单文档（核心交付）

新建 **`docs/FEATURES.md`**（英文）+ **`docs/FEATURES.zh-CN.md`**（中文），标题形如 **"SuccinixOS — Supported Features & Capabilities"** / **"SuccinixOS — 支持的功能与能力"**。

内容 = **TASK1-27 全部已完成功能的权威汇总**，面向"这个 OS 支持什么"的读者（用户/潜在集成方）。信息源：README.md、CHANGELOG.md（Unreleased 段）、docs/LANGUAGES.md、docs/SDK.md、docs/PROTOCOL.md、docs/tasks/TASK*.md（只读参考，不引用档案路径）。**每一项功能都要标注实现来源（TASK 编号或文档引用），不许编造未实现的功能**。

结构建议（可按实际调整，但必须覆盖以下全部内容）：

1. **系统概览** — 是什么（浏览器原生 Linux，WebContainer 内，真实 Node + Lifo Unix userland），版本 0.2.0，MIT
2. **内置命令族**（完整列表 + 一句话功能）：`help/clear/sysinfo/ports/db/snapshot/free/top/cache/reboot/shutdown/env/settings/workspace/service/log/pkg/netstat/ip/uname/motd/lang`（+ 各自对应的 /etc/succinix.* 状态文件，随快照持久）
3. **语言运行时**（引用 LANGUAGES.md 实测矩阵，简表 + 链接）：
   - Node.js 22.22.3 + npm（真实运行时，shell 融合：`&&`/`|`/`>` 等元字符真解析，管道/重定向按 Linux 语义）
   - TypeScript 生态（tsc/tsx/vitest 实测通过）
   - Python 3.14.2（Pyodide 314.0.4，**支持 pip**：install/uninstall/list/show，纯 Python 包刷新持久，C 扩展包刷新需重装——诚实标注）
   - Ruby（@ruby/wasm-wasi 探测可行，无 gem）/ WASI（可跑预编译模块）/ C·Rust·Go（无编译器，如实标注）
4. **持久化** — 容器 FS 快照 → IndexedDB（`succinix-persist`），/etc 状态文件 + workspace 随快照；pip 包持久化方案（.pyodide/ + installed.json）
5. **进程与服务** — 统一进程表（ps/kill）、后台 spawn、service + autostart 自启、端口注册表（netstat/ports，虚拟 preview）
6. **网络** — 出站经 r.jina.ai 代理（CORS 边界）、端口是虚拟 preview（入站物理不可行——诚实边界）
7. **会话** — cwd 同步（cd 驱动 node/python 子进程 cwd，/etc/succinix.cwd 持久）、env 持久合并
8. **部署** — Vercel 适配（COOP/COEP 头，verify-deploy 门禁），IndexedDB 按 origin 隔离（换域=新系统）
9. **生态/SDK** — @succinix/engine 推荐形态（同页内嵌、共享文件系统）、Form B iframe 桥、create-succinix-app 脚手架（规划），docs/PROTOCOL.md v1 协议
10. **诚实边界表**（不硬造清单）— 无真内核/apt/原生二进制、无多用户/权限位、无入站网络、无 REPL stdin（文件 RPC 替代）、无 symlink、Firefox/Safari/移动端不支持、C 扩展包刷新不持久、外部 curl 需代理
11. **自检/测试** — `?test=1` 自检（75 passed）、scripts（verify-deploy/bench/scenarios/lang-verify）、CI（GitHub Actions + nightly）
12. **快速开始 + 文档索引** — 指向 README / PROTOCOL / SDK / LANGUAGES / FEATURES 全家族（中英文各一）

### 3. 文档互链更新

- `README.md` 与 `docs/README.zh-CN.md` 的文档索引区：补上 FEATURES.md / FEATURES.zh-CN.md / AGENTS.zh-CN.md / CHANGELOG.zh-CN.md / CONTRIBUTING.zh-CN.md / PROTOCOL.zh-CN.md / SDK.zh-CN.md 的链接
- 中文版文档之间互相链接（zh 版指向 zh 版）

## 保留项（不许改清单）

1. src/、scripts/、public/、tests/、.github/ 零改动
2. docs/tasks/ 历史归档不改
3. 现有英文文档的技术内容不改（README/CHANGELOG/PROTOCOL/SDK/LANGUAGES 的**英文原文**只在"互链更新"时加链接行，其余不动）
4. 版本号 0.2.0 不变
5. 设计规范：文档中禁 emoji（用 `✅` 替代为 `[OK]`/文字；`[x]` 风格或纯文字，与项目规范一致——**参考现有文档风格**）

## 质量门禁

1. 新增中文版文件数量 = 5（AGENTS/CHANGELOG/CONTRIBUTING/PROTOCOL/SDK 的 zh-CN）+ 2（FEATURES/FEATURES.zh-CN）= 7 个新文件
2. 每个英文文档都有对应中文版，且中文版小节结构一致（`grep -c '^##' 英文 vs 中文` 大致匹配）
3. FEATURES.zh-CN.md 覆盖需求 2 的全部 12 个板块，每项功能标注来源（TASK 编号/文档引用）
4. FEATURES 中无编造功能——每条能力都能在 CHANGELOG/README/LANGUAGES 找到出处（抽查 10 项）
5. 文档中不出现 emoji（`grep -n '✅\|❌\|🎉\|🚀' *.md docs/*.md` → 0 匹配，除 docs/tasks/）
6. `README.md` 与 `docs/README.zh-CN.md` 文档索引含全部新链接
7. `npx tsc -p tsconfig.json --noEmit` → 0 errors（确保没误碰代码）
8. `git status` 只显示 .md 文件改动（+ docs/ 下新文件），无 src/scripts/tests 改动

## 约束

- 提交信息：`docs: TASK28 文档中文化 + 功能清单（FEATURES 全家族 + 5 份中文版）`
- 一次提交完成全部文档改动
- 中文翻译用词专业、技术准确，避免机翻腔（如"我们"少用、被动语态转主动、术语一致：kernel=内核、snapshot=快照、sandbox=沙箱、daemon=守护进程、mount=挂载、lazy-inject=懒注入）
