# Succinix Cordis 契约

[English](cordis-contract.md)

## 这是什么

这是 `@succinix/engine@0.7.0` 的对外承诺清单。它不是产品介绍，而是一份能在真实浏览器中运行的兼容性检查：第三方只安装打包后的引擎、`@deepseek-ai/cordis` 和 `@webcontainer/api`，不读取本仓库源码。

## 检查什么

| 范围 | 验证的承诺 |
| --- | --- |
| 插件与注入 | 入口是 `{ name: 'succinix', apply, Config }`，四个 dsh 服务可注入或显式探测 |
| 服务表面 | 文件、命令约束、终端会话和会话保存符合公开类型 |
| 执行与实例 | Node、Lifo、Pyodide Python 在同一工作区执行，多个实例复用页面级 host |
| 保存与服务 | 快照、工作区、端口订阅和声明式服务能工作 |
| 生命周期 | 热更新、需要重启的配置、模式冲突、停止和重新应用遵守生命周期规则 |
| 发布资产 | `host.js`、`lifo-core.js` 与 `sha256.json` 的完整性可验证 |

## 怎么验证

```bash
npm run build:engine-package
node scripts/cordis-app-e2e.mjs
```

可执行用例在 [examples/cordis-app/src/contract.ts](../examples/cordis-app/src/contract.ts)。改公开类型、服务、生命周期、资产或事件时，先修改这个用例，再更新相关文档。

## 为什么还有 `contracts` 目录

[`contracts/dsh-0.1.0-rc.6/`](contracts/dsh-0.1.0-rc.6/SOURCES.md) 是从 DeepSeek Harness 固定下来的服务形状快照。它由 `check-dsh-shapes` 校验，内容是精确类型证据，不适合改写成教程；新人应先读[接入说明](SDK.zh-CN.md)。当前 `succinix` 宿主入口仍可通过 `ctx.get('succinix', false)` 使用，但它不替代四个 dsh 服务。
