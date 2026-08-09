// Succinix 版本单一事实来源（P2-7）：构建期由 vite.config.ts 从根 package.json 读 version
// 注入 __SUCCINIX_VERSION__（与 __UNAME_RUNTIME__ 同款模式）。版本升级只改 package.json 一处，
// version / uname / motd / welcome 横幅自动跟随，杜绝「motd 说 0.2.x、uname 说 0.2.y」漂移。
// vitest 环境不走 vite 构建（vite.config 的 define 不作用于 vitest），全局缺失时回落 '0.0.0'
// —— typeof 守卫安全（undeclared 标识符不抛错），测试断言用符号引用而非字面量。
declare const __SUCCINIX_VERSION__: string;

export const SUCCINIX_VERSION: string =
  typeof __SUCCINIX_VERSION__ === 'string' && __SUCCINIX_VERSION__.length > 0
    ? __SUCCINIX_VERSION__
    : '0.0.0';
