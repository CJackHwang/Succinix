# WebUnix — TASK17：架构审查 + 发布准备（最终轮）

## 背景

全部功能（TASK2-15）+ 维护轮（TASK16）已完成：自检 51 passed / 0 failed / 5 skipped，host.js -45.5%，audit 0 漏洞。本任务 = **发布前最终轮**：补 TASK15 遗留建议 + 架构一致性审查 + 发布收尾。

## 1. TASK15 遗留修复

1. **R1（消除硬编码漂移）**：`UNAME_RUNTIME`（现硬编码 `1.6.4`，@webcontainer/api 版本）改为构建期注入——Vite `define` 从 package.json 读取，或 `import` package.json 版本。保证依赖升级后 uname 不输出假数据
2. **R2（自检补命令路径断言）**：tests.ts 加一条经命令分发路径的断言（对 shim 调 `uname -r` / `uname -m`，验证 flag 解析链路）

## 2. 架构一致性审查（对照 AGENTS.md）

逐条核对全项目与 AGENTS.md 的符合度，输出核对表（✅/⚠️/❌ + 证据）：

**设计规范**：
- 界面全英文（扫描 src/ 所有 writeln/console 用户可见字符串）
- 零 emoji（grep 已知通过，抽查字符串字面量）
- 暗橙主题色值（background #0a0a0a / foreground #d6cfc4 / accent #c2702a / ANSI 色板）
- JetBrains Mono 引入方式
- Linux 惯例（提示符/错误格式/表格对齐）

**技术约束**：
- 文件 RPC result-<id>.json（无回退单文件）
- 统一路由 node|npm|npx 分拆
- vite 7892 + COOP/COEP
- tinbase --engine wasm 无 --memory
- build-host.mjs @lifo-sh/ui external + minify
- 快照排除规则（node_modules/dist/.git/host.js/cmd.json/result-*.json/.tinbase/storage）

**Explicitly Not Implemented 边界**（确认没有越界实现）：
- 无多用户/权限位/apt/入站网络/无 CORS 直连/交互 stdin/symlink/精确统计

**模块划分**：src/ 下模块职责清晰度、重复代码、死代码/遗留（如 TASK 过程中废弃的变量）

## 3. 发布准备

- **版本**：package.json `0.1.0` → `0.2.0`（OS 化全量交付）
- **CHANGELOG**：Unreleased 内容整理成 `[0.2.0]` 正式条目（日期今天），保留 Keep a Changelog 格式
- **README**：版本徽章 0.2.0、Verified Behavior 最终计数核对、Roadmap 勾选核对（全部完成项打勾；SunamAI 集成/TASK8 标注"暂缓"）、Known Boundaries 完整核对
- **TASK 文件**：TASK2-17.md 保留在仓库作为开发档案（README 或 docs 注明其历史属性，不删除）

## 4. 最终回归

- `?test=1` 全过（≥51 passed）
- 持久化回归（写→快照→刷新→在）
- 构建三件套 + grep 门禁

## 保留项（不许改）

- 文件 RPC、路由、spawn/ps/kill、端口、tinbase、暗橙/英文/禁 emoji、vite 7892/COOP/COEP、依赖不升级

## 质量门禁

- `npx tsc --noEmit` 0 错；`node scripts/build-host.mjs`；`npm run build`
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果
- 自检 ≥51 passed

## 约束

- 不新增依赖；TS strict；注释中文；标识符英文；输出英文零 emoji
- R1 用 Vite define 注入版本（改 vite.config.ts + commands.ts），不许引入新运行时依赖
- 完成输出总结：架构核对表（每项 ✅/⚠️/❌ + 证据）、发布改动清单、门禁结果

## 开始

先读 `AGENTS.md`、`src/` 全部模块、`vite.config.ts`、`package.json`、`README.md`、`CHANGELOG.md`，然后执行。
