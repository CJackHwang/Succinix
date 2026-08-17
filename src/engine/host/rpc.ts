// host rpc 域（O3 拆分）：cmd.json / result-<id>.json 文件协议与结果清理。
import fs from 'node:fs';
import { DEFAULT_INSTANCE_ID, normalizeInstanceId } from '../host-route.js';
import { resultTtlMs } from './config.js';
import { RPC_PROTOCOL_VERSION, isValidRpcRequestId, rpcAckPath, rpcResultPath, type RpcRequestId, type RpcStructuredError } from '../rpc-v2.js';

export const CMD_FILE = 'cmd.json';
export const RESULT_PREFIX = 'result-'; // result-<id>.json
export const ACK_PREFIX = 'ack-';

export interface CommandRequest {
  protocolVersion: typeof RPC_PROTOCOL_VERSION;
  id: RpcRequestId;
  cmd: string;
  opts?: Record<string, unknown>;
  /** 实例上下文（M2/M3，additive）：可选，缺失 = 默认实例 'default'（旧行为不变）。 */
  instanceId?: string;
  bootNonce: string;
  runtimeHint?: string;
  queuedAt?: number;
}

// M3：结果回带请求的 instanceId（additive，旧客户端忽略未知字段）。instanceId 必须是
// 请求时刻捕获的归一化值 —— node 子进程 settle 是异步的，不能用当时已变的 currentInstanceId。
const requestMeta = new Map<string, { bootNonce: string; startedAt: number }>();

export function beginRequest(req: Pick<CommandRequest, 'id' | 'bootNonce'>): void {
  requestMeta.set(String(req.id), { bootNonce: req.bootNonce, startedAt: Date.now() });
}

function atomicWrite(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function writeAck(req: Pick<CommandRequest, 'id' | 'bootNonce' | 'instanceId'>): void {
  atomicWrite(rpcAckPath(req.id, false), {
    protocolVersion: RPC_PROTOCOL_VERSION,
    id: req.id,
    bootNonce: req.bootNonce,
    instanceId: instanceOf(req as CommandRequest),
    acceptedAt: Date.now(),
  });
}

export function writeResult(id: RpcRequestId, payload: Record<string, unknown>, instanceId = DEFAULT_INSTANCE_ID): void {
  const meta = requestMeta.get(String(id));
  const result = {
    protocolVersion: RPC_PROTOCOL_VERSION,
    id,
    bootNonce: meta?.bootNonce,
    instanceId,
    ...payload,
    ...(meta ? { timing: { ...(payload.timing as Record<string, unknown> | undefined), hostMs: Date.now() - meta.startedAt } } : {}),
  };
  atomicWrite(rpcResultPath(id, false), result);
  requestMeta.delete(String(id));
}

export function writeProtocolError(error: RpcStructuredError, id?: RpcRequestId, bootNonce?: string, instanceId = DEFAULT_INSTANCE_ID): void {
  if (id !== undefined && isValidRpcRequestId(id)) {
    beginRequest({ id, bootNonce: bootNonce ?? 'invalid' });
    writeResult(id, { ok: false, error: error.message, code: error.code, structuredError: error }, instanceId);
    return;
  }
  atomicWrite('rpc-error.json', { protocolVersion: RPC_PROTOCOL_VERSION, ok: false, error });
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
