# WebUnix — TASK24：Shell 融合修复 + python 路径双根修复（TS 生态实测 3 坑 + TASK23 遗留）

## 背景

用户浏览器真机实测 TS 生态（tsc 7.0.2 / tsx / vitest 4.1.10 / eslint / prettier 全跑通），确认 3 个**体验破绽**（另有 2 项分别由 TASK23 cwd 同步覆盖、README 记录）；另有 **TASK23 遗留 bug**（python 资产注入路径双根，自检崩溃）：

0. 🔴 **python 资产路径双根**（TASK23 遗留）：浏览器 `wc.fs` 的 `/` == node 进程 cwd（`/home/<wc-id>`），而 host 检查/加载 `PYTHON_RUNTIME_JS = '/usr/lib/webunix/python/python-runtime.js'` 用的是 node **虚拟系统根** `/`（bin/dev/etc/...）——注入写进 cwd/usr/lib/...，host 在 /usr/lib/... 找不到 → 报 "assets not injected yet"。自检 `?test=1` 也因此崩溃（`timeout: run`）。修复：host 端资产路径统一用 `process.cwd()` 拼接（`${process.cwd()}/usr/lib/webunix/python/python-runtime.js`），python-assets.ts 注入位置不变（wc.fs 视角 = cwd 相对，两者对齐）；自检崩溃同根因一并验证恢复
1. 🔴 **node 前缀命令无 shell**：`node --version && npm --version` 只跑 node；`npm i -g x 2>&1 | tail` 报 `Invalid tag name "2>&1"`——`&&`/`|`/`>`/`2>&1`/`;` 全被当 argv 传给 node/npm
2. 🔴 **`node -e` 嵌套双引号被分词器吞**：`node -e "require('fs').writeFileSync('a.ts','import {x} from \"./m\"')"` 落盘后引号残缺、代码坏掉——host tokenize 对 `\"` 转义处理有 bug
3. 🟡 **`npm i -g` EACCES 报错不友好**：`/usr/local` 只读（真实 Linux 权限语义，保持），但错误要可操作

## 需求

### 1. host 分词器修转义引号（坑 2，最高优先）

`src/engine/host.ts`（或独立 tokenize 模块）的命令分词器：当前 `\"` 转义被粗暴消费（反斜杠+引号一起吃，甚至连字符吞掉）。

修复目标（shlex 语义）：
- `\"` 在引号内 → 字面 `"`（不进字符串边界判断）
- `\\` → 字面 `\`；`\'` 在单引号内 → 字面 `'`
- 未闭合引号 → 明确报错（`unterminated quote in command`，不静默截断）
- 引号外空白分词、引号内空白保留——现状行为保持

**验证**（自检断言）：tokenize 纯函数单测（tests/ 新增）：
- `node -e "console.log(\"hi\")"` → argv 含 `console.log("hi")`（引号保真）
- `echo "a b"` → 两个 token（a b 一体）
- `echo "a\"b"` → token 为 `a"b`
- 未闭合 → 抛错

### 2. node 系命令 shell 元字符回退（坑 1）

现状：路由按命令前缀 node|npm|npx → 整条 spawn 真 node，argv 里出现 shell 元字符也不解析。

修复：host 在**分派 node 系命令前**检查 token 中是否有 shell 元字符 token（`&&`、`||`、`|`、`>`、`>>`、`<`、`2>`、`2>&1`、`;`、`&`、`$(`），有则**整条命令回退给 Lifo shell 执行**（Lifo 的 shell 层解析管道/重定向/链；Lifo 的 node shim 会把 node 部分再路由回真 node 执行）——先验证 Lifo shim 的转发行为（读 lifo node.ts shim 源码确认它调真 node 且 stdout 进管道流），确认可行再改。

- 混合链 `node -e "console.log(21*2)" | grep 42` → Lifo shell：node 部分真 node 输出 42 → grep 过滤 → 结果 `42`
- `node --version && npm --version` → Lifo shell 顺序执行两条（每条各自路由真 node）→ 两行版本
- `npm i -g x 2>&1 | tail -20` → Lifo shell：npm 部分真 npm（stderr 并进 stdout）→ tail 截取
- 递归防护：Lifo shell 里 node 转发 host 时不再做二次回退（host 只对"顶层命令"做检查；或加标记）
- 回退后结果格式不变（runtime 标 `lifo`？标 `shell`？——诚实标注：混合链 runtime 字段标 `lifo`（shell 层执行）+ 文档注明内部 node 真执行）

**边界**：纯 node 命令（无元字符）行为完全不变（直启子进程）；元字符检测只查"顶层 argv 分割后的独立 token"，`node -e "console.log('a|b')"` 里的 `|` 在引号内不触发（tokenize 后引号内内容是一体的）。

### 3. EACCES 友好提示（坑 3）

host 的 runNode 捕获子进程 stderr 含 `EACCES` + `/usr/local` → 在错误输出**追加**一行提示（不替换原错误）：
`hint: /usr/local is read-only for guest. Install locally: npm i <pkg>  (or set a user prefix: npm config set prefix ~/.npm-global)`
- 只提示不改变行为（权限语义保持——真实 Linux 同样无 sudo 装不了全局）

### 4. 自检 + 场景

- 自检新增：
  - `Shell: tokenize escape quotes`（上述断言经自检跑）
  - `Shell: node pipe chain`（`node -e "console.log(21*2)" | grep 42` → 输出含 42、runtime=lifo）
  - `Shell: node && chain`（`node --version && npm --version` → 两行都出）
- scenarios.mjs 补 S13：TS 工作流复刻（npm i -D typescript tsx vitest → tsc 编译 → node 跑产物 → vitest 1 passed——复现用户实测，断言工具链全通）
- 门禁：自检 ≥62（57+5 新）+ lint/tsc/build/无 emoji

### 5. 文档

- README：Routing 说明更新（node 系命令含 shell 元字符时经 Lifo shell 执行，管道/链可用）；Known Boundaries 删掉"node 前缀无 shell 链"相关旧描述（若有）
- CHANGELOG

## 保留项

- 文件 RPC 协议形态不变；纯 node 命令路由不变（直启）；Lifo 命令路由不变
- 运行时依赖不新增；不做交互 stdin/REPL
- 权限语义保持（EACCES 是真实行为，只加提示）

## 质量门禁

- tsc 0 错 / lint 0 / vitest 全过（含新 tokenize 单测）/ build / 自检 ≥62 / grep 无 emoji
- 浏览器实测：坑 1/2/3 三个复现场景全过

## 开始

先读 `src/engine/host.ts`（tokenize/路由/spawn）、`src/engine/lifo-core.ts` + lifo 包源码（node shim 转发行为，`/tmp/lifo-inspect` 或 node_modules）、`src/tests.ts`、`scripts/scenarios.mjs`，然后实现。完成后输出报告：三个坑的修复实现、tokenize 单测清单、自检数字、浏览器复现结果。
