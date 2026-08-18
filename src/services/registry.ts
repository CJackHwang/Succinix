// 数据库活动端口投影：仅供 db 命令在本次会话内定位其已启动端口。
// 服务生命周期状态由执行世界管理，不得在浏览器侧登记或推导。
const dbActivePortByInstance = new Map<string, number>();

export function dbActivePortFor(instanceId: string): number | null {
  return dbActivePortByInstance.get(instanceId) ?? null;
}

export function setDbActivePort(instanceId: string, port: number): void {
  dbActivePortByInstance.set(instanceId, port);
}

/** D3：实例 restart 清 db 活动端口记录。 */
export function clearDbActivePorts(instanceId: string): void {
  dbActivePortByInstance.delete(instanceId);
}
