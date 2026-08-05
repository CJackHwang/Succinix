# TASK27 — 内置 Python 运行时切换：python-wasm → Pyodide（支持 pip）

## 物理边界（不许越界硬造）

- 纯运行时替换：**不动命令语义、协议、文件 RPC、shell 融合机制**。`python`/`python3` 命令的对外行为（传参、管道、cwd、退出码）保持兼容。
- 界面语言保持英文、禁 emoji、暗橙主题——一切设计规范见 AGENTS.md。
- **不新增 npm 依赖**：Pyodide 资产走 CDN 下载→构建时注入（同 python-wasm 的构建资产模式），不进 package.json。
- 外部网络边界不变：pip 装包走 Pyodide 的 wheel 拉取（jsdelivr），网络不可用时给出明确报错。
- REPL/交互式 stdin 仍是边界（WebContainer stdin 不可靠），保持文件 RPC 替代。
- C 扩展 wheel（numpy/pandas 等）依赖 Pyodide 官方预编译 wheel 仓库；**不保证任意 PyPI 包**——装不上的如实报错（记录在支持矩阵）。

## 背景

TASK23 内置了 python-wasm（Python 3.11.14，stdlib-only，**无 pip**），当时的决策前提是"Pyodide 314 在 WC node 22 的 V8 上报 `unknown section code #0x44`（wasm 新特性不支持）"。

**该前提已被 2026-08 实测推翻**：Pyodide 0.29.4 / 314.0.0 / 314.0.4 / 315.0.0a1 在 WC node 22.22.3 全部 `validate` + `instantiate` + `loadPyodide` 跑通，且 **micropip 装包实测成功**（pyparsing 3.3.2、numpy 2.4.3 矩阵乘法 [[7,10],[15,22]] 均通过，wheel 从 jsdelivr 拉取）。

用户明确要求：**换技术栈**，让内置 Python 拥有 pip / 第三方包能力。

## 需求

### 1. 运行时替换（核心）

- **现在**：`python|python3` → host spawn `node python-runtime.js`（node:wasi 跑 python.wasm，stdlib zip）
- **改为**：`python|python3` → host spawn 一个常驻 node 进程，该进程内 `loadPyodide`（Emscripten 胶水）持有 Pyodide 实例，执行 Python 代码后输出结果
- 保持：命令含 shell 元字符（`&&` `|` `>` 等）→ 整条回退 Lifo shell（现有 tokenize/元字符检测机制不动）；`python -c "<code>"`、`python <script.py>`、`python -m <module>` 语义
- **新增**：`pip` / `pip3` 命令 → 映射到 Pyodide 的 micropip（`python -m pip install <pkg>` 也要可用）
- **常驻实例策略**（重要）：Pyodide 实例在容器内常驻（首次 python 命令懒启动，像 Lifo kernel 一样），后续命令复用实例——因为 Pyodide 的 Python 状态（import 的模块、装好的包）在实例内累积，这就是"pip 装包后持续可用"的机制。重启/刷新后实例重建（装过的包需要重新 pip install，除非走持久化，见需求 3）

### 2. 资产构建注入（替换 python-wasm 资产）

- 构建脚本（类似 `scripts/build-host.mjs` 的 python 部分）下载 Pyodide full 发行包到 `public/pyodide/`：
  - `pyodide.mjs`、`pyodide.asm.mjs`（ES module 胶水，内嵌 wasm 引用）、`pyodide.asm.wasm`、`python_stdlib.zip`、`pyodide-lock.json`
  - 版本锁定：**314.0.4**（2026-07-24 发布，实测稳定；README/CHANGELOG 标注版本）
- 资产注入时机：boot 时懒注入（同 python-wasm 模式：首次 python 命令触发，注入幂等，体积 ~13MB 仅一次）
- 资产路径沿用 `/usr/lib/succinix/python/`（TASK26 已把 webunix → succinix）；host 用 `${process.cwd()}` 拼接（双根铁律）
- **删除** python-wasm 资产（kernel.wasm/python.wasm/python-stdlib.zip/python-runtime.js/termcap）及其注入逻辑，替换为 Pyodide 资产 + 新注入逻辑

### 3. pip 持久化（尽力而为，明确边界）

- **现状**：node_modules 被快照排除（`EXCLUDED_FILES`/`EXCLUDED_PREFIXES`），Pyodide 默认把 wheel 缓存到 node_modules → **刷新后装过的包丢失**
- **本任务**：尝试把 Pyodide 的 wheel 缓存/站点包目录指向随快照持久的位置（如 `/workspace/.pyodide/` 或 home 目录），使 `pip install` 的包**刷新后仍在**
- **若技术上不可行**（Pyodide 强制缓存位置/IndexedDB 语义），如实记录：`pip install` 后刷新需重装，文档注明 + 支持矩阵标注
- **禁止**：为持久化改动快照排除规则把 node_modules 纳入持久（会破坏 npm 安装/快照大小）

### 4. 语言支持矩阵更新

- `docs/LANGUAGES.md`（及 zh-CN）Python 行更新：
  - Python 3.14.2（Pyodide 314.0.4 内置）—— 实测来源 LV·P 系列编号更新
  - pip ✅（micropip，实测 numpy 2.4.3 / pyparsing 3.3.2）
  - stdlib 模块矩阵按 Pyodide 3.14 复测（原 3.11 的 11 模块清单重跑）
  - subprocess 状态按 Pyodide 实测更新（WASI 下曾 NOT IMPLEMENTED，Pyodide 行为可能不同——**必须实测**）
  - 标注"无 REPL（文件 RPC 替代）"保留

### 5. 自检 + 防回归

- `?test=1` 自检更新：python 相关断言改为 Pyodide 行为（版本号、pip 可用性、numpy 可选）
- `scripts/scenarios.mjs` S11（python 脚本工作流）+ S14（语言生态防回归：python 管道/引号）更新
- `scripts/lang-verify.mjs` LV·P1–P7 按 Pyodide 复测更新（版本、stdlib、pip、subprocess）
- **新增防回归**：`pip install <小包>` → import → 刷新 → import 仍在（或记录为边界）；`python -c "import numpy"` 路径

## 保留项（不许改清单）

1. 命令协议 / 文件 RPC（/cmd.json → /result-<id>.json）零改动
2. shell 融合机制（元字符检测、Lifo 回退、node/python 转发命令）零改动——只换 python 运行时实现
3. node/npm/npx 运行时零改动
4. 版本号保持 0.2.0（bump 留给功能任务）
5. 设计规范（英文 UI、禁 emoji、暗橙主题）零改动
6. docs/tasks/ 历史归档不改（TASK23 记录保留，作为历史；README 中若引用"python-wasm"更新为 Pyodide）
7. LICENSE / AGENTS.md 技术约束正文不动

## 质量门禁（全过才算完成）

1. `npx tsc -p tsconfig.json --noEmit` → 0 errors
2. `node scripts/build-host.mjs` → 成功（含 Pyodide 资产注入逻辑）
3. `npm run build` → 成功
4. `npm test` / vitest → 全绿（python 相关测试已更新）
5. 浏览器实测（headless Chrome CDP，dev server 7892）：
   - `?test=1` 自检 ≥71 passed / 0 failed（python 断言已更新）
   - `python --version` → `Python 3.14.2`（或 Pyodide 实际版本）
   - `python -c "print(6*7)"` → `42`
   - `python -c "import numpy; print(numpy.__version__)"` → numpy 版本号（numpy 已装或装后）
   - `python -m pip install pyparsing` → 成功 + import 可用
   - 管道：`python -c "print(42)" | grep 42` → `42`（shell 融合不回归）
   - 刷新后：装过的包在/不在（按需求 3 实测结果如实记录）
6. `npm run lint` → 0 error
7. 残留检查：`grep -rn "python-wasm\|python.wasm\|kernel.wasm" src/ scripts/ public/ docs/LANGUAGES.md` → 0 匹配（历史归档除外）
8. 静态自检：`grep -n '✅\|❌\|🎉\|GREEN' src/ index.html` → 无匹配

## 约束

- 代码注释中文、标识符英文、TS strict
- 提交信息：`feat: TASK27 内置 Python 换 Pyodide — pip/第三方包支持（python-wasm → Pyodide 314.0.4）`，附门禁验证证据
- 更新 README（python 能力描述）+ CHANGELOG（记录运行时切换 + 依据：Pyodide 兼容性实测推翻旧结论）
- 性能基准（`scripts/bench.mjs`）：python 首命令延迟记录基线 vs Pyodide（懒注入 13MB，可能有差异）——**有数字才记录，不做无对比优化**

## 复审修复项（2026-08 只读审查 agent 发现，200 轮首跑未收尾 → 500 轮补齐）

以下为独立只读审查 agent 核对的 4 个小边界，**全部修复后再提交**（首跑因 200 轮上限中断于主功能完成，此 4 项为收尾缺口）：

1. **`pip install` 多包支持**（`src/engine/python-daemon.ts` 约 306 行）：现用 `pkgs.join(' ')` 把 `pip install numpy pyparsing` 拼成一个字符串传给 `micropip.install`，PEP 508 解析会拒；真实 pip 支持多包。修复：拆数组逐个/批量传给 micropip（`micropip.install([...])` 支持数组）。
2. **`pip show` 缺参返回 usage**（`python-daemon.ts` 约 391 行）：现 `args[1] ?? ''` 会生成 `md.distribution(undefined)` → Python NameError → exit 1，非 pip 式 usage 提示。修复：无参时输出 `Usage: pip show <package>` 并 exit 2。
3. **`python -c "import numpy"` 冷启动**（`python-daemon.ts` 约 413 行）：`-c` 走同步 `runPython`，无法 await Pyodide 包加载器；刷新后 C 扩展包（numpy）已被启动清理（二进制 .so 不随文本快照持久），import 报 loadPackage 提示。此为 Pyodide 固有约束——**保持如实报错**（报错信息已指向 `pip install numpy` 解决路径即可，确认提示文案友好），不强行实现。
4. **`.pyodide/daemon.log` 无界追加**（`python-daemon.ts` 约 111-118 行）：随快照持久累积。修复：简单轮转（超 256KB 截断/清空），量小但别留无界增长。

修复后重跑全部质量门禁（含浏览器实测：`pip install pyparsing requests` 多包、`pip show pyparsing`、`pip show`（无参）、刷新持久性），再提交。
