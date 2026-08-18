# Succinix 能力说明

[English](FEATURES.md)

## 这是什么

Succinix 是浏览器里的项目终端运行环境。它把文件、命令、进程和服务放在同一个 WebContainer 工作区中，应用和终端访问的是同一份项目内容。

## 有什么用

| 你要做的事 | Succinix 提供什么 |
| --- | --- |
| 运行前端或 Node 项目 | 真实 `node`、`npm`、`npx`，可启动开发服务并给出预览地址 |
| 处理脚本和数据 | `python`、`pip` 及常用 Unix 命令，共用项目文件 |
| 保存浏览器内项目 | 工作区和设置可快照保存，刷新后恢复 |
| 管理多个项目环境 | 独立工作区、实例、进程和端口视图 |
| 嵌入自己的产品 | Cordis 插件服务：文件、命令约束、终端会话和会话持久化 |

## 怎么用

1. 直接使用时启动开发服务器，打开 `http://localhost:7892`，在终端输入 `help`。
2. 新建项目后用 `npm install` 和 `npm run dev`；用 `ports` 查看预览地址。
3. 需要保存时执行 `snapshot save`；需要排查环境时执行 `succinix doctor`。
4. 嵌入应用时按 [接入说明](SDK.zh-CN.md) 安装 `@succinix/engine` 并挂载到 WebContainer。

## 使用前要知道

- 只支持 Chromium 浏览器，页面必须启用 COOP/COEP。
- Node 命令在 WebContainer 中运行；其他常用 Unix 命令由 Lifo 提供；它们共享文件。
- Python 可以运行脚本和安装支持的包，但没有通用交互式 REPL，也不能启动操作系统子进程。
- 端口只是浏览器预览，不接受互联网主动连接。
- 工作区按实例分开，方便组织项目；这不是安全隔离或权限系统。
- 不提供原生二进制、`apt`、`chmod`、符号链接或硬链接。

需要逐字段的服务行为或协议兼容信息时，读取[接入说明](SDK.zh-CN.md)、[协议](PROTOCOL.zh-CN.md)和 [Cordis 契约](cordis-contract.zh-CN.md)。
