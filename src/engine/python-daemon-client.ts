// Python daemon 客户端（host 侧，TASK27）：管理常驻 Pyodide 进程的声明周期 + 请求/响应。
// 单例 pythonDaemon 由 host.ts 在 python/pip 命令时懒启动；首次 spawn 会经历
// loadPyodide（~2s）+ 持久化恢复（首次无 manifest 则跳过），后续命令复用实例。
//
// 协议见 python-daemon.ts；这里负责：spawn → 等 READY → 按 id 匹配响应 → 超时杀进程重生。
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { registerProcess } from './host-procs.js';

// python daemon 脚本在容器内的位置（浏览器首用 python/pip 时懒注入 assets 到同一目录）。
// TASK24 双根铁律：浏览器 wc.fs 的 `/` == host 进程 cwd，注入到 `/usr/lib/succinix/python/...`
// 即 host 视角的 `process.cwd()/usr/lib/succinix/python/...`；统一 process.cwd() 拼接。
export const PYTHON_DAEMON_JS = `${process.cwd()}/usr/lib/succinix/python/python-daemon.js`;

export interface DaemonExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  resolve: (r: DaemonExecResult) => void;
}

class PythonDaemonClient {
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  // 懒启动：首次 python/pip 命令时 spawn daemon，等 READY 握手。
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [PYTHON_DAEMON_JS], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        reject(e);
        return;
      }
      this.child = child;
      // The daemon is a real execution-world process. Register it once so
      // `ps`, service status, and host shutdown observe the same lifecycle as
      // Node children; its command pattern is classified as system scope.
      registerProcess(`node ${PYTHON_DAEMON_JS}`, child, process.cwd(), 'default', { runtime: 'python' });
      let sawReady = false;
      const rl = readline.createInterface({ input: child.stdout!, terminal: false });
      this.rl = rl;
      rl.on('line', (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.ready === true) {
          if (!sawReady) {
            sawReady = true;
            resolve();
          }
          return;
        }
        if (msg.ready === false) {
          if (!sawReady) {
            sawReady = true;
            reject(new Error(String(msg.error ?? 'python daemon failed to start')));
          }
          return;
        }
        const id = Number(msg.id);
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve({ exitCode: Number(msg.exitCode ?? -1), stdout: String(msg.stdout ?? ''), stderr: String(msg.stderr ?? '') });
      });
      // daemon 自身的诊断输出（非协议）：只记到内存，避免污染 stdout 协议流。
      child.stderr?.on('data', () => {
        /* 诊断保留给 daemon.log；stdout 是协议通道，不混入 */
      });
      child.on('error', (e) => {
        if (!sawReady) {
          sawReady = true;
          reject(e);
        }
        this.dispose();
      });
      child.on('exit', () => {
        this.dispose();
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.resolve({ exitCode: -1, stdout: '', stderr: 'python daemon exited unexpectedly (runtime reset); retry the command' });
        }
        this.pending.clear();
      });
    });
    return this.ready;
  }

  // 执行一次 python/pip 命令（args 为 daemon 视角的 argv；cwd 为 host 真实路径）。
  // 超时：杀掉卡死的 daemon（下次命令重生），返回超时结果 —— 不假报成功。
  async exec(args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<DaemonExecResult> {
    try {
      await this.start();
    } catch (e) {
      this.dispose();
      return { exitCode: -1, stdout: '', stderr: `python runtime failed to load: ${String(e)}` };
    }
    const id = this.nextId++;
    return new Promise<DaemonExecResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        resolve({ exitCode: -1, stdout: '', stderr: `python command timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, { timer, resolve });
      try {
        this.child?.stdin?.write(JSON.stringify({ id, args, cwd, ...(env ? { env } : {}) }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ exitCode: -1, stdout: '', stderr: `python runtime failed: ${String(e)}` });
      }
    });
  }

  // 显式终止 daemon（host 退出 / 超时恢复）。
  kill(): void {
    const c = this.child;
    if (c) {
      try {
        c.kill();
      } catch {
        /* 句柄失效 */
      }
    }
    this.dispose();
  }

  private dispose(): void {
    this.child = null;
    this.rl = null;
    this.ready = null;
  }
}

export const pythonDaemon = new PythonDaemonClient();
