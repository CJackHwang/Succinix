# Succinix 运行时说明

## 这是什么

Succinix 在浏览器里提供几个可直接使用的运行时。它们都使用同一个项目工作区，因此终端、Node 和 Python 写入的文件可以互相看到。

## 有什么用

| 运行时 | 适合做什么 | 需要注意 |
| --- | --- | --- |
| Node.js / npm / npx | 前端、Node 服务、TypeScript 工具链 | 使用真实 WebContainer Node；全局 npm 安装不可用，请在项目内安装依赖 |
| Python / pip | 脚本、数据处理、支持的 Python 包 | 基于 Pyodide；用 `python -c` 或脚本文件运行，不提供通用 REPL 或 `subprocess` |
| Unix 命令 | 文件处理、文本筛选、管道和项目操作 | 由 Lifo 提供，和 Node/Python 共用文件 |
| Ruby | 运行已支持的 Ruby WASM 脚本 | 首次启动较慢，不提供 gem 安装 |
| WASI | 运行已编译的 WASI 模块 | 可以运行，不能在环境内编译 C、Rust 或 Go |

## 怎么用

```text
node --version
npm install
npx tsc
python script.py
python -m pip install <包名>
grep -R "TODO" .
```

使用 `lang` 查看当前内置运行时。启动项目服务后用 `ports` 查看预览地址。

## 不支持的情况

- C、Rust、Go 编译器不在环境中。
- Python 不能运行交互式 REPL 或通过 `subprocess` 创建系统进程。
- 访问没有 CORS 许可的网站可能失败。
- 不支持全局 npm 安装、原生可执行文件和真实入站网络。

需要按版本、错误码或复现实验核对运行时行为时，这是开发者参考，不是日常使用说明：请查看测试脚本和 [PROTOCOL.md](PROTOCOL.md)。
