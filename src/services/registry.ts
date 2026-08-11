// 会话活动端口注册表（O8 拆分自 services.ts）：本次会话启动过的服务/db 实际端口按实例记录。
// M1：preview-port 改动后静态 def.port 失真 —— 服务启动时监听当时的端口，
// 就绪等待 / 状态 / 列表 / URL 都用记录值；会话内未启动过的服务回落动态解析。
// M4：实例端口记录按实例隔离；D3：实例 restart 时按实例清理。

const activePortsByInstance = new Map<string, Map<string, number>>();

export function activePortsFor(instanceId: string): Map<string, number> {
  let m = activePortsByInstance.get(instanceId);
  if (!m) {
    m = new Map();
    activePortsByInstance.set(instanceId, m);
  }
  return m;
}

/** D3：实例 restart 清服务活动端口记录（本会话启动记录表）。 */
export function clearActivePorts(instanceId: string): void {
  activePortsByInstance.delete(instanceId);
}

// ─── db 活动端口（M1：db start 记录 / status/stop 读取；从 commands.ts 迁入，D3 需按实例清理）───
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
