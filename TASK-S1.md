# TASK-S1 — Succinix 独立开源仓库准备

## 物理边界（不许越界硬造）

- **不改 src/engine/ 核心代码**（引擎已解耦，本任务是仓库/文档/发布准备）。
- **不执行 `git push` 到 GitHub 远程**（远程创建由 Hermes 确认后操作；CC 只做本地准备 + 验证）。
- **不执行 `npm publish`**（发布由 Hermes 确认后操作）。
- 不改 UI 设计规范（英文文案/暗色主题/无 emoji 等 AGENTS.md 设计规定）。
- 不新增 npm 依赖。

## 背景

Succinix（原名 WebUnix）已完成品牌迁移（TASK26）、文档中文化（TASK28）、引擎解耦（src/engine/ + PROTOCOL.md/SDK.md）。现在准备独立开源：作为独立附属项目发布到 GitHub（`CJackHwang/Succinix`），仓库已确认无同名冲突。

**已就绪**：CI（.github/workflows/ci.yml 含 lint/test/build/场景套件/nightly）、README 已品牌化、docs 全家族（含 FEATURES/SDK/PROTOCOL/中英双版）。

## 需求（逐条、可验收）

### R1. 仓库发布就绪检查（本地）

- `git remote -v` 为空 → **准备 remote 配置**（但**不 push**）：`git remote add origin git@github.com:CJackHwang/Succinix.git`（SSH，凭据已配置）
- 确认 main 分支名（`git branch --show-current` = main）
- 确认 .gitignore 完整（node_modules/dist/public 构建产物/pyodide 资产是否该忽略——**注意 public/pyodide 是运行时资产需保留还是忽略需判断**：若体积大且可从 CDN 重建，加入 .gitignore；若依赖离线可用则保留。**给出结论并执行**）
- 确认 LICENSE 存在（MIT——包名 package.json license 字段核对）

### R2. 版本号与元信息

- package.json 版本当前 0.2.0 → **确认发布版本策略**（0.2.0 保留或 0.1.0 首发，给出建议：独立开源首版建议与 WebUnix 历史版本解耦，可 0.1.0 或保持 0.2.0 延续——**给出建议并执行，说明理由**）
- package.json repository/homepage/bugs 字段补齐（指向 CJackHwang/Succinix）
- README 顶部 badge（CI status 等，可选，不强制）

### R3. 仓库规模检查

- `du -sh` 仓库总大小；若有超大文件（>10MB）在 git 历史或工作区（如 public/pyodide ~13MB），**评估**：进 git 还是 .gitignore（.gitignore 优先——构建时可从 CDN 拉取，SDK.md 已有此方向）
- `git count-objects -vH` 确认仓库对象体积合理

### R4. 发布前验证

- `npm run lint` + `npm run build` 全绿（CI 会跑，本地预验证）
- `npx tsc -p tsconfig.json --noEmit` 0 错误
- 静态自检 `grep -n '✅\|❌\|🎉\|GREEN' src/ index.html` 0 匹配
- 浏览器冒烟（可选）：dev server 7892 起来自检通过（网络允许时）

## 保留项（不许改清单）

1. src/engine/ 核心代码
2. UI 设计规范（AGENTS.md）
3. docs/ 现有文档内容（只增不删；若发现过时信息可小修并说明）
4. 不新增依赖

## 开发规范（Trellis，必须遵守）

- 完成后跑节选门禁：`npx tsc -p tsconfig.json --noEmit` + `npm run lint` + `npm run build`
- 代码注释中文、无 emoji

## 质量门禁（节选）

1. tsc 0 错误
2. lint 0 error
3. build 成功
4. .gitignore 处理 pyodide/构建产物结论明确（保留或忽略，理由充分）
5. remote 已 add（未 push）
6. 版本号/元信息决策说明
7. `git diff --check` 干净

## 约束

- 提交信息：`chore: S1 独立开源仓库准备（remote/版本/元信息/发布就绪检查）`
- **不 push、不 publish**——只做本地准备，远程操作由 Hermes 后续执行
- 不确定的地方（如 pyodide 资产进不进 git）给出**明确建议 + 理由**再执行
