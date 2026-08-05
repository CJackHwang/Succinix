# 为 Succinix 做贡献

> 中文翻译。英文版为准：见 [CONTRIBUTING.md](CONTRIBUTING.md)

感谢你有兴趣参与贡献。本项目致力于打造专业、生产级的浏览器原生 Linux 环境。请先阅读 [AGENTS.zh-CN.md](AGENTS.zh-CN.md)（英文版：[AGENTS.md](AGENTS.md)）——它规定了每项贡献都必须遵循的设计规则。

## 开发环境搭建

要求：Node.js 20+、npm。

```bash
npm install
npm run dev          # 在 http://localhost:7892 启动 dev server
```

dev server 已配置 WebContainers 所需的 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` 头。不得更改端口或移除这些头。

## 项目结构

```
src/
  main.ts            # 入口：xterm 终端、REPL、boot 编排
  boot.ts            # 启动序列、系统信息、自检
  commands.ts        # 浏览器侧命令（help/ports/db/...）
  tests.ts           # 自检套件（?test=1）
  engine/            # TerminalExecutor 引擎（已解耦、可复用——见 README 生态）
    index.ts         # 公开 API：createTerminalExecutor / bootEngineHost / waitForHostReady + 类型
    client.ts        # 文件 RPC 客户端，TerminalClient（原 terminal-client.ts）
    host.ts          # TerminalExecutor 守护进程，运行于 WebContainer 内（原 host.ts）
    host-procs.ts    # 统一进程注册表（原 host-procs.ts）
scripts/build-host.mjs
```

## 设计与编码规范

完整规则见 [AGENTS.zh-CN.md](AGENTS.zh-CN.md)。要点：

- **界面语言**：所有用户可见输出为英文。
- **禁用 emoji**：UI 文本、输出或渲染到终端的注释中绝不可使用 emoji 或象形符号。使用 ASCII 状态标记（`[  OK  ]`、`[FAIL]`、`[SKIP]`）。
- **主题**：暗琥珀色调色板，无绿色强调。精确色值见 AGENTS.md。
- **字体**：JetBrains Mono（经 `@fontsource/jetbrains-mono` 打包，无 CDN）。
- **代码注释**：面向开发者的注释可用中文；标识符为英文。
- **TypeScript**：必须启用严格模式。
- **生产质感**：克制、专业。非玩具风格。

## 协议与架构约束

以下不变量不可破坏：

- **文件 RPC（file RPC）**：`/cmd.json` → `/result-<id>.json`。每个请求一个独立结果文件。绝不可回退到单一共享结果文件（它曾导致丢响应竞态，见提交历史）。
- **路由（routing）**：以 `node`、`npm` 或 `npx` 开头的命令交给真实 Node.js 子进程；其余命令交给 Lifo 沙箱。
- **统一文件系统（unified filesystem）**：浏览器的 `wc.fs`、Node 子进程与 Lifo 经 WebContainer 虚拟化的 `node:fs` 共享同一个文件系统。不要引入文件系统桥。
- **数据库（database）**：tinbase 必须以 `--engine wasm --memory` 启动（WebContainer 内无原生二进制）；安装超时必须传主机侧 `{ timeout: 120000 }` 选项。

## 质量门禁

以下全部通过后 PR 才能合并：

```bash
npx tsc -p tsconfig.json --noEmit   # 0 errors
node scripts/build-host.mjs         # host bundle 构建通过
npm run build                       # 生产构建通过
```

运行时验证（手动，浏览器中）：

1. `npm run dev` 并打开 `http://localhost:7892`。
2. 确认启动序列与自检完成，然后出现提示符。
3. 通过 `http://localhost:7892/?test=1` 运行完整自检套件。
4. 抽查一条真实 Node 命令（`node -e "console.log(1+1)"`）与一条 Lifo 命令（对文件执行 `grep`）。
5. 确保 UI 输出中任何位置都不出现 emoji。

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: add port forwarding registry
fix(host): avoid result overwrite race
docs: update architecture diagram
refactor(tests): adopt self-test format
chore: bump dependencies
```

提交保持聚焦、原子。适当时引用相关 TASK 文件。

## 拉取请求流程

1. 从 `main` 创建功能分支（`git checkout -b feat/your-change`）。
2. 在适用处编写测试实现；运行上述质量门禁。
3. 推送并打开拉取请求，描述改动、重要性以及验证方式。
4. 保持 diff 可审查——把大改动拆成多个 PR。
5. 维护者将进行审查；处理反馈后重新运行门禁。

## 问题

Bug 与功能请求请开 issue。设计问题请参阅 [AGENTS.zh-CN.md](AGENTS.zh-CN.md) 与 [README.zh-CN.md](docs/README.zh-CN.md) 的架构章节。
