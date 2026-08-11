// 包管理封装（TASK13）：pkg 命令族，统一 lifo + npm 两通道（O10 拆分后由 barrel 保持 API 不变）。
// 通道：
//   lifo —— 真实命令：lifo list / lifo search <term> / lifo install <name> / lifo remove <name>
//           （lifo 是 Lifo 扩展包管理器：安装 lifo-pkg-<name>，如 git/ffmpeg/vi/nano）
//   npm  —— 真 Node（host 统一路由 node|npm|npx → 子进程）：npm install / npm uninstall /
//            npm search / npm view；已装列表读 node_modules 顶层目录（"顶层直装"简化，
//            不解析依赖树，README 已注明）。
// 来源判定：lifo-pkg-<name> 在 npm 上存在（lifo search <name> 命中）→ lifo；否则 → npm。
// 同名冲突优先 lifo（工具类，README 注明规则）。
// 约束：网络类操作失败按"已知边界"处理 —— 明确提示原因，不吞错、不假装成功。
export type { PackageEntry, SearchEntry, PkgContext, ActionResult, SearchOutcome } from './metadata.js';
export { isValidPackageName, parseLifoSearch, formatPackageList, formatSearchResults } from './metadata.js';
export { listPackages, searchPackages, detectSource } from './registry.js';
export { installPackage, removePackage, packageInfo } from './installer.js';
