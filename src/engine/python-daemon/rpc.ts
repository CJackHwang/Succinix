// 文件 RPC 请求链 + 响应序列化（O7 拆分自 python-daemon.ts）。
// 职责：stdin 命令排队（host 侧单槽串行，防御式排队保证按序处理）、stdout JSON 响应、
// 错误格式化与缺模块 hint。
import { outBuf, errBuf, PY_EXEC_TIMEOUT_MS } from './loader.js';

export interface PydRequest {
  id: number;
  args: string[];
  cwd?: string;
}

// ─── 文件 RPC 请求链（host 侧单槽串行，防御式排队保证按序处理）───
let reqChain: Promise<unknown> = Promise.resolve();
export function enqueue(req: PydRequest, handle: (r: PydRequest) => Promise<{ code: number }>): void {
  reqChain = reqChain.then(async () => {
    const res = await Promise.race([
      handle(req),
      new Promise<{ code: number }>((_, reject) => {
        setTimeout(() => reject(new Error('python command timed out')), PY_EXEC_TIMEOUT_MS);
      }),
    ]);
    send({ id: req.id, code: res.code });
  });
}
export function send(resp: { id: number; code: number }): void {
  process.stdout.write(JSON.stringify({ id: resp.id, exitCode: resp.code, stdout: outBuf, stderr: errBuf }) + '\n');
}

// ─── 工具 ───
export function formatError(e: unknown): string {
  if (e instanceof Error) return e.message.split('\n').slice(0, 20).join('\n');
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
// 缺模块错误 → 追加可操作 hint（TASK27 复审项 3）。冷启动边界：C 扩展包（numpy 等）的
// .so 二进制不随文本快照持久，刷新后被启动清理移除，再次 import 报缺包 —— 保持如实报错
// （不吞原始错误），仅提示指向 `pip install <pkg>` 解决路径（Pyodide 固有约束，不强行自动重装）。
const NO_MODULE_RE = /No module named '([^']+)'|Cannot load package '([^']+)'|loadPackage\('([^']+)'\)/;
export function appendInstallHint(errMsg: string): string {
  const m = NO_MODULE_RE.exec(errMsg);
  const pkg = m ? (m[1] ?? m[2] ?? m[3]) : '';
  if (!pkg) return errMsg;
  return `${errMsg}\nhint: install it with: pip install ${pkg}`;
}
