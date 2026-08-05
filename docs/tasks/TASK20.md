# WebUnix — TASK20：CI 建设 + 标准测试流程

## 背景

TASK19 场景测试完成（10/10，自检 57）。本任务 = **CI 与标准测试流程**：GitHub Actions + lint + 单测 + e2e + 覆盖率 + pre-commit，把已有验证脚本（verify-deploy / bench / scenarios / 自检）串成自动化流水线。**质量优先，流程要专业。**

## 0. 跟进修复（TASK19 复审 N1-N4）

1. **N1（必改）**：`ensureNpxPackage` 探测 `test -d node_modules/<pkg>` 相对路径被 Lifo 按 VFS 根解析恒判缺失 → 每次冗余 npm install + 虚假 WARN。改绝对路径 `test -d /workspace/node_modules/<pkg>`；`dbStart` 里同类的旧探测一并修
2. **N2（低-中）**：persist.ts 空目录去重缺口——仅空目录变化（`emptyDirs` 参与签名）时不写 IDB，裸 mkdir + 刷新丢。修复：doSave 去重签名纳入 emptyDirs
3. **N3（低）**：scenarios.mjs S6 并发场景实为队列串行——改名"queue serialization correctness"降级（或页面内真并发 client.exec——选改名，简单诚实）
4. **N4（低）**：tests.ts 自检 npx spawn 网络挂起时自检 crash（RPC 超时抛异常）——套 try/catch + 缩短 timeout，离线优雅失败

## 1. ESLint（新增，标准配置）

- `eslint` + `typescript-eslint`（devDependencies，允许新增 dev 依赖——**运行时依赖仍不新增**）
- 配置：`eslint.config.js`（flat config），规则集：typescript-eslint recommended + 项目定制：
  - 禁 `any`（error）、`console.log` 遗留（warn，host.ts 例外）
  - 无未用变量/导入
  - 与现有代码风格一致（检查现有代码，规则集跑通 0 error 才能加）
- `npm run lint` 脚本
- **门禁**：lint 0 error（warn 可容忍但应清零）

## 2. 单测（Vitest，纯逻辑模块）

- `vitest` devDependency
- 测试对象（纯逻辑，无浏览器依赖）：
  - `src/log.ts`：行格式/tail/rotate/clear（mock FS）
  - `src/persist.ts`：排除规则/签名门控/force 语义（mock FS）
  - `src/services.ts`：解析/端口渲染/needle 匹配
  - `src/pkg.ts`：来源判定/命令构造（mock 网络）
  - `src/motd.ts`、`src/config.ts`：文件读写逻辑
- 目标：核心纯逻辑覆盖率 ≥70%（v8 coverage）
- `npm run test`（vitest run）

## 3. e2e（复用现有 CDP 脚本，零新运行时依赖）

- 已有：`verify-deploy.mjs`（部署就绪）、`bench.mjs`（性能）、`scenarios.mjs`（场景）
- `npm run test:e2e` = 起 dev/preview + 依次跑三个脚本（或合并脚本，CI 用）
- 不引入 Playwright（保持零依赖 + 与本地一致；如需再评估）

## 4. GitHub Actions（`.github/workflows/ci.yml`）

```yaml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - checkout
      - setup-node 22（缓存 npm）
      - npm ci
      - npm run lint
      - npm run typecheck（tsc --noEmit）
      - npm run test（vitest + coverage）
      - npm run build:host && npm run build
      - e2e: 起 vite preview + headless Chrome（安装 chromium 或用 ubuntu 自带 chrome）跑 verify-deploy/自检
  nightly-scenarios:（schedule cron，可选——场景套件重，nightly 跑）
```

- e2e job 的 Chrome：ubuntu-latest 自带 Chrome（google-chrome），CDP 脚本已支持路径探测
- 自检门禁：≥57 passed（headless）

## 5. pre-commit hooks

- 方案：`husky` + `lint-staged`（标准）或零依赖 `.git/hooks` 脚本（简单）
- **选零依赖方案**：`scripts/pre-commit.sh`（tsc 快查 + eslint 变更文件）+ 安装脚本 `npm run setup:hooks`（写 .git/hooks/pre-commit 指向它）
- 约束：不强制（npm install 后手动 setup），README 说明

## 6. 文档

- README：Testing 章节（lint/test/test:e2e/CI 说明）、CI 徽章位（GitHub Actions workflow badge）
- CHANGELOG 更新

## 门禁

- tsc 0 错 / lint 0 error / vitest 全过（覆盖率 ≥70% 核心）/ build / 自检 ≥57 / grep 无 emoji
- CI 文件语法正确（本地 `npx actionlint` 或人工核对——actionlint 若不便装则仔细核对缩进/字段）

## 保留项

- 运行时依赖不新增（devDependencies 允许：eslint/typescript-eslint/vitest）；协议/路由/端口/tinbase/主题/COOP/COEP 不变
- e2e 复用 CDP 脚本（不引 Playwright）

## 开始

先读 `package.json`、`AGENTS.md`、`scripts/`（verify-deploy/bench/scenarios）、`src/`，然后实现。完成后输出总结：lint/单测/CI 配置、覆盖率数字、CI 文件内容、门禁结果。
