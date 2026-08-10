// 实例状态路径（M2）：浏览器侧 /etc 状态文件按实例前缀分割。
// 缺省实例（'default'）= 现状 `/etc/...`（单实例全等）；实例化时 =
// `<stateRoot>/etc/...`，stateRoot = `/workspace/.succinix-<id>`（DM-12）。
// 页面级文件（/ws/.current 工作区指针、/browser-wrote.txt 自检文件）**不**走本函数
// —— workspace 是页面/容器级语义，见 MASTER-PLAN M2 保留项。

export const DEFAULT_INSTANCE_ID = 'default';
export const INSTANCE_STATE_ROOT_PREFIX = '/workspace/.succinix-';

/** 实例状态根（浏览器 wc.fs 视角）；缺省实例 = ''（/etc 现状，无前缀）。
 *  prefix 覆盖状态根前缀（M5 statePrefix 选项；缺省 = DM-12 内置 /workspace/.succinix-）。
 *  注意：host 侧进程归属 / 状态解析以内置前缀为准（.succinix-<id> 段），自定义前缀仅供
 *  浏览器侧布局使用，宿主应保持 instanceId 命名与内置前缀对齐（见 SDK.md 多实例节）。 */
export function instanceStateRoot(instanceId: string, prefix: string = INSTANCE_STATE_ROOT_PREFIX): string {
  return instanceId === DEFAULT_INSTANCE_ID ? '' : `${prefix}${instanceId}`;
}

/** 实例化状态文件路径：statePath('default', 'etc/succinix.env') = '/etc/succinix.env'；
 *  statePath('c-1', 'etc/succinix.env') = '/workspace/.succinix-c-1/etc/succinix.env'。
 *  name 可带前导 /（容错），首段若为 'etc' 之外的绝对路径原样挂到状态根下。 */
export function statePath(instanceId: string, name: string, prefix?: string): string {
  const root = instanceStateRoot(instanceId, prefix);
  const clean = name.replace(/^\/+/, '');
  return root ? `${root}/${clean}` : `/${clean}`;
}

/** tinbase 数据目录（M4）：实例 = <stateRoot>/tinbase；缺省实例 = /workspace/.tinbase（现状）。 */
export function tinbaseDataDir(instanceId: string, prefix?: string): string {
  const root = instanceStateRoot(instanceId, prefix);
  return root ? `${root}/tinbase` : '/workspace/.tinbase';
}

// ─── 用户 home（U1）───
// 每用户 home 约定：浏览器视角 /workspace/users/<id>（宿主可覆盖根）。终端会话 cwd 用
// Lifo 视图（browserPathToSessionCwd）—— 浏览器 `/x` == cwd/x == Lifo `/workspace/x`，
// 因此 home 的会话视图是 /workspace/workspace/users/<id>，提示符显示为 `~`（session home 选项）。
export const USER_HOME_ROOT = '/workspace/users';

/** 用户 home（浏览器 wc.fs 视角）；缺省根 /workspace/users，宿主可覆盖。 */
export function userHomePath(userId: string, root: string = USER_HOME_ROOT): string {
  const clean = userId.replace(/^\/+|\/+$/g, '');
  return `${root}/${clean}`;
}

/** 浏览器视角绝对路径 → 会话 cwd（Lifo 视图）：/workspace/users/a → /workspace/workspace/users/a。 */
export function browserPathToSessionCwd(p: string): string {
  const abs = p.startsWith('/') ? p : `/${p}`;
  return `/workspace${abs}`;
}
