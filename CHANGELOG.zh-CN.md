# 更新记录

[English](CHANGELOG.md)

这里只保留当前版本对使用者和接入方有影响的变化。更早的开发过程、测试日志和逐提交细节由 Git 历史保存，不再作为产品文档维护。

## 0.7.0

### 这次有什么变化

- Succinix 现在以 `@succinix/engine` Cordis 插件形式接入第三方应用。
- 普通插件使用 `fs`、`sandbox`、`terminals`、`sessionPersistence` 四个服务；宿主通过 `ctx.get('succinix', false)` 管理 WebContainer、实例和执行器。
- 浏览器终端、Node、Python 和 Unix 命令共用一个 WebContainer 工作区。
- 工作区使用新版快照保存机制；旧存储只会被识别，不会自动迁移或删除。
- 引擎资产必须作为静态文件发布，第三方接入步骤见[接入说明](docs/SDK.zh-CN.md)。

### 升级前先看

- 从旧 SDK、旧服务命名或旧 RPC 客户端升级时，阅读[迁移说明](docs/MIGRATION.zh-CN.md)。
- 想确认能否接入时，阅读[说明](README.md)和[能力说明](docs/FEATURES.zh-CN.md)。
- 需要严格验证打包产物时，阅读 [Cordis 契约](docs/cordis-contract.zh-CN.md)。
