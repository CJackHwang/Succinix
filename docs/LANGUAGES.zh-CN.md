# Succinix 语言生态 — 实测支持矩阵

> **权威、以实测为准。** 矩阵里的每一项状态都有可复现的实测来源——`scripts/lang-verify.mjs`
> 的检查 id（`LV·P1` … `LV·R3`）、`?test=1` 自检（`ST`）、或 `scripts/scenarios.mjs`
> 里的场景（`S11`、`S13`、`S14`）。无编造；跑 `npm run test:e2e` 即可复现全部数字。

状态图例：

- ✅ **实测可用** —— 真实浏览器/容器执行得到预期结果
- ⚠️ **部分 / 探测** —— 可用但有明确限制，或可行性探测记录了结果
- ❌ **不可用** —— 确认为缺失（真实执行，非假设）

实测环境：headless Chrome（CDP）驱动 WebContainer；容器内 `node` 22.22.3 / `npm` 10.8.2
（来源 `LV·N1`）；内置 Python 运行时为常驻 **Pyodide 314.0.4** daemon，打包 **Python 3.14.2**
（来源 `LV·P1`）。版本号为**观察值，非门禁断言** —— WebContainer 升级内置 Node 或固定
Pyodide 资产变化时会静默漂移。

---

## 1. 语言运行时矩阵

| 语言 | 命令 | 运行时 | 版本（实测） | 装包能力 | 实测状态 | 来源 |
| ---- | ---- | ------ | ----------- | -------- | -------- | ---- |
| **Python** | `python`、`python3` | 内置常驻 **Pyodide 314.0.4** daemon（node 子进程加载、实例跨命令复用） | 3.14.2 | ✅ **pip** —— micropip；pip 安装的 wheel 刷新后仍在（纯 Python 与编译 `.so` 均随 v0.7 binary 快照保留，`LV·P6`、`S11`） | ✅ | `LV·P1–P9`、`S11`、`ST` |
| **pip** | `pip`、`pip3` | 映射到 Pyodide micropip（`python -m pip` 也可用） | micropip 0.11.1 | ✅ install / uninstall / list / show | ✅ | `LV·P6`、`S11`、`ST` |
| **Node.js** | `node` | 真实 Node.js（WebContainer 运行时） | 22.22.3 | ✅ npm，本地按项目安装 | ✅ | `LV·N1–N5`、`S13`、`S14`、`ST` |
| **npm** | `npm` | 真实 npm（随 node 自带） | 10.8.2 | ✅ 本地；❌ 全局（`/usr/local` 只读 → EACCES + hint） | ✅ | `LV·N1`、`LV·N4`、`S14`、`ST` |
| **TypeScript** | `npx tsc`、`tsx`、`vitest` | npm 安装工具链；node 22 `--experimental-strip-types` | npm 最新版 | ✅ 经 npm | ✅ | `LV·N3`、`S13`、`S14` |
| **Ruby** | `ruby` | 懒注入 WASM 运行时：浏览器资产桥 → 真实 Node 子进程内 `@ruby/wasm-wasi` adapter | head ruby.wasm | ✅ npm 安装；❌ **无 gem** | ✅ 已集成、懒加载（首跑慢） | v0.7, `LV·R1` |
| **C** | `gcc` | 无 | — | — | ❌ 确认缺失 | `LV·R2` |
| **Rust** | `rustc`、`cargo` | 无 | — | — | ❌ 确认缺失 | `LV·R2` |
| **Go** | `go` | 无 | — | — | ❌ 确认缺失 | `LV·R2` |
| **WASI** | `wasi-run` / `wasi-info` | `node:wasi`（preview1）之上的 Lifo adapter，模块从 `/workspace` 加载 | node 22 | — | ✅ 已集成（`wasi-run <file>`，≤ 32 MB） | v0.7, `LV·R3` |

### Python 标准库矩阵

由 `LV·P5`（真实 python 脚本逐项 import 并报告 OK/BAD）与 `LV·P7`/补充探测测得。11 个模块
`import` 全绿；运行行为如下区分。

| 模块 | import | 真实行为 |
| ---- | ------ | -------- |
| `json` | ✅ | 可用 —— `json.dumps({'a':1})` → `{"a": 1}`（`LV·P5` import、`LV·P8` 行为） |
| `csv` | ✅ | 可导入（`LV·P5`） |
| `re` | ✅ | 可导入（`LV·P5`） |
| `math` | ✅ | 可导入（`LV·P5`） |
| `os` | ✅ | 可导入；`os.getcwd()` 映射会话 cwd（经 NODEFS 到容器根）（`LV·P3`） |
| `sqlite3` | ✅ | 可用 —— 内存库建表/插入/查询（`LV·P5`；探测：`count(*)` → `1`） |
| `subprocess` | ✅ import / ❌ run | 可导入（`LV·P5`）；**spawn 未实现** —— `subprocess.run(...)` → `OSError: [Errno 138] emscripten does not support processes`（Pyodide 无 OS 进程 API；`LV·P8`） |
| `collections` | ✅ | 可导入（`LV·P5`） |
| `datetime` | ✅ | 可导入（`LV·P5`） |
| `hashlib` | ✅ | 可导入（`LV·P5`） |
| `urllib` | ✅ | 可导入（`LV·P5`）；实际网络请求受外网/CORS 边界限制 |

---

## 2. 生态场景可替代度评估

真实端到端测得的开发场景替代度。

| 场景 | 语言 | 可替代度 | 证据 |
| ---- | ---- | -------- | ---- |
| 标准库脚本 / 数据处理（JSON/CSV/正则/数学/文件/sqlite3） | Python | **~85%+** | 11/11 标准库 import 全绿（`LV·P5`），sqlite3 + json 实测可用（`LV·P7`），**pip 可用**（micropip：`pip install pyparsing` → import，`LV·P6`、`S11`）且 pip 安装的 wheel（纯 Python 与编译 `.so`）**刷新后仍可用**（`S11`）。剩余缺口：无 REPL、无 subprocess。 |
| 科学计算（numpy） | Python | **~80%+** | `pip install numpy` → `import numpy` → `numpy.dot([[1,2],[3,4]],...)` → `[[7, 10], [15, 22]]`（`LV·P9`、`S11`）。编译 `.so` 随 v0.7 binary 快照保留 → 刷新后 `import numpy` 无需重装（`S11`）。 |
| TypeScript 全流程开发闭环（安装 → 编译 → 测试 → 运行） | Node/TS | **~80%+** | `npm i -D typescript tsx vitest` → `tsc` → `node dist/*.js` → `vitest run 1 passed`（`LV·N3`、`S13`）；`node -e` 嵌套引号写文件穿透 tokenize 与 tsc（`LV·N2`、`S14`）；npm 装进会话 cwd（`LV·N5`、`S14`）。 |
| 前端/服务运行时（http 服务、package 脚本） | Node | **~85%+** | 真实 node spawn + 预览 URL 注册 + `ps`/`kill` 生命周期（`S1`、`ST`）；`node --version && npm --version` 链可用（`LV·N1`、`S14`）。 |
| 全局 CLI 工具（`npm i -g`） | npm | **❌** | `/usr/local` 只读；EACCES 并带可操作 hint（`LV·N4`、`S14`）。请改本地安装。 |
| Ruby 脚本 | Ruby | **~60%+** | `ruby` 是已注册的 Lifo 命令；浏览器资产桥懒注入 WASM 运行时并在真实 Node 子进程中运行（`6*7` → `42`）。无 gem 安装器；首跑慢（`v0.7`，`LV·R1`）。 |
| 原生编译（C/Rust/Go） | C/Rust/Go | **❌** | 无编译器（`LV·R2`）。预编译 **WASI** 二进制经 `wasi-run` / `wasi-info` Lifo adapter 运行（`v0.7`，`LV·R3`）；沙箱内仍无构建工具链。 |

---

## 3. 已知边界

实测的环境级限制，不是 bug。

- **pip 持久化**：pip 安装的 wheel 刷新后仍在——站点包目录经 NODEFS 挂载到
  `/.pyodide/site-packages`，随 v0.7 binary 快照持久。**编译 wheel（如 `numpy`）刷新后同样
  可用**：二进制导出保留其 `.so`，`import numpy` 无需重装（`S11`）。
- **`python -m <module>`**：仅 `python -m pip ...` 特殊映射到 micropip；其余模块经
  `runpy.run_module` 执行（`LV·P6`）。
- **`subprocess`**：可导入但无法 spawn——Pyodide 抛
  `OSError: [Errno 138] emscripten does not support processes`（`LV·P8`）。
- **Python REPL**：未实现；当前 host 没有通用子进程终端传输。请用 `python -c "<code>"`
  / `python <script.py>` / `python -m pip <cmd>`。v0.7 的 Lifo `ITerminal` 与 `CommandContext.stdin`/`setRawMode`
  传输面向 WC 原生交互 userland 命令，不会自动开放任意 Pyodide/Node 子进程 REPL。
- **首次 `python` 命令慢**：~13 MB Pyodide 运行时（wasm + stdlib zip）首用懒注入，且常驻
  daemon 首次 `loadPyodide` 需一次性初始化；后续命令复用实例（`LV·P1` 首跑计时、`ST`）。
- **npm 全局安装**：`/usr/local` 对 guest 只读。npm 以 `EACCES` 失败并追加 hint 行
  （`hint: /usr/local is read-only for guest. Install locally: npm i <pkg> ...`）（`LV·N4`、`S14`）。
  权限语义不变。
- **无 C/Rust/Go 编译器**：`which gcc/rustc/go` 均报 not found（`LV·R2`）。
- **WASI**：已集成（v0.7）。`wasi-run <file>` / `wasi-info` 经 `node:wasi` adapter 运行
  预编译 WASI 模块（`LV·R3`）；构建仍需外部工具链，沙箱内无。
- **Ruby**：已集成（v0.7）。`ruby` 命令首次使用经资产桥懒注入 WASM 运行时，在真实
  Node 子进程中执行；仍无 gem 安装器（`LV·R1`）。
- **外网**：`urllib` / `curl` 访问无 CORS 头站点失败；请用 CORS 友好代理
  （如 `https://r.jina.ai/<url>`）（AGENTS.md 边界；`ST`）。
- **`/workspace` 路径映射**：Lifo 的 `/workspace` 是浏览器 FS 根的 VFS 视图；真实
  node/python 子进程看到映射后的真实路径。shell 操作请用 `/workspace/...`，浏览器 FS 读取
  用 `/...`（`S12`、`S13`、`LV·N5`）。

---

## 4. 复现方式

```bash
npm run test:e2e                      # 构建一次后：verify-deploy → bench → scenarios → lang-verify → instance-demo → instance-routing → cordis-app
node scripts/lang-verify.mjs          # 语言生态验证（P1–P9、N1–N5、R1–R3）
node scripts/scenarios.mjs --only S11  # python 工作流 + pip + 持久化，或完整 S1–S14
# 自检：打开 <deploy>/?test=1 → "7? passed, 0 failed, ? skipped"（门禁 >= 71）
```

这些文件是本矩阵的唯一事实来源——支持矩阵的任何改动必须来自 `lang-verify.mjs`、自检或
场景的更新实测，绝不来自假设。
