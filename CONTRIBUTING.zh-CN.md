# 参与 Succinix

[English](CONTRIBUTING.md)

## 这是什么

这是一份给贡献者的工作说明。开始编码前先读 [AGENTS.md](AGENTS.md)：它定义了不能破坏的架构、界面和提交规则。

## 怎么开始

需要 Node.js 22+ 和 npm：

```bash
npm install
npm run dev
```

打开 `http://localhost:7892`。开发服务器已经配置 WebContainer 必需的 COOP/COEP 响应头和端口 `7892`，不要随意改动。

## 代码放在哪里

| 目录 | 负责什么 |
| --- | --- |
| `src/plugin/` | Cordis 插件、服务和生命周期；只有这里可以导入 Cordis |
| `src/engine/` | WebContainer host、RPC、命令路由和运行时适配 |
| `src/terminal/` | 终端启动与浏览器设备层 |
| `src/instance/`、`src/persist/`、`src/services/` | 实例、快照和后台服务 |
| `src/commands/`、`src/userland/` | 内置命令和执行世界扩展 |
| `tests/` | 单元和契约行为测试 |
| `scripts/` | 构建、检查和浏览器验证 |

## 贡献时记住

- WebContainer 是执行世界；不要在浏览器另建文件系统、命令、进程表或编辑器。
- `/cmd.json` 到独立 `/result-<id>.json` 的 RPC 不能改成共享结果文件。
- `node`、`npm`、`npx` 走真实 Node；Lifo 承担其他 Unix 命令；它们必须共享文件。
- UI 输出为英文、无 emoji、使用既定暗琥珀主题和 JetBrains Mono。
- 多实例是组织边界，不是权限或安全系统；不要补假登录、`chmod` 或原生二进制模拟。

## 怎么验证和提交

日常改动至少运行与范围相符的检查。改代码通常先跑：

```bash
npx tsc -p tsconfig.json --noEmit
node scripts/build-host.mjs
npm run build
npm run lint
npm run test
npm run check:docs
```

影响公开插件、浏览器执行或发布物时，继续运行 `npm run check:engine-package`、`npm run check:plugin-boundaries` 和 `npm run test:e2e`。提交前审查差异，按具体路径暂存；提交信息使用简体中文，例如 `fix(终端): 修复结果文件清理`。完整门禁与 Git 纪律以 [AGENTS.md](AGENTS.md) 为准。
