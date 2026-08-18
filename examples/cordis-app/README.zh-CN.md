# Cordis App 契约示例

[English](README.md)

## 这是什么

这是一个独立第三方应用。它只使用打包后的 `@succinix/engine`，不导入 Succinix 源码，因此能证明实际发布物是否可被别人接入。

## 有什么用

它检查插件安装、四个 Cordis 服务、命令执行、文件、终端、会话保存、实例、端口、服务、快照、热更新和资产完整性。

## 怎么运行

在仓库根目录执行：

```bash
npm run build:engine-package
node scripts/cordis-app-e2e.mjs
```

手动查看时：

```bash
cd examples/cordis-app
npm install
npm run build
npm run preview
```

打开 `http://localhost:7895/`，等待结果摘要。示例会把包内 host、Lifo 和 Python 资产复制到自己的静态目录，模拟第三方应用的真实接入方式。
