# Cordis 与 WebContainer 最小验证

## 这是什么

这是一个小型浏览器验证页，用来确认 `@deepseek-ai/cordis@4.0.1` 可以和 WebContainer 同时工作，并能通过 Cordis 提供和消费四个 dsh 服务键。

## 怎么运行

```bash
npx vite --config examples/cordis-poc/vite.config.ts
```

它是兼容性检查，不是第三方接入范例。真正的接入方式请看 [../cordis-app/README.md](../cordis-app/README.md)。
