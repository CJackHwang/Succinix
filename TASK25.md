# WebUnix — TASK25：语言生态验证（多语言实测 + 支持矩阵 + 防回归 + 文档）

## 背景

TASK23+24 落地：python 内置（python-wasm 资产注入）、会话 cwd 同步、shell 融合（tokenize 转义/元字符回退/EACCES hint）、/etc 双根修复（env 合并真生效）。本任务 = **验证不同语言生态开发环境的可替代性与支持性**，把已知坑全部做防回归，最后把支持情况写成权威文档。

## 1. 多语言生态实测（浏览器真机，可复现）

写 `scripts/lang-verify.mjs`（仿 verify-deploy/scenarios 的 CDP 模式，零新依赖），**真实执行**并断言：

### Python 生态（python 内置）
| 项 | 断言 |
|----|------|
| `python --version` | 输出 Python 3.11.x |
| `python -c "print(6*7)"` | 42 |
| 脚本执行：写 .py → python 跑 | 输出正确 |
| 管道：`python -c "..." \| grep` | 真管道（空/命中语义正确） |
| **标准库矩阵** | import json/csv/re/math/os/sqlite3/subprocess/collections/datetime/hashlib/json/urllib 逐项报告 ✅/❌（支持矩阵数据源） |
| 装包 | pip 不可用 → 验证报错明确（不静默） |
| 文件读写 | python 读写共享 FS 文件（与 Lifo/node 同一文件） |

### TS/Node 生态（用户实测 5 坑修复后复测）
| 坑 | 复测断言 |
|----|---------|
| `node --version && npm --version` | 两行都出（shell 链） |
| `node -e` 嵌套双引号写文件 | 文件引号保真、可编译 |
| `npm i -D typescript tsx vitest` → tsc → node 跑产物 → vitest | 全通（复刻 S13） |
| `npm i -g x` | EACCES + hint 行 |
| cwd 同步：cd /ws/proj → npm install | 包装进 /ws/proj（非根 node_modules） |

### 其他语言（可行性探测，报告即可）
- Ruby：`@ruby/wasm-wasi` npm 包是否可跑（若 wasm 兼容 WC V8 则记录可运行；失败记录原因——同 Pyodide 314 的 wasm 特性问题则注明）
- C/Rust/Go：无编译器（确认）；预编译 WASI 二进制可行性（node:wasi 实测一个最小 wasm——若 python-wasm 已证 WASI 生态可用则记录）

## 2. 支持矩阵文档（docs/LANGUAGES.md，权威）

输出 `docs/LANGUAGES.md`（英文）+ 中文版（docs/LANGUAGES.zh-CN.md 或并入 README.zh-CN）：
- 语言运行时矩阵：语言 / 命令 / 运行时 / 版本 / 装包能力 / 限制 / 实测状态（✅ 实测 / ⚠️ 部分 / ❌ 不可用）
- 生态场景评估：每种语言的"开发场景可替代度"（如 Python 脚本/数据处理 70%+，pip 缺失是主要缺口；Node/TS 全流程 80%+；Ruby 待定；编译语言 ❌）
- 已知边界（pip/REPL/原生二进制/wasm 版本兼容性）
- README 加 Languages 小节 + LANGUAGES.md 链接；中文 README 同步

## 3. 防回归测试（把已知坑固化）

已有：tokenize 单测（19 条）、S11 python 管道、S12 cwd、S13 TS 工作流、env 合并断言、shell 链自检 2 项。
补齐：
- 自检补 1-2 条：`EACCES hint`（npm i -g 报错含 hint 行）——若可测；不可测则 scenarios 断言
- scenarios.mjs 补 **S14 防回归套件**：5 坑逐条复测（&& 链/引号保真/EACCES hint/cwd 装包/python 管道）——锁定行为，防止回归
- lang-verify.mjs 并入 `npm run test:e2e` 链（run-e2e.mjs 追加）

## 4. 门禁

- tsc 0 / lint 0 / vitest 全过 / build / 自检 ≥71 / grep 无 emoji
- lang-verify.mjs 全项 PASS（真实浏览器执行）
- 文档（LANGUAGES.md + README + zh）与实测数据一致（**不许编造支持矩阵**——每项标实测来源）

## 保留项

- 运行时依赖不新增；协议/路由/端口/tinbase/主题/COOP/COEP 不变
- Ruby 是探测报告，不做集成（除非实测超预期）
- 不引入新语言运行时（python/node 已内置，其他只报告）

## 开始

先读 `scripts/scenarios.mjs`（CDP 模式）、`scripts/run-e2e.mjs`、`src/tests.ts`（自检结构）、`docs/` 现有文档，然后实现。完成后输出报告：语言实测矩阵（每项来源）、支持矩阵要点、防回归清单、门禁数字。
