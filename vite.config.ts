import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// R1（TASK17）：uname -r 的 @webcontainer/api 运行时版本改为构建期注入，杜绝硬编码漂移。
// 数据源用已安装版本（node_modules 实际解析版本），而非根 package.json 的 semver 区间
// （^1.6.4 不是真实版本）；依赖升级后 uname 自动跟随，不输出假数据。
function resolveApiRuntimeVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('./node_modules/@webcontainer/api/package.json', import.meta.url), 'utf8')
    ) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return ''; // node_modules 不可读：构建期大概率已失败；空串由调用方兜底显示
  }
}

// P2-7：Succinix 自身版本从根 package.json 注入（单一事实来源，升版本只改一处）。
// src/version.ts 的 SUCCINIX_VERSION 消费；version / uname / motd / welcome 横幅一致跟随。
function resolveSuccinixVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('./package.json', import.meta.url), 'utf8')
    ) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0'; // package.json 不可读：构建期大概率已失败；'0.0.0' 由 version.ts 兜底
  }
}

// WebContainer requires cross-origin isolation (COOP/COEP) + SharedArrayBuffer.
export default defineConfig({
  define: {
    // 供 src/commands.ts 的 uname -r 使用（declare const 声明；Vite 构建期文本替换为字面量）。
    __UNAME_RUNTIME__: JSON.stringify(resolveApiRuntimeVersion()),
    // 供 src/version.ts 的 SUCCINIX_VERSION 使用（同上模式；根 package.json 版本单一来源）。
    __SUCCINIX_VERSION__: JSON.stringify(resolveSuccinixVersion()),
  },
  server: {
    port: 7892,
    // TASK23：固定 7892，禁用端口漂移（WebContainer 需要稳定 origin；scripts/start-dev.mjs
    // 启动前会释放被占用的 7892）。strictPort 让 vite 端口被占时直接报错而非漂到 7893。
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});
