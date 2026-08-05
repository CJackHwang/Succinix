# WebUnix — TASK22：Vercel 部署适配（静态站托管）

## 背景

WebUnix 是纯静态站（Vite → dist/），用户将托管到 Vercel。**关键约束**：WebContainer 需要跨源隔离（COOP/COEP 头），Vercel 用 `vercel.json` 的 headers 配置支持。参考：SunamAI（同仓库体系）已部署 sunam.alibicore.com（Vercel + COOP/COEP 已配）。

现状（已确认）：
- `npm run build` = `build:host && vite build`，dist/ 含 assets + host.js + index.html ✅
- **无 vercel.json** ❌（缺 COOP/COEP 头配置）

## 需求

### 1. vercel.json（新文件，根目录）

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" }
      ]
    }
  ],
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite"
}
```

- 头配置必须覆盖所有路径（含 assets/host.js）
- 与 dev（vite.config.ts headers）保持一致

### 2. 本地部署验证（无 vercel CLI token 时的等效验证）

- `npx vite preview`（或 `vite preview --port 7892`）模拟生产构建产物
- 验证：HTTP 200 + **COOP/COEP 头在位**（curl -I）
- 完整功能冒烟：`?test=1` 在 preview 模式下跑通（≥51 passed）——**这是"静态产物可部署"的最终证明**（preview 与 Vercel 服务方式等价）
- 若环境有 vercel CLI 且用户提供 token 则实部署；没有则 README 给出部署步骤 + 本验证即"部署就绪"证据

### 3. README 部署章节

- 新增 **Deployment** 章节：
  - 一键部署（Vercel dashboard import / `vercel deploy`）
  - 说明 vercel.json 的 COOP/COEP 必要性（WebContainer 硬性要求，缺失则白屏 + 环境错误页）
  - 域名/自定义域提示（如 webunix.alibicore.com 或 cjack.me 子域）
  - 静态站性质说明（无后端、数据在浏览器 IndexedDB）
- Known Boundaries 补一条：部署环境必须支持自定义响应头（Vercel 免费版支持）

### 4. CI（TASK20 联动）

- TASK20 的 CI 加一个 job：`npm run build` + `vite preview` + headers 断言（COOP/COEP）+ `?test=1` 冒烟（headless Chrome）——**部署就绪门禁**（若 TASK20 先于本任务完成，本任务在 CI 配置里补该 job；否则本任务自带验证脚本即可）

### 5. 边缘检查

- COEP credentialless 与 Vercel 静态资源/CDN 行为兼容（无第三方 iframe/worker 加载冲突）
- host.js 1.07MB（minified）静态服务正常（无 gzip 问题——Vercel 自动压缩）
- IndexedDB 按 origin 隔离：**部署域变化 = 数据分域**（README 注明：换域部署等于换新系统，数据不迁移）

## 保留项（不许改）

- 不新增依赖；构建产物结构不动（dist/ 输出）
- 不动 vite.config.ts 的 dev headers（与 vercel.json 并存，各管各的）

## 质量门禁

- `npx tsc --noEmit` 0 错；`npm run build` 成功
- `npx vite preview` + curl 头断言：COOP=same-origin / COEP=credentialless
- `?test=1` 在 preview 模式 ≥51 passed（headless Chrome 或人工）
- `grep -rn '✅\|❌\|🎉\|GREEN' src/ index.html` 无结果

## 约束

- 注释中文、标识符英文、README 英文
- 完成输出总结：vercel.json 内容、preview 验证结果（头 + 自检数字）、README 章节、门禁结果

## 开始

先读 `vite.config.ts`（对照 dev headers）、`package.json`、`README.md`，然后实现。
