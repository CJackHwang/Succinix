// 实例状态路径（M2）：浏览器侧 /etc 状态文件按实例前缀分割。
// 缺省实例（'default'）= 现状 `/etc/...`（单实例全等）；实例化时 =
// `<stateRoot>/etc/...`，stateRoot = `/workspace/.succinix-<id>`（DM-12）。
// 页面级文件（/ws/.current 工作区指针、/browser-wrote.txt 自检文件）**不**走本函数
// —— workspace 是页面/容器级语义，见 MASTER-PLAN M2 保留项。

export const DEFAULT_INSTANCE_ID = 'default';
export const INSTANCE_STATE_ROOT_PREFIX = '/workspace/.succinix-';

/** 实例状态根（浏览器 wc.fs 视角）；缺省实例 = ''（/etc 现状，无前缀）。 */
export function instanceStateRoot(instanceId: string): string {
  return instanceId === DEFAULT_INSTANCE_ID ? '' : `${INSTANCE_STATE_ROOT_PREFIX}${instanceId}`;
}

/** 实例化状态文件路径：statePath('default', 'etc/succinix.env') = '/etc/succinix.env'；
 *  statePath('c-1', 'etc/succinix.env') = '/workspace/.succinix-c-1/etc/succinix.env'。
 *  name 可带前导 /（容错），首段若为 'etc' 之外的绝对路径原样挂到状态根下。 */
export function statePath(instanceId: string, name: string): string {
  const root = instanceStateRoot(instanceId);
  const clean = name.replace(/^\/+/, '');
  return root ? `${root}/${clean}` : `/${clean}`;
}

/** tinbase 数据目录（M4）：实例 = <stateRoot>/tinbase；缺省实例 = /workspace/.tinbase（现状）。 */
export function tinbaseDataDir(instanceId: string): string {
  const root = instanceStateRoot(instanceId);
  return root ? `${root}/tinbase` : '/workspace/.tinbase';
}
