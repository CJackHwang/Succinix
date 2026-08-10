// host rpc 域（O3 拆分）：cmd.json / result-<id>.json 文件协议与结果清理。
import fs from 'node:fs';
import { DEFAULT_INSTANCE_ID, normalizeInstanceId } from '../host-route.js';
import { resultTtlMs } from './config.js';

export const CMD_FILE = 'cmd.json';
export const RESULT_PREFIX = 'result-'; // result-<id>.json

export interface CommandRequest {
  /** 协议版本（TASK21：客户端写 protocol: 1；缺失按 v1 处理，向后兼容） */
  protocol?: number;
  id: number;
  cmd: string;
  opts?: Record<string, unknown>;
  /** 实例上下文（M2/M3，additive）：可选，缺失 = 默认实例 'default'（旧行为不变）。 */
  instanceId?: string;
}

// M3：结果回带请求的 instanceId（additive，旧客户端忽略未知字段）。instanceId 必须是
// 请求时刻捕获的归一化值 —— node 子进程 settle 是异步的，不能用当时已变的 currentInstanceId。
export function writeResult(id: number, payload: Record<string, unknown>, instanceId = DEFAULT_INSTANCE_ID): void {
  fs.writeFileSync(RESULT_PREFIX + id + '.json', JSON.stringify({ id, instanceId, ...payload }));
}

// 清理被放弃请求留下的陈旧 result-*.json，避免无限累积。
export function pruneStaleResults(): void {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync('.')) {
      if (!name.startsWith(RESULT_PREFIX) || !name.endsWith('.json')) continue;
      const st = fs.statSync(name);
      if (now - st.mtimeMs > resultTtlMs()) fs.unlinkSync(name);
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

// 请求的实例归一化：缺失 / 空串 = 默认实例（additive，旧客户端零改动）。
export function instanceOf(req: CommandRequest): string {
  return normalizeInstanceId(req.instanceId);
}
