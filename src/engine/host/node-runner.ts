import { tryTokenize } from '../tokenize.js';
import { mapDataDirArgs } from '../host-route.js';
import { spawnChild } from './spawn.js';
import { writeResult } from './rpc.js';
import type { RpcRequestId } from '../rpc-v2.js';

/** 将已分词的 Node 系命令分派给真实 WebContainer 子进程。 */
export async function runNode(command: string, opts: Record<string, unknown> | undefined, reqId: RpcRequestId, instanceId: string): Promise<void> {
  const t = tryTokenize(command);
  if (!t.ok) {
    writeResult(reqId, { ok: false, exitCode: -1, stdout: '', stderr: t.error, runtime: 'node' }, instanceId);
    return;
  }
  // M5：绝对路径数据目录参数（tinbase --data-dir）按浏览器视角映射到 host 真实根。
  const [prog, ...args] = mapDataDirArgs(t.tokens, process.cwd());
  await spawnChild(prog, args, opts, reqId, 'node', instanceId);
}
