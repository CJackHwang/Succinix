// TerminalClient 单测（P3-11）：串行队列 / 只读命令重试 / pingDirect 通道判定 / 协议分发。
// 用内存 FS + 可脚本化「假 host」驱动文件 RPC（写 /cmd.json → 写 /result-<id>.json）。
import { describe, it, expect } from 'vitest';
import { TerminalClient, type ExecResult } from '../src/engine/client.js';

interface CmdReq {
  protocol?: number;
  id: number;
  cmd: string;
  opts?: Record<string, unknown>;
}

interface Deferred {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// 假 wc.fs：模拟 host —— 写 /cmd.json 时按响应函数生成 /result-<id>.json（可延迟/挂起）。
function makeRpcFs(opts: {
  respond?: (req: CmdReq) => unknown;
  /** 指定某些 id 的结果挂起（写一个 pending promise，resolve 后才落盘） */
  hangIds?: number[];
}) {
  const files = new Map<string, string>();
  const cmdWrites: CmdReq[] = [];
  const pendingHangs = new Map<number, Deferred>();

  const fs = {
    writeFile: async (path: string, content: string) => {
      if (path === '/cmd.json') {
        const req = JSON.parse(content) as CmdReq;
        cmdWrites.push(req);
        const id = req.id;
        if (opts.hangIds?.includes(id)) {
          const d = deferred();
          pendingHangs.set(id, d);
          d.promise.then((payload) => {
            files.set(`/result-${id}.json`, JSON.stringify({ id, ...(payload as object) }));
          });
          return;
        }
        const payload = opts.respond?.(req);
        // undefined 响应 = host 不写结果（模拟无响应/超时）；否则立即生成结果文件。
        if (payload !== undefined) {
          files.set(`/result-${id}.json`, JSON.stringify({ id, ...(payload as object) }));
        }
        return;
      }
      files.set(path, content);
    },
    readFile: async (path: string) => {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    rm: async (path: string) => {
      files.delete(path);
    },
  };

  return {
    fs,
    files,
    cmdWrites,
    pendingHangs,
  };
}

function makeClient(respond?: (req: CmdReq) => unknown, hangIds?: number[]) {
  const rpc = makeRpcFs({ respond, hangIds });
  const client = new TerminalClient({ fs: rpc.fs } as never);
  return { client, ...rpc };
}

const PONG = () => ({ ok: true, kind: 'pong' });
const RUN_OK = () => ({ ok: true, stdout: 'hi', runtime: 'lifo', exitCode: 0 });

describe('TerminalClient 协议分发', () => {
  it('ps / cwd / ping / exit 直接命中协议命令', async () => {
    const calls: string[] = [];
    const { client } = makeClient((req) => {
      calls.push(req.cmd);
      if (req.cmd === 'ps') return { ok: true, processes: [] };
      return PONG();
    });
    await client.terminal('ps');
    await client.terminal('ping');
    expect(calls).toContain('ps');
    expect(calls).toContain('ping');
  });

  it('kill <pid> → exec(kill, { pid })', async () => {
    const seen: CmdReq[] = [];
    const { client } = makeClient((req: CmdReq) => {
      seen.push(req);
      return { ok: true, killed: true };
    });
    const r = await client.terminal('kill 42');
    expect(seen[0]?.cmd).toBe('kill');
    expect(seen[0]?.opts?.pid).toBe(42);
    expect(r.killed).toBe(true);
  });

  it('普通命令 → exec(run, { command })；spawn → exec(spawn)', async () => {
    const seen: CmdReq[] = [];
    const { client } = makeClient((req) => {
      seen.push(req);
      return RUN_OK();
    });
    await client.terminal('echo hi');
    await client.spawn('node server.js');
    expect(seen[0]?.cmd).toBe('run');
    expect(seen[0]?.opts?.command).toBe('echo hi');
    expect(seen[1]?.cmd).toBe('spawn');
    expect(seen[1]?.opts?.command).toBe('node server.js');
  });

  it('请求带 protocol 版本字段（向后兼容）', async () => {
    const reqs: CmdReq[] = [];
    const { client } = makeClient((r: CmdReq) => {
      reqs.push(r);
      return RUN_OK();
    });
    await client.terminal('echo hi');
    expect(reqs[0]?.protocol).toBe(1);
  });

  it('onCommand 采集条目：命令 / exit / runtime', async () => {
    const entries: Array<{ command: string; exit: number; runtime: string }> = [];
    const { client } = makeClient((req) => (req.cmd === 'run' ? RUN_OK() : { ok: true, processes: [] }));
    (client as unknown as { options: { onCommand?: (e: unknown) => void } }).options.onCommand = (e) =>
      entries.push(e as { command: string; exit: number; runtime: string });
    await client.terminal('echo hi');
    await client.terminal('ps');
    expect(entries.map((e) => e.command)).toEqual(['echo hi', 'ps']);
    expect(entries[0]?.runtime).toBe('lifo');
  });
});

describe('TerminalClient 串行队列', () => {
  it('请求互斥：前一个未 settle 时后一个不写 /cmd.json', async () => {
    const { client, cmdWrites, pendingHangs } = makeClient(
      (req) => (req.cmd === 'run' ? RUN_OK() : { ok: true, kind: 'pong' }),
      [1] // 第一个 run 挂起
    );
    const r1 = client.terminal('run1'); // id=1 挂起（不 await）
    const r2 = client.terminal('run2'); // 排队（不 await）
    // macrotask flush：让 doExec(1) 真正执行并写 /cmd.json（纯微任务不够）
    await new Promise((r) => setTimeout(r, 0));
    expect(cmdWrites.length).toBe(1); // 只有 run1 写了 /cmd.json
    expect(pendingHangs.has(1)).toBe(true);
    // 释放 run1 → run2 接续
    pendingHangs.get(1)?.resolve(RUN_OK());
    const [r1b, r2b] = await Promise.all([r1, r2]);
    expect(r1b.ok).toBe(true);
    expect(r2b.ok).toBe(true);
    expect(cmdWrites.length).toBe(2);
    expect(cmdWrites[1]?.opts?.command).toBe('run2');
  });

  it('单个请求失败不中断链：后续排队请求照常执行', async () => {
    const { client, cmdWrites } = makeClient(
      (req) => (req.opts?.command === 'run bad' ? { ok: false, error: 'boom' } : RUN_OK())
    );
    const r1 = await client.terminal('run bad');
    const r2 = await client.terminal('echo ok');
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(true);
    expect(cmdWrites.length).toBe(2);
  });
});

describe('TerminalClient 只读命令重试', () => {
  it('ping/ps/cwd 传输失败 → 自动重试 1 次', async () => {
    let run = 0;
    const { client, cmdWrites } = makeClient((req) => {
      if (req.cmd === 'ps') {
        run++;
        if (run === 1) return undefined as never; // 首次不写结果 → 超时
        return { ok: true, processes: [] };
      }
      return PONG();
    });
    const r = await client.exec('ps', undefined, 120); // 短超时加速
    expect(r.ok).toBe(true);
    expect(run).toBe(2); // 重试了一次
    expect(cmdWrites.length).toBe(2);
  });

  it('非只读命令（run）传输失败 → 不重试，直接抛错', async () => {
    const { client, cmdWrites } = makeClient(() => undefined as never);
    await expect(client.exec('run', { command: 'x' }, 120)).rejects.toThrow(/timeout/);
    expect(cmdWrites.length).toBe(1); // 没有第二次尝试
  });
});

describe('TerminalClient pingDirect 通道判定', () => {
  it('队列有未开始请求（pending > active）→ 返回 null（通道忙）', async () => {
    const { client, pendingHangs } = makeClient(
      (req) => (req.cmd === 'ping' ? PONG() : RUN_OK()),
      [1]
    );
    const p1 = client.exec('run', { command: 'slow' }); // id=1 挂起，active=1
    await new Promise((r) => setTimeout(r, 0)); // 让 doExec(1) 执行（登记挂起）
    const p2 = client.exec('run', { command: 'queued' }); // pending=2
    await new Promise((r) => setTimeout(r, 0));
    const probe = await client.pingDirect(100);
    expect(probe).toBeNull();
    pendingHangs.get(1)?.resolve(RUN_OK());
    await Promise.all([p1, p2]);
  });

  it('刚写过 /cmd.json（host 读取窗口内）→ 返回 null', async () => {
    const { client } = makeClient(() => RUN_OK());
    await client.exec('run', { command: 'x' });
    const probe = await client.pingDirect(100);
    expect(probe).toBeNull(); // lastCmdWrite 距今 < 250ms
  });

  it('通道空闲且 host 响应 pong → true', async () => {
    const { client } = makeClient((req) => (req.cmd === 'ping' ? PONG() : RUN_OK()));
    await client.exec('run', { command: 'x' });
    await new Promise((r) => setTimeout(r, 300)); // 越过 HOST_POLL_MARGIN_MS
    const probe = await client.pingDirect(200);
    expect(probe).toBe(true);
  });

  it('host 无响应超时 → false', async () => {
    const { client } = makeClient(() => undefined as never);
    await new Promise((r) => setTimeout(r, 300)); // 清空 margin
    const probe = await client.pingDirect(120);
    expect(probe).toBe(false);
  });

  it('FS 不可写 → false（按 host 不可达处理）', async () => {
    const { client } = makeClient(() => PONG());
    // 构造：写入 /cmd.json 抛错
    const fs = {
      writeFile: async () => {
        throw new Error('fs down');
      },
    };
    const c2 = new TerminalClient({ fs } as never);
    const probe = await c2.pingDirect(100);
    expect(probe).toBe(false);
    // 原 client 未受影响（上一个测试已消费 margin）
    void client;
  });
});

describe('TerminalClient 结果文件清理', () => {
  it('读到即删：结果文件被移除', async () => {
    const rpc = makeRpcFs({ respond: (req) => (req.cmd === 'ping' ? PONG() : RUN_OK()) });
    const client = new TerminalClient({ fs: rpc.fs } as never);
    await client.exec('run', { command: 'x' });
    // 结果文件应已被 rm（残留为空）
    let resultFiles = 0;
    for (const [k] of rpc.files) {
      if (k.startsWith('/result-')) resultFiles++;
    }
    expect(resultFiles).toBe(0);
  });
});

describe('TerminalClient interruptDirect（P5-15 Ctrl+C 中断）', () => {
  it('绕过队列直接发 interrupt；host 返回 pid 时即已向该进程发 kill', async () => {
    const seen: CmdReq[] = [];
    const { client } = makeClient((req) => {
      seen.push(req);
      if (req.cmd === 'interrupt') return { ok: true, kind: 'interrupted', pid: 7 };
      return RUN_OK();
    });
    await new Promise((r) => setTimeout(r, 300)); // 清空 lastCmdWrite margin
    const res = await client.interruptDirect(200);
    expect(res?.pid).toBe(7);
    expect(seen[0]?.cmd).toBe('interrupt'); // 直接命中，未走 run 分发
  });

  it('无当前 run → pid 为 null', async () => {
    const { client } = makeClient((req) => (req.cmd === 'interrupt' ? { ok: true, kind: 'interrupted', pid: null } : RUN_OK()));
    await new Promise((r) => setTimeout(r, 300));
    const res = await client.interruptDirect(200);
    expect(res?.kind).toBe('interrupted');
    expect(res?.pid).toBeNull();
  });

  it('队列有未开始请求 → 返回 null（中断会被吞，跳过）', async () => {
    const { client, pendingHangs } = makeClient(
      (req) => (req.cmd === 'interrupt' ? { ok: true, kind: 'interrupted', pid: 1 } : RUN_OK()),
      [1]
    );
    const p1 = client.exec('run', { command: 'slow' }); // 挂起，active=1
    await new Promise((r) => setTimeout(r, 0));
    const p2 = client.exec('run', { command: 'queued' }); // pending=2
    await new Promise((r) => setTimeout(r, 0));
    const res = await client.interruptDirect(100);
    expect(res).toBeNull(); // pending(2) > active(1)
    pendingHangs.get(1)?.resolve(RUN_OK());
    await Promise.all([p1, p2]);
  });

  it('host 无响应（超时）→ 返回 null', async () => {
    const { client } = makeClient(() => undefined as never);
    await new Promise((r) => setTimeout(r, 300)); // 清空 margin
    const res = await client.interruptDirect(120);
    expect(res).toBeNull();
  });
});

describe('TerminalClient 类型契约', () => {
  it('ExecResult 带 stdout/stderr/runtime', async () => {
    const { client } = makeClient((req) => (req.cmd === 'run' ? { ok: true, stdout: 'a', stderr: 'b', runtime: 'node', exitCode: 0 } : { ok: true }));
    const r = (await client.terminal('node x.js')) as ExecResult;
    expect(r.stdout).toBe('a');
    expect(r.runtime).toBe('node');
  });
});
