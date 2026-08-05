#!/usr/bin/env bash
# WebUnix pre-commit hook（TASK20，零依赖方案）：
#   1) tsc 快查（--noEmit，0 error）
#   2) eslint 只检查变更文件（暂存区 + 工作区，.ts/.tsx/.mjs/.js）
# 安装：npm run setup:hooks（写 .git/hooks/pre-commit 指向本脚本）。
# 未强制：不装也能提交（README 说明）。失败时拒绝提交。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[pre-commit] typecheck (tsc --noEmit)..."
npx tsc -p tsconfig.json --noEmit

# 变更文件：暂存区 + 未暂存（新增/修改，排除删除），过滤出 lint 目标后缀。
FILES="$(git diff --cached --name-only --diff-filter=ACM; git diff --name-only --diff-filter=ACM)"
LINT_TARGETS="$(printf '%s\n' "$FILES" | grep -E '\.(ts|tsx|mjs|js)$' | grep -v '^dist/' | sort -u || true)"

if [ -n "$LINT_TARGETS" ]; then
  echo "[pre-commit] linting changed files..."
  # shellcheck disable=SC2086
  npx eslint $LINT_TARGETS
else
  echo "[pre-commit] no JS/TS files changed; skipping eslint"
fi

echo "[pre-commit] OK"
