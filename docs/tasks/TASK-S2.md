# TASK-S2 — @succinix/engine npm 发布准备

## 物理边界（不许越界硬造）

- **不改 src/engine/ 核心代码逻辑**（打包配置/package 元数据可以动，引擎实现不动）。
- **不执行 `npm publish`**（发布由 Hermes 确认后执行）。
- 不新增运行时依赖。
- 全英文 UI 文案、无 emoji（本任务主要不涉及 UI）。

## 背景

S1 完成：Succinix 独立仓库准备就绪（remote 配好、版本元信息补齐、pyodide 忽略）。SDK.md 已评估推荐 **Form A：`@succinix/engine`** npm 包——把引擎目录（浏览器客户端 + 两个容器内 host 资产）打包发布，消费者 `npm install` 后：

```ts
import { WebContainer } from '@webcontainer/api';
import { createTerminalExecutor } from '@succinix/engine';
const wc = await WebContainer.boot();
const term = createTerminalExecutor();
await term.boot(wc, { hostJsUrl: '...', lifoCoreUrl: '...' });
```

**本任务：把 src/engine/ 打包成可发布的 npm 包结构（本地准备 + 验证，不 publish）。**

## 需求（逐条、可验收）

### R1. 打包结构设计

- 评估：`@succinix/engine` 包结构（源码直接发布 vs 构建产物发布）
  - **推荐**：构建产物（dist/）发布——消费者拿到的干净 ESM；或源码 + exports map 直接指向 src（零构建）——**评估两者，给建议 + 理由**（引擎依赖 @webcontainer/api（peer），浏览器 ESM）
  - 包内包含：TerminalClient/终端执行器 API + host.js/lifo-core.js 资产（**资产如何随包分发**：包内 assets/ 目录 + 消费者拷贝？还是 CDN URL 参数？给建议）
- peerDependencies：`@webcontainer/api`（引擎类型依赖它，不作为直接依赖打包）

### R2. 包结构落地（本地）

- 创建包的构建/导出配置（tsconfig.build 或 exports map）：
  - `exports`：`.` → ESM 入口（TerminalExecutor 全 API）、`./host.js` → 资产、`./lifo-core.js` → 资产
  - 类型声明（.d.ts）随包
- 若选择构建产物：build 脚本产出 dist/（干净 ESM，无 node 依赖）；若选择源码直发：exports map 指向 src/*.ts（消费者 bundler 处理）
- package.json 增加 `files` 白名单（只发该发的）
- 引擎自包含验证：**grep 引擎内是否引用了项目其他层**（persist/log/config 等）——index.ts 注释声称自包含，验证属实

### R3. 本地打包验证（不 publish）

- `npm pack --dry-run` → 确认包内容（files 白名单生效、资产在内、无 node_modules/超大文件）
- 用产物跑一个最小集成验证（可选，网络允许时）：临时消费者项目 import 包 → 类型检查过（tsc 引用 @succinix/engine 类型）
- 包名/版本确认：`@succinix/engine` 0.1.0（首发版本与 WebUnix 0.2.0 解耦——S1 已决策版本策略，保持一致）

### R4. README/使用文档（包级）

- 包 README 或 engine 使用说明：安装、boot 用法、资产分发方式、限制（浏览器环境要求 COOP/COEP、WebContainer 平台要求）

## 保留项（不许改清单）

1. src/engine/ 核心逻辑（打包配置/导出声明可以动，行为逻辑不动）
2. 现有 docs/（SDK.md 是设计文档，若包结构落地与设计一致，可加"已实现"标注）
3. 不新增运行时依赖（devDependencies 打包工具可以加）

## 开发规范（Trellis，必须遵守）

- 完成后跑节选门禁：`npx tsc -p tsconfig.json --noEmit` + `npm run build` + `npm pack --dry-run`
- 代码注释中文、无 emoji

## 质量门禁（节选）

1. tsc 0 错误（主项目 + 包类型）
2. build 成功（主项目不受影响）
3. `npm pack --dry-run` 内容正确（files 白名单、资产在内、无垃圾）
4. 引擎自包含验证（无项目其他层引用）
5. `git diff --check` 干净

## 约束

- 提交信息：`feat: S2 @succinix/engine 打包结构（npm 发布准备，本地验证）`
- **不 publish**——`npm pack --dry-run` 是验证上限
- 不确定的地方（源码直发 vs 构建产物、资产分发方式）给出**明确建议 + 理由**再执行
