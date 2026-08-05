// WebUnix ESLint flat config（TASK20）。
// 规则集：@eslint/js recommended + typescript-eslint recommended（仅 TS 文件）+ 项目定制：
//   - 禁 any（error）
//   - console.log 遗留（warn；console.warn/error 放行 —— 代码库用其做优雅降级；host 系文件例外）
//   - 无未用变量 / 导入
// 与现有代码风格一致：跑通 0 error 才能合入（warn 应清零）。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'public/host.js', 'public/lifo-core.js'],
  },

  // ─── src/**/*.ts：TS parser + TS recommended + 项目定制 ───
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      // 浏览器侧（boot/commands/tests）与容器 daemon（host）两套全局都放开。
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // 禁 any：错误。若需逐条豁免，用单行 eslint-disable + 理由，不留裸 any。
      '@typescript-eslint/no-explicit-any': 'error',
      // 无未用变量/导入（TS 侧用 ts 规则；关闭与 TS 语法冲突的 core no-unused-vars）。
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-unused-vars': 'off',
      // console.log 遗留 warn；console.warn/error 放行（降级日志惯例）。
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // 终端代码的既定模式：ANSI 控制字符正则（boot-ui 去色）、防御性先赋初值再 try 重赋。
      'no-control-regex': 'off',
      'no-useless-assignment': 'off',
      // host 生命周期代码用"先 let 声明、闭包引用、后赋值"的定时器句柄模式（settle 闭包在赋值前
      // 引用 timer）。ESLint 新版 prefer-const 会把这判成"只赋值一次用 const"——对普通变量合理，
      // 但此处重组会改动关键 spawn 生命周期逻辑，风险大于收益，整组关闭并注明理由。
      'prefer-const': 'off',
    },
  },

  // host 系文件（容器内 daemon，stdout 即终端输出）：console 全部放行。
  {
    files: ['src/host.ts', 'src/host-procs.ts', 'src/host-restart.ts', 'src/lifo-core.ts'],
    rules: { 'no-console': 'off' },
  },

  // ─── tests/**/*.ts：单元测试，Node globals ───
  {
    files: ['tests/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-unused-vars': 'off',
      'no-console': 'off',
    },
  },

  // ─── scripts/*.mjs：CLI 工具，Node globals，console 是它们的输出界面 ───
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      // CDP 客户端里的紧凑三元表达式语句（msg.error ? reject(...) : resolve(...)）。
      'no-unused-expressions': 'off',
      // scenarios 里 strip ANSI 转义的正则含 \x1b 控制字符。
      'no-control-regex': 'off',
    },
  },

  // ─── 根构建配置 TS/JS 文件 ───
  {
    files: ['*.config.ts', '*.config.js'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
    },
  }
);
